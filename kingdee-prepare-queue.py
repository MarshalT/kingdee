#!/usr/bin/env python3
"""金蝶采购录单：按「订单号+供应商」分单，并生成面板粘贴用的 clipserve 复制页。

人工用法示例：
  python3 kingdee-prepare-queue.py /workspace/6月订单.xlsx
  python3 kingdee-prepare-queue.py 订单.xlsx --out-dir /tmp/clipserve --queue /tmp/queue.json
  python3 kingdee-prepare-queue.py 订单.xlsx --serve          # 生成后起 8766 服务
  python3 kingdee-prepare-queue.py 订单.xlsx --from CGDD252607  # 从该订单号起（含）

Excel 列约定（表头名）：
  日期 / 订单号 / 名称 / 型号 / 数量 / 单位 / 单价（供应商）/ 供应商名称
  商品编码：订单号右侧那一列（表头可为空）

硬规则：同一订单号、不同供应商 → 多张单，绝不按订单号合并。
"""
from __future__ import annotations

import argparse
import difflib
import html
import json
import re
import sys
import urllib.parse
import zipfile
import xml.etree.ElementTree as ET
import unicodedata
from datetime import date, datetime
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("需要 openpyxl：pip install openpyxl", file=sys.stderr)
    sys.exit(1)


def _cell(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, str):
        return v.strip()
    return v


def _normalize_supplier(value):
    """将淘宝相关供应商统一为金蝶中使用的零星供应商名称。"""
    supplier = str(value).strip() if value is not None else ""
    return "零星供应商（淘宝）" if "淘宝" in supplier else supplier


def _num(v, default=None):
    if v is None or v == "":
        return default
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "")
    if not s or s.upper() == "#N/A":
        return default
    try:
        return float(s)
    except ValueError:
        return default


def _is_freight(name, code) -> bool:
    n = (name or "").strip()
    c = (code or "").strip().upper()
    return n == "运费" or (c in ("", "#N/A", "N/A") and "运费" in n)


def load_header_map(header_row):
    """返回 name->index；商品编码取「订单号」右侧一列。"""
    idx = {}
    for i, h in enumerate(header_row):
        if h is None:
            continue
        name = str(h).strip()
        if name:
            idx[name] = i
    if "订单号" not in idx:
        raise SystemExit("表头缺少「订单号」列")
    code_i = idx["订单号"] + 1
    idx["_商品编码"] = code_i
    need = ["日期", "订单号", "名称", "数量", "单位", "单价（供应商）", "供应商名称", "供应商结算价格", "单价（精实）", "总价（精实）", "精实价格总计"]
    miss = [n for n in need if n not in idx]
    if miss:
        raise SystemExit(f"表头缺少列: {', '.join(miss)}")
    return idx


def read_excel(path: Path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = ws.iter_rows(values_only=True)
    header = next(rows)
    idx = load_header_map(header)
    out = []
    for row in rows:
        if not row or all(c is None or str(c).strip() == "" for c in row):
            continue
        order_no = _cell(row[idx["订单号"]])
        # 分单前保留 Excel 原始供应商名称；归一化在分组完成后进行，避免提前合并不同供应商。
        supplier = _cell(row[idx["供应商名称"]])
        if not order_no or not supplier:
            continue
        code = _cell(row[idx["_商品编码"]])
        name = _cell(row[idx["名称"]])
        spec = _cell(row[idx["型号"]]) if "型号" in idx else None
        qty = _num(row[idx["数量"]])
        unit = _cell(row[idx["单位"]]) or ""
        price = _num(row[idx["单价（供应商）"]])
        settlement_price = _num(row[idx["供应商结算价格"]])
        sales_price = _num(row[idx["单价（精实）"]])
        sales_line_total = _num(row[idx["总价（精实）"]])
        sales_total = _num(row[idx["精实价格总计"]])
        d = _cell(row[idx["日期"]])
        if qty is None or price is None:
            continue
        if _is_freight(name, code):
            code = "运费"  # 编码页里用「运费」便于面板粘贴后查找
        elif not code or str(code).upper() in ("#N/A", "N/A"):
            code = ""
        out.append(
            {
                "orderNo": str(order_no),
                "supplier": str(supplier),
                "date": d,
                "code": str(code) if code is not None else "",
                "name": name or "",
                "spec": spec or "",
                "qty": qty,
                "unit": str(unit),
                "price": round(price, 5),
                "settlementPrice": settlement_price,
                "salesPrice": round(sales_price, 5) if sales_price is not None else None,
                "salesLineTotal": sales_line_total,
                "salesTotal": sales_total,
            }
        )
    wb.close()
    return out


def read_supplier_names(path: Path):
    """读取金蝶供应商导出表中的供应商名称列。"""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    names = set()
    for ws in wb.worksheets:
        rows = ws.iter_rows(values_only=True)
        for header in rows:
            columns = {str(value).strip(): i for i, value in enumerate(header) if value is not None}
            if "供应商名称" in columns:
                name_i = columns["供应商名称"]
                names.update(str(value).strip() for row in rows if len(row) > name_i
                             if (value := _cell(row[name_i])) is not None and str(value).strip())
                break
    wb.close()
    # 金蝶导出表使用 inlineStr；部分 openpyxl 版本会把这类表误读成只有 A1。
    # 若工作表 API 未返回数据，直接读取 XLSX XML 并按表头名取列。
    if not names:
        ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        with zipfile.ZipFile(path) as archive:
            shared = []
            if "xl/sharedStrings.xml" in archive.namelist():
                strings_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
                shared = ["".join(t.text or "" for t in item.findall(".//m:t", ns))
                          for item in strings_root.findall("m:si", ns)]
            for filename in archive.namelist():
                if not re.fullmatch(r"xl/worksheets/sheet\d+\.xml", filename):
                    continue
                root = ET.fromstring(archive.read(filename))
                xml_rows = root.findall(".//m:sheetData/m:row", ns)
                for row_index, row in enumerate(xml_rows):
                    values = {}
                    for cell in row.findall("m:c", ns):
                        ref = cell.attrib.get("r", "")
                        col = re.match(r"[A-Z]+", ref)
                        if not col:
                            continue
                        inline = cell.find("m:is", ns)
                        value = "".join(t.text or "" for t in inline.findall(".//m:t", ns)) if inline is not None else ""
                        raw = cell.find("m:v", ns)
                        if not value and raw is not None:
                            value = raw.text or ""
                            if cell.attrib.get("t") == "s" and value:
                                value = shared[int(value)]
                        values[col.group()] = value.strip()
                    header_col = next((col for col, value in values.items() if value == "供应商名称"), None)
                    if header_col:
                        for data_row in xml_rows[row_index + 1:]:
                            for cell in data_row.findall("m:c", ns):
                                if re.match(r"[A-Z]+", cell.attrib.get("r", "")).group() != header_col:
                                    continue
                                inline = cell.find("m:is", ns)
                                value = "".join(t.text or "" for t in inline.findall(".//m:t", ns)) if inline is not None else ""
                                raw = cell.find("m:v", ns)
                                if not value and raw is not None:
                                    value = raw.text or ""
                                    if cell.attrib.get("t") == "s" and value:
                                        value = shared[int(value)]
                                if value.strip():
                                    names.add(value.strip())
                        break
                if names:
                    break
    if not names:
        raise SystemExit(f"供应商表缺少「供应商名称」列或该列没有数据：{path}")
    return names


def find_unmatched_suppliers(orders, supplier_names):
    """分单后规范化名称，并把可信相似匹配直接写回订单分组。"""
    def normalize(value):
        value = unicodedata.normalize("NFKC", str(value or "")).casefold()
        return "".join(char for char in value if char.isalnum())

    exact_by_normalized = {}
    for name in supplier_names:
        exact_by_normalized.setdefault(normalize(name), []).append(name)

    results = []
    for order in orders:
        supplier = str(order.get("supplier") or "").strip()
        previous_match = order.get("supplierMatch")
        if isinstance(previous_match, dict) and previous_match.get("source"):
            source_supplier = str(previous_match["source"]).strip()
            results.append({
                "orderNo": order.get("orderNo", ""),
                "supplier": source_supplier,
                "status": previous_match.get("method", "manual"),
                "matchedName": previous_match.get("matchedName", ""),
                "topScore": previous_match.get("similarity", 0.0),
                "candidates": [],
            })
            continue
        if supplier in supplier_names:
            continue
        normalized = normalize(supplier)
        normalized_matches = exact_by_normalized.get(normalized, [])
        candidates = sorted(
            ((difflib.SequenceMatcher(None, normalized, normalize(name)).ratio(), name)
             for name in supplier_names if normalize(name)),
            reverse=True,
        )[:5]
        top_score, top_name = candidates[0] if candidates else (0.0, "")
        second_score = candidates[1][0] if len(candidates) > 1 else 0.0
        # 业务别名：嘉立创在原始订单中常以个人/店铺名称出现，统一映射到金蝶主体。
        jlc_matches = [name for name in supplier_names if "嘉立创" in name and "深圳" in name]
        if "嘉立创" in supplier and len(jlc_matches) == 1:
            status, matched_name = "alias-auto", jlc_matches[0]
        elif len(normalized_matches) == 1:
            status, matched_name = "normalized", normalized_matches[0]
        elif top_score > 0.80:
            status, matched_name = "fuzzy-auto", top_name
        else:
            status, matched_name = "manual", ""
        if matched_name:
            order["supplier"] = matched_name
            order["supplierMatch"] = {
                "source": supplier,
                "matchedName": matched_name,
                "method": status,
                "similarity": 1.0 if status in ("normalized", "alias-auto") else top_score,
            }
        results.append({
            "orderNo": order.get("orderNo", ""),
            "supplier": supplier,
            "status": status,
            "matchedName": matched_name,
            "topScore": top_score,
            "candidates": candidates,
        })
    return results


def split_orders(rows):
    """按 (订单号, 供应商) 保序分组。"""
    groups = []
    key_to_i = {}
    for r in rows:
        key = (r["orderNo"], r["supplier"])
        if key not in key_to_i:
            key_to_i[key] = len(groups)
            groups.append(
                {
                    "orderNo": r["orderNo"],
                    "supplier": _normalize_supplier(r["supplier"]),
                    "date": r["date"],
                    "settlementPrice": r["settlementPrice"],
                    "salesTotal": r["salesTotal"],
                    "salesLineTotal": r["salesLineTotal"],
                    "lines": [],
                }
            )
        g = groups[key_to_i[key]]
        if not g["date"] and r["date"]:
            g["date"] = r["date"]
        if g["settlementPrice"] is None and r["settlementPrice"] is not None:
            g["settlementPrice"] = r["settlementPrice"]
        if g["salesTotal"] is None and r["salesTotal"] is not None:
            g["salesTotal"] = r["salesTotal"]
        if g["salesLineTotal"] is None and r["salesLineTotal"] is not None:
            g["salesLineTotal"] = r["salesLineTotal"]
        g["lines"].append(
            {
                "code": r["code"],
                "name": r["name"],
                "spec": r["spec"],
                "qty": r["qty"],
                "unit": r["unit"],
                "price": r["price"],
                "settlementPrice": r["settlementPrice"],
                "salesPrice": r["salesPrice"],
                "salesLineTotal": r["salesLineTotal"],
            }
        )
    for g in groups:
        total = sum(l["qty"] * l["price"] for l in g["lines"])
        g["expectedTotal"] = round(total + 1e-9, 2)
        g["settlementTotal"] = round(sum(l["qty"] * (l["settlementPrice"] or 0) for l in g["lines"]) + 1e-9, 2)
        g.setdefault("salesTotal", None)
        g["salesLineTotal"] = round(sum(l["salesLineTotal"] or 0 for l in g["lines"]) + 1e-9, 2)
    return groups


def html_copy_page(title: str, body: str) -> str:
    # 与既有 paste-255300.html 同结构：pre + copy 按钮写系统剪贴板
    safe = body.replace("</", "<\\/")
    return (
        "<!DOCTYPE html><html><head><meta charset=utf-8>"
        f"<title>{title}</title></head><body>\n"
        f"<pre id=t>{safe}</pre>\n"
        "<button id=c>copy</button>\n"
        "<script>\n"
        "document.getElementById('c').onclick=async()=>{\n"
        "  const t=document.getElementById('t').innerText;\n"
        "  await navigator.clipboard.writeText(t);\n"
        "  document.title='copied:'+t.split(/\\n/).filter(Boolean).length;\n"
        "};\n"
        "</script></body></html>\n"
    )


def html_combined_page(title: str, paste_body: str, codes_body: str, next_url: str | None) -> str:
    # 合并页：同时查看价量和编码，分别复制，并可切换下一单
    import json as _json
    paste_json = _json.dumps(paste_body, ensure_ascii=False)
    codes_json = _json.dumps(codes_body, ensure_ascii=False)
    next_html = f"<a href=\"{next_url}\">下一单 →</a>" if next_url else "<span>已经是最后一单</span>"
    return f"""<!DOCTYPE html><html><head><meta charset=utf-8><title>{title}</title>
<style>body{{font-family:Arial,sans-serif;margin:24px}} .cols{{display:flex;gap:32px;align-items:flex-start}} .box{{flex:1}} pre{{border:1px solid #ccc;padding:12px;min-height:120px;white-space:pre-wrap}} button,a{{font-size:18px;margin-right:12px}} a{{display:inline-block;margin-top:24px}}</style></head><body>
<h1>{title}</h1><div class=cols><section class=box><h2>价量</h2><pre id=p></pre><button onclick=copyText('p')>复制价量</button></section><section class=box><h2>编码</h2><pre id=c></pre><button onclick=copyText('c')>复制编码</button></section></div><div>{next_html}</div>
<script>const P={paste_json}, C={codes_json}; document.getElementById('p').innerText=P; document.getElementById('c').innerText=C; async function copyText(id){{await navigator.clipboard.writeText(document.getElementById(id).innerText);}}</script></body></html>
"""


def write_clip_pages(orders, out_dir: Path, index_base: int = 0, unmatched_suppliers=None):
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for i, o in enumerate(orders):
        idx = index_base + i
        # 价量：数量 \\t 单位 \\t 单价（面板忽略单位列）
        paste_lines = []
        code_lines = []
        for l in o["lines"]:
            # 价格尽量保留原精度，整数写整
            p = l["price"]
            p_s = str(int(p)) if float(p).is_integer() else repr(p) if False else (
                ("%g" % p) if abs(p) >= 0.01 else ("%.15g" % p)
            )
            # 用足够精度：与 Excel 浮点一致时用完整 float 字符串
            p_s = format(p, ".15g")
            paste_lines.append(f"{format(l['qty'], '.15g')}\t{l['unit']}\t{p_s}")
            code = l["code"] or ""
            code_lines.append(code)
        stem = f"{o['orderNo']}-{idx}"
        paste_name = f"paste-{stem}.html"
        codes_name = f"codes-{stem}.html"
        combined_name = f"order-{stem}.html"
        (out_dir / paste_name).write_text(
            html_copy_page(f"paste {o['orderNo']}", "\n".join(paste_lines)),
            encoding="utf-8",
        )
        (out_dir / codes_name).write_text(
            html_copy_page(f"codes {o['orderNo']}", "\n".join(code_lines)),
            encoding="utf-8",
        )
        o["clipIndex"] = idx
        o["combinedName"] = combined_name
        o["combinedUrl"] = f"http://127.0.0.1:8766/{combined_name}"
        written.append((paste_name, codes_name, combined_name))
        o["pasteUrl"] = f"http://127.0.0.1:8766/{paste_name}"
        o["codesUrl"] = f"http://127.0.0.1:8766/{codes_name}"
        # 合并页在所有订单链接确定后再写入，以便知道下一单
    for i, o in enumerate(orders):
        next_url = orders[i + 1].get("combinedUrl") if i + 1 < len(orders) else None
        paste_body = "\n".join(f"{format(l['qty'], '.15g')}\t{l['unit']}\t{format(l['price'], '.15g')}" for l in o["lines"])
        codes_body = "\n".join(l["code"] or "" for l in o["lines"])
        (out_dir / o["combinedName"]).write_text(html_combined_page(f"{o['orderNo']} · {o['supplier']} · 预期 {o['expectedTotal']} · 供应商结算价格 {o.get('settlementPrice') if o.get('settlementPrice') is not None else '—'}", paste_body, codes_body, next_url), encoding="utf-8")
    # 索引页方便人工点选
    links = [
        "<!DOCTYPE html><meta charset=utf-8><title>clipserve index</title>",
        "<style>body{font-family:Arial,sans-serif;margin:24px} .page-title{display:flex;align-items:center;gap:24px} .page-title h1{margin:0} .audit-link{font-size:20px;padding:10px 16px;border:1px solid #1677ff;border-radius:8px;background:#eef6ff;text-decoration:none} li{margin:8px 0}</style>",
        "<div class='page-title'><h1>录单复制页</h1><a class='audit-link' href='price-differences.html'>价格差异清单</a><a class='audit-link' href='empty-codes.html'>商品编码为空</a><a class='audit-link' href='unmatched-suppliers.html'>供应商未匹配</a></div><ol>",
    ]
    for o in orders:
        links.append(
            f"<li><b>{o['orderNo']}</b> · {o['supplier']} · 预期 {o['expectedTotal']} · 供应商结算价格 {o.get('settlementPrice') if o.get('settlementPrice') is not None else '—'} · "
            f"<a href='paste-{o['orderNo']}-{o['clipIndex']}.html'>价量</a> · "
            f"<a href='codes-{o['orderNo']}-{o['clipIndex']}.html'>编码</a> · "
            f"<a href='order-{o['orderNo']}-{o['clipIndex']}.html'>合并操作页</a></li>"
        )
    links.append("</ol>")
    (out_dir / "index.html").write_text("\n".join(links), encoding="utf-8")

    # 差异按币种精度（分）判断，页面同时列出实际差额。
    audit = [
        "<!DOCTYPE html><html><head><meta charset='utf-8'><title>价格差异清单</title>",
        "<style>body{font-family:Arial,sans-serif;margin:24px;color:#222}a{color:#1677ff}h1{margin-bottom:8px}.hint{color:#666;margin:0 0 20px}table{border-collapse:collapse;width:100%;margin:16px 0 28px}th,td{border:1px solid #ddd;padding:9px 12px;text-align:left}th{background:#f4f6f8}td.num{text-align:right;font-variant-numeric:tabular-nums}.diff{color:#c62828;font-weight:bold}.empty{padding:12px;color:#388e3c;background:#f1f8e9}</style></head><body>",
        "<p><a href='index.html'>← 返回录单复制页</a></p><h1>价格差异清单</h1><p class='hint'>按金额保留两位小数比较；差额 = 表格价格 − 预期。</p>",
    ]

    def add_audit_table(title, expected_key, actual_key, expected_label, actual_label):
        mismatches = []
        for order in orders:
            expected = order.get(expected_key)
            actual = order.get(actual_key)
            if expected is None or actual is None:
                continue
            expected_cents = round(float(expected) * 100)
            actual_cents = round(float(actual) * 100)
            if expected_cents != actual_cents:
                mismatches.append((order, expected_cents, actual_cents))
        audit.append(f"<h2>{title}（{len(mismatches)} 单）</h2>")
        if not mismatches:
            audit.append("<div class='empty'>没有发现价格差异。</div>")
            return
        audit.append(f"<table><thead><tr><th>订单号</th><th>供应商</th><th>{expected_label}</th><th>{actual_label}</th><th>差额（表格价格 − 预期）</th></tr></thead><tbody>")
        for order, expected_cents, actual_cents in mismatches:
            diff_cents = actual_cents - expected_cents
            audit.append(
                f"<tr><td>{order['orderNo']}</td><td>{order['supplier']}</td>"
                f"<td class='num'>{expected_cents / 100:.2f}</td><td class='num'>{actual_cents / 100:.2f}</td>"
                f"<td class='num diff'>{diff_cents / 100:+.2f}</td></tr>"
            )
        audit.append("</tbody></table>")

    add_audit_table("采购订单", "expectedTotal", "settlementPrice", "预期", "供应商结算价格")
    add_audit_table("销售订单", "salesLineTotal", "salesTotal", "总价（精实）合计", "精实价格总计")
    audit.append("</body></html>")
    (out_dir / "price-differences.html").write_text("\n".join(audit), encoding="utf-8")

    empty_codes = [
        "<!DOCTYPE html><html><head><meta charset='utf-8'><title>商品编码为空</title>",
        "<style>body{font-family:Arial,sans-serif;margin:24px;color:#222}a{color:#1677ff}h1{margin-bottom:8px}.hint{color:#666;margin:0 0 20px}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #ddd;padding:9px 12px;text-align:left}th{background:#fff3e0}.num{text-align:center}.empty{padding:12px;color:#388e3c;background:#f1f8e9}</style></head><body>",
        "<p><a href='index.html'>← 返回录单复制页</a></p><h1>商品编码为空</h1><p class='hint'>以下商品行的商品编码为空，建议补充编码后再填充订单。</p>",
    ]
    empty_rows = []
    for order in orders:
        for line_no, line in enumerate(order.get("lines", []), 1):
            if not str(line.get("code") or "").strip():
                empty_rows.append((order, line_no, line))
    if not empty_rows:
        empty_codes.append("<div class='empty'>没有发现商品编码为空的商品行。</div>")
    else:
        empty_codes.append("<table><thead><tr><th>订单号</th><th>供应商</th><th class='num'>行号</th><th>商品名称</th><th>型号</th><th>数量</th><th>单价</th></tr></thead><tbody>")
        for order, line_no, line in empty_rows:
            empty_codes.append(
                f"<tr><td>{order['orderNo']}</td><td>{order['supplier']}</td><td class='num'>{line_no}</td>"
                f"<td>{line.get('name', '')}</td><td>{line.get('spec', '')}</td>"
                f"<td class='num'>{line.get('qty', '')}</td><td class='num'>{line.get('price', '')}</td></tr>"
            )
        empty_codes.append("</tbody></table>")
    empty_codes.append("</body></html>")
    (out_dir / "empty-codes.html").write_text("\n".join(empty_codes), encoding="utf-8")

    unmatched_suppliers = unmatched_suppliers or []
    fuzzy_auto = [item for item in unmatched_suppliers if item["status"] != "manual"]
    manual_suppliers = [item for item in unmatched_suppliers if item["status"] == "manual"]
    missing = [
        "<!DOCTYPE html><html><head><meta charset='utf-8'><title>供应商未匹配</title>",
        "<style>body{font-family:Arial,sans-serif;margin:24px;color:#222}a{color:#1677ff}h1{margin-bottom:8px}.hint{color:#666;margin:0 0 20px}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #ddd;padding:9px 12px;text-align:left}th{background:#fff3e0}.empty{padding:12px;color:#388e3c;background:#f1f8e9}.auto{color:#237804}.manual{color:#ad4e00}.num{text-align:right;font-variant-numeric:tabular-nums}</style></head><body>",
        "<p><a href='index.html'>← 返回录单复制页</a></p><h1>供应商未匹配</h1>",
        f"<p class='hint'>分单后先规范化匹配；嘉立创按业务规则映射到深圳嘉立创科技集团股份有限公司，其他名称最高相似度超过 80% 时直接更新分单与队列名称。自动匹配 {len(fuzzy_auto)} 单，待人工确认 {len(manual_suppliers)} 单。</p>",
    ]
    if not unmatched_suppliers:
        missing.append("<div class='empty'>所有分单的供应商名称均在供应商表中找到。</div>")
    else:
        def append_supplier_table(title, items, automatic):
            missing.append(f"<h2>{title}（{len(items)} 单）</h2>")
            if not items:
                missing.append("<div class='empty'>没有记录。</div>")
                return
            missing.append("<table><thead><tr><th>订单号</th><th>原供应商名称</th><th>当前分单/队列名称</th><th>匹配方式</th><th>相似度</th><th>其他候选（前5）</th></tr></thead><tbody>")
            for item in items:
                suggestions = "<br>".join(f"{html.escape(name)}（{score:.1%}）" for score, name in item["candidates"])
                matched = html.escape(item["matchedName"]) if automatic else "请人工确认"
                score = "100.0%（规范化/别名）" if item["status"] in ("normalized", "alias-auto") else f"{item['topScore']:.1%}"
                method = {"normalized": "格式规范化", "alias-auto": "业务别名", "fuzzy-auto": "相似度自动匹配"}.get(item["status"], "待人工确认")
                cls = "auto" if automatic else "manual"
                missing.append(
                    f"<tr><td>{html.escape(str(item['orderNo']))}</td><td>{html.escape(item['supplier'])}</td>"
                    f"<td class='{cls}'>{matched}</td><td>{method}</td><td class='num'>{score}</td><td>{suggestions}</td></tr>"
                )
            missing.append("</tbody></table>")
        append_supplier_table("可自动匹配（建议）", fuzzy_auto, True)
        append_supplier_table("待人工确认", manual_suppliers, False)
    missing.append("</body></html>")
    (out_dir / "unmatched-suppliers.html").write_text("\n".join(missing), encoding="utf-8")
    return written


def filter_from(orders, from_order: str | None):
    if not from_order:
        return orders
    for i, o in enumerate(orders):
        if o["orderNo"] == from_order:
            return orders[i:]
    raise SystemExit(f"队列中找不到订单号 {from_order}")


def serve(out_dir: Path, port: int, queue_file: Path):
    control = {"pending": None, "results": {}, "next_id": 1}
    allowed_actions = {"status", "load-orders", "next-order", "previous-order", "switch-type", "fill-codes", "paste-codes", "paste-quantity-price", "paste-price", "smart-fill", "repair", "check-amount", "clear", "refresh", "audit", "new-order", "auto-run", "auto-stop"}
    class Handler(SimpleHTTPRequestHandler):
        def do_GET(self):
            if self.path.split("?", 1)[0] == "/api/jdy/command":
                payload = json.dumps(control["pending"] or {}, ensure_ascii=False).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload))); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(payload); return
            if self.path.split("?", 1)[0] == "/api/jdy/result":
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                result_id = query.get("id", [None])[0]
                payload = json.dumps(control["results"].get(str(result_id), {}) if result_id else (next(reversed(control["results"].values()), {}) if control["results"] else {}), ensure_ascii=False).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload))); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(payload); return
            if self.path.split("?", 1)[0] == "/api/orders":
                try:
                    payload = queue_file.read_bytes()
                except OSError as exc:
                    self.send_error(500, f"无法读取订单队列: {exc}")
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(payload)
                return
            super().do_GET()

        def do_POST(self):
            path = self.path.split("?", 1)[0]
            if path in ("/api/jdy/command", "/api/jdy/result"):
                length = int(self.headers.get("Content-Length", "0"))
                try: body = json.loads(self.rfile.read(length) or b"{}")
                except json.JSONDecodeError: self.send_error(400, "JSON格式错误"); return
                if path.endswith("/command"):
                    if not isinstance(body, dict) or body.get("action") not in allowed_actions:
                        self.send_error(400, "不支持的控制动作"); return
                    body["id"] = control["next_id"]; control["next_id"] += 1; control["pending"] = body
                    response = {"accepted": True, "id": body["id"]}
                else:
                    result_id = str(body.get("id", ""))
                    if result_id:
                        control["results"][result_id] = body
                        if control["pending"] and str(control["pending"].get("id")) == result_id:
                            control["pending"] = None
                    response = {"ok": True}
                payload = json.dumps(response, ensure_ascii=False).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("Content-Length", str(len(payload))); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(payload); return
            self.send_error(404)

        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(out_dir), **k)

        def log_message(self, fmt, *args):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"clipserve: http://127.0.0.1:{port}/  (目录 {out_dir})")
    print("首页: http://127.0.0.1:%d/index.html" % port)
    print(f"订单接口: http://127.0.0.1:{port}/api/orders")
    print(f"AI控制接口: POST http://127.0.0.1:{port}/api/jdy/command  (例如 {{\"action\":\"next-order\"}})")
    print("Ctrl+C 停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停")


def main():
    ap = argparse.ArgumentParser(description="金蝶采购：分单 + 生成面板粘贴复制页")
    ap.add_argument("excel", type=Path, help="订单 Excel，如 6月订单.xlsx")
    ap.add_argument(
        "--queue",
        type=Path,
        default=Path("/workspace/kingdee-remaining-queue.json"),
        help="输出队列 JSON 路径",
    )
    ap.add_argument(
        "--manifest",
        type=Path,
        default=Path("/workspace/kingdee-rerun-manifest.json"),
        help="完整分单清单 JSON（含全部，不受 --from 截断）",
    )
    ap.add_argument(
        "--out-dir",
        type=Path,
        default=Path("/tmp/clipserve"),
        help="paste/codes html 输出目录",
    )
    ap.add_argument(
        "--suppliers",
        type=Path,
        default=Path("/Users/tangjianhong/脚本/kingdee/引出列表_供应商_20261102110005.xlsx"),
        help="金蝶供应商导出表（需包含「供应商名称」列）",
    )
    ap.add_argument("--from", dest="from_order", default=None, help="从该订单号起写入队列（含）")
    ap.add_argument("--port", type=int, default=8766, help="--serve 时端口")
    ap.add_argument("--serve", action="store_true", help="生成后启动本地 http 服务")
    ap.add_argument("--no-html", action="store_true", help="只写 JSON，不生成 html")
    args = ap.parse_args()

    if not args.excel.exists():
        raise SystemExit(f"找不到 Excel: {args.excel}")

    rows = read_excel(args.excel)
    all_orders = split_orders(rows)
    if not args.suppliers.exists():
        raise SystemExit(f"找不到供应商导出表: {args.suppliers}（可通过 --suppliers 指定路径）")
    supplier_names = read_supplier_names(args.suppliers)
    unmatched_suppliers = find_unmatched_suppliers(all_orders, supplier_names)
    auto_supplier_matches = sum(item["status"] != "manual" for item in unmatched_suppliers)
    manual_supplier_matches = sum(item["status"] == "manual" for item in unmatched_suppliers)
    print(f"供应商核对：{len(all_orders) - manual_supplier_matches}/{len(all_orders)} 单匹配（含自动更新），自动匹配 {auto_supplier_matches} 单，{manual_supplier_matches} 单待人工确认 → {args.out_dir / 'unmatched-suppliers.html'}")
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(
        json.dumps(all_orders, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"完整分单 {len(all_orders)} 条 → {args.manifest}")

    queue = filter_from(all_orders, args.from_order)
    # 深拷贝再写 clip 字段，避免污染 manifest 再读；这里直接用 queue 写 html
    if not args.no_html:
        # clip 序号用在完整清单中的下标，便于与历史文件对齐
        index_base = 0
        if args.from_order:
            for i, o in enumerate(all_orders):
                if o["orderNo"] == args.from_order:
                    index_base = i
                    break
        write_clip_pages(queue, args.out_dir, index_base=index_base, unmatched_suppliers=unmatched_suppliers)
        print(f"复制页 {len(queue)*2} 个 + index.html → {args.out_dir}")

    # 队列里保留 clip 链接（若生成了）
    args.queue.parent.mkdir(parents=True, exist_ok=True)
    args.queue.write_text(json.dumps(queue, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"队列 {len(queue)} 条 → {args.queue}")

    # 简表
    multi = {}
    for o in all_orders:
        multi.setdefault(o["orderNo"], set()).add(o["supplier"])
    split_n = sum(1 for s in multi.values() if len(s) > 1)
    print(f"其中同号多供应商订单 {split_n} 个（已拆成多张单）")
    if queue:
        o0 = queue[0]
        print(f"下一单: {o0['orderNo']} / {o0['supplier']} / 预期 {o0['expectedTotal']}")
        if o0.get("pasteUrl"):
            print(f"  价量: {o0['pasteUrl']}")
            print(f"  编码: {o0['codesUrl']}")

    if args.serve:
        if args.no_html:
            raise SystemExit("--serve 需要生成 html（不要加 --no-html）")
        serve(args.out_dir, args.port, args.queue)


if __name__ == "__main__":
    main()

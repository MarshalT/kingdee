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
import json
import re
import sys
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
    need = ["日期", "订单号", "名称", "数量", "单位", "单价（供应商）", "供应商名称"]
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
        supplier = _cell(row[idx["供应商名称"]])
        if not order_no or not supplier:
            continue
        code = _cell(row[idx["_商品编码"]])
        name = _cell(row[idx["名称"]])
        spec = _cell(row[idx["型号"]]) if "型号" in idx else None
        qty = _num(row[idx["数量"]])
        unit = _cell(row[idx["单位"]]) or ""
        price = _num(row[idx["单价（供应商）"]])
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
                "price": price,
            }
        )
    wb.close()
    return out


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
                    "supplier": r["supplier"],
                    "date": r["date"],
                    "lines": [],
                }
            )
        g = groups[key_to_i[key]]
        if not g["date"] and r["date"]:
            g["date"] = r["date"]
        g["lines"].append(
            {
                "code": r["code"],
                "name": r["name"],
                "spec": r["spec"],
                "qty": r["qty"],
                "unit": r["unit"],
                "price": r["price"],
            }
        )
    for g in groups:
        total = sum(l["qty"] * l["price"] for l in g["lines"])
        g["expectedTotal"] = round(total + 1e-9, 2)
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


def write_clip_pages(orders, out_dir: Path, index_base: int = 0):
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
        (out_dir / o["combinedName"]).write_text(html_combined_page(f"{o['orderNo']} · {o['supplier']}", paste_body, codes_body, next_url), encoding="utf-8")
    # 索引页方便人工点选
    links = ["<!DOCTYPE html><meta charset=utf-8><title>clipserve index</title><h1>录单复制页</h1><ol>"]
    for o in orders:
        links.append(
            f"<li><b>{o['orderNo']}</b> · {o['supplier']} · 预期 {o['expectedTotal']} · "
            f"<a href='paste-{o['orderNo']}-{o['clipIndex']}.html'>价量</a> · "
            f"<a href='codes-{o['orderNo']}-{o['clipIndex']}.html'>编码</a> · "
            f"<a href='order-{o['orderNo']}-{o['clipIndex']}.html'>合并操作页</a></li>"
        )
    links.append("</ol>")
    (out_dir / "index.html").write_text("\n".join(links), encoding="utf-8")
    return written


def filter_from(orders, from_order: str | None):
    if not from_order:
        return orders
    for i, o in enumerate(orders):
        if o["orderNo"] == from_order:
            return orders[i:]
    raise SystemExit(f"队列中找不到订单号 {from_order}")


def serve(out_dir: Path, port: int):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(out_dir), **k)

        def log_message(self, fmt, *args):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"clipserve: http://127.0.0.1:{port}/  (目录 {out_dir})")
    print("首页: http://127.0.0.1:%d/index.html" % port)
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
    ap.add_argument("--from", dest="from_order", default=None, help="从该订单号起写入队列（含）")
    ap.add_argument("--port", type=int, default=8766, help="--serve 时端口")
    ap.add_argument("--serve", action="store_true", help="生成后启动本地 http 服务")
    ap.add_argument("--no-html", action="store_true", help="只写 JSON，不生成 html")
    args = ap.parse_args()

    if not args.excel.exists():
        raise SystemExit(f"找不到 Excel: {args.excel}")

    rows = read_excel(args.excel)
    all_orders = split_orders(rows)
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
        write_clip_pages(queue, args.out_dir, index_base=index_base)
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
        serve(args.out_dir, args.port)


if __name__ == "__main__":
    main()

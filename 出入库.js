// ==UserScript==
// @name         金蝶云星辰出入库单自动填充助手
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  自动填充金蝶云星辰采购入库/销售出库/销售入库单的单据日期和仓库
// @author       AutoFill Assistant
// @match        https://tf.jdy.com/*
// @match        https://service.jdy.com/*
// @match        https://*.jiandaoyun.com/*
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const PANEL_ID = 'warehouse-helper-panel';
    const LOG_ID = 'warehouse-helper-log';
    const oldPanel = document.getElementById(PANEL_ID);
    if (oldPanel) oldPanel.remove();

    let billDate = getTodayDate();

    function getTodayDate() {
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isVisible(el) {
        if (!el || typeof el.getBoundingClientRect !== 'function') return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function normalizeText(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    function isInHelperPanel(el) {
        return !!el?.closest?.(`#${PANEL_ID}`);
    }

    function setNativeInputValue(input, value) {
        const proto = input.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function log(message, type = 'info') {
        console.log(`[出入库助手][${type}] ${message}`);
        const box = document.getElementById(LOG_ID);
        if (!box) return;
        const item = document.createElement('div');
        item.style.cssText = 'margin-top:6px;padding:6px 8px;border-radius:6px;background:rgba(0,0,0,0.18);';
        item.textContent = `${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'} ${message}`;
        box.prepend(item);
        while (box.children.length > 8) box.removeChild(box.lastChild);
    }

    function detectBillType() {
        const candidates = ['采购入库单', '销售出库单', '销售入库单'];
        for (const name of candidates) {
            const matched = Array.from(document.querySelectorAll('*'))
                .filter(isVisible)
                .some(el => (el.textContent || '').trim() === name);
            if (matched) return name;
        }
        return '出入库单';
    }

    function updatePanelTitle() {
        const title = document.getElementById('warehouse-helper-title');
        if (title) title.textContent = `${detectBillType()}助手`;
    }

    function findDateInput() {
        const isDateText = value => /^\d{4}-\d{2}-\d{2}$/.test((value || '').trim());
        const labelCandidates = Array.from(document.querySelectorAll('*'))
            .filter(el => {
                if (!isVisible(el) || isInHelperPanel(el)) return false;
                const text = normalizeText(el.textContent);
                return text === '单据日期';
            });

        const scoreInput = (label, input) => {
            const labelRect = label.getBoundingClientRect();
            const inputRect = input.getBoundingClientRect();
            let score = 0;
            if (input.dataset.field === 'field') score += 20;
            if (input.type === 'date') score += 18;
            if (isDateText(input.value)) score += 12;
            if (inputRect.left > labelRect.left) score += 12;
            score -= Math.abs(inputRect.top - labelRect.top);
            score -= Math.abs(inputRect.left - labelRect.right) / 10;
            const containerText = normalizeText(input.closest('[class], form, section, div')?.textContent || '');
            if (containerText.includes('基本信息')) score += 10;
            if (containerText.includes('常用条件过滤')) score -= 20;
            if (containerText.includes('查询范围')) score -= 20;
            if (containerText.includes('业务员')) score -= 12;
            return score;
        };

        const matches = [];
        for (const label of labelCandidates) {
            let parent = label.parentElement;
            for (let i = 0; i < 5 && parent; i++) {
                const inputs = Array.from(parent.querySelectorAll('input[data-field="field"], input[type="date"], input[type="text"], input'))
                    .filter(inp => isVisible(inp) && !isInHelperPanel(inp) && (isDateText(inp.value) || inp.type === 'date'));
                for (const input of inputs) {
                    matches.push({ input, score: scoreInput(label, input) });
                }
                parent = parent.parentElement;
            }
        }

        if (matches.length) {
            return matches.sort((a, b) => b.score - a.score)[0].input;
        }

        return Array.from(document.querySelectorAll('input[data-field="field"], input[type="date"], input[type="text"], input'))
            .filter(inp => isVisible(inp) && !isInHelperPanel(inp) && isDateText(inp.value))
            .sort((a, b) => {
                const aText = normalizeText(a.closest('[class], form, section, div')?.textContent || '');
                const bText = normalizeText(b.closest('[class], form, section, div')?.textContent || '');
                const aScore = (a.dataset.field === 'field' ? 10 : 0) + (aText.includes('基本信息') ? 8 : 0) - (aText.includes('常用条件过滤') ? 10 : 0);
                const bScore = (b.dataset.field === 'field' ? 10 : 0) + (bText.includes('基本信息') ? 8 : 0) - (bText.includes('常用条件过滤') ? 10 : 0);
                return bScore - aScore;
            })[0] || null;
    }

    async function fillBillDate(value) {
        const input = findDateInput();
        if (!input) {
            log('未找到单据日期输入框', 'error');
            return false;
        }
        input.click();
        input.focus();
        setNativeInputValue(input, value);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
        input.blur();
        await sleep(150);
        log(`单据日期已填充为 ${value}`, 'success');
        return true;
    }

    function getActiveTableRoot() {
        const roots = Array.from(document.querySelectorAll('.kd-table')).filter(isVisible);
        if (!roots.length) return null;
        const score = root => {
            const text = (root.innerText || '').replace(/\s+/g, ' ');
            let score = 0;
            if (text.includes('商品编码')) score += 4;
            if (text.includes('仓库')) score += 4;
            if (text.includes('数量')) score += 2;
            if (text.includes('单据编号')) score -= 6;
            if (text.includes('供应商')) score -= 3;
            if (text.includes('客户')) score -= 1;
            score += root.querySelectorAll('tr').length;
            return score;
        };
        return roots.map(root => ({ root, score: score(root) })).sort((a, b) => b.score - a.score)[0]?.root || null;
    }

    function getVisibleWarehouseCells(root) {
        if (!root) return [];
        const cells = Array.from(root.querySelectorAll('td[data-code="stockid"], td[data-code="billstockid"], td[data-code="storeid"]'))
            .filter(cell => {
                if (!isVisible(cell)) return false;
                if (!cell.classList.contains('editable-cell')) return false;
                const row = cell.closest('tr');
                if (!row || !isVisible(row)) return false;
                const materialCell = row.querySelector('td[data-code="materialid"]');
                return !!materialCell;
            });
        const byRow = new Map();
        for (const cell of cells) {
            const rowKey = cell.getAttribute('data-rowindex') || `${byRow.size}`;
            if (!byRow.has(rowKey)) byRow.set(rowKey, cell);
        }
        return Array.from(byRow.values());
    }

    function findActionButton(labelText) {
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], span, div'))
            .filter(el => isVisible(el) && !isInHelperPanel(el))
            .filter(el => normalizeText(el.textContent) === labelText);

        const clickable = candidates
            .map(el => el.closest('button, [role="button"]') || el)
            .find(el => isVisible(el) && !el.disabled);

        return clickable || null;
    }

    async function clickAuditButton() {
        const auditedMark = Array.from(document.querySelectorAll('*'))
            .filter(el => isVisible(el) && !isInHelperPanel(el))
            .some(el => normalizeText(el.textContent) === '反审核');
        if (auditedMark) {
            log('当前单据已是已审核状态，跳过审核');
            return { clicked: false, skipped: true };
        }

        const auditButton = findActionButton('审核');
        if (!auditButton) {
            log('未找到审核按钮', 'error');
            return { clicked: false, skipped: false };
        }

        auditButton.click();
        await sleep(30);
        log('已自动点击审核按钮', 'success');
        return { clicked: true, skipped: false };
    }

    function findActiveWarehouseEditor(cell) {
        const focused = document.activeElement;
        const cellRect = cell.getBoundingClientRect();
        const isNearCell = (input) => {
            const rect = input.getBoundingClientRect();
            return Math.abs(rect.top - cellRect.top) <= 40 &&
                rect.left >= cellRect.left - 20 &&
                rect.right <= cellRect.right + 120;
        };

        if (focused && focused.tagName === 'INPUT' && isVisible(focused) && isNearCell(focused)) return focused;

        const cellInput = cell.querySelector('input, textarea');
        if (cellInput && isVisible(cellInput)) return cellInput;

        const visibleInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type]), textarea'))
            .filter(isVisible);
        return visibleInputs.find(input => {
            const rect = input.getBoundingClientRect();
            return Math.abs(rect.top - cellRect.top) <= 40 &&
                rect.left >= cellRect.left - 20 &&
                rect.right <= cellRect.right + 120 &&
                rect.width <= cellRect.width + 40;
        }) || null;
    }

    async function fillWarehouseCell(cell, warehouseValue, rowNo) {
        cell.click();
        const trigger = cell.querySelector('.kd-table-cell-basedata-container, div, span');
        if (trigger) trigger.click();

        for (let i = 0; i < 12; i++) {
            await sleep(80);
            const input = findActiveWarehouseEditor(cell);
            if (!input) continue;
            input.focus();
            setNativeInputValue(input, warehouseValue);
            await sleep(60);
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
            input.blur();
            await sleep(120);
            log(`第${rowNo}行仓库已填充为 ${warehouseValue}`, 'success');
            return true;
        }

        log(`第${rowNo}行仓库未找到可编辑输入框`, 'error');
        return false;
    }

    async function fillWarehouse(warehouseValue) {
        const root = getActiveTableRoot();
        if (!root) {
            log('未找到当前单据的商品表格', 'error');
            return { total: 0, success: 0 };
        }

        // 金蝶仓库表头的 batchAdd 图标是原生“批量设置”入口。
        // 优先使用它，可以覆盖虚拟滚动表格的全部行，避免只处理当前可见行。
        const batchIcon = root.querySelector('th[data-code="stockid"] i.kdfont-batchAdd');
        if (batchIcon && isVisible(batchIcon)) {
            activateBatchWarehouseButton(batchIcon);
            // 弹窗可能由金蝶异步挂载，等待实际仓库基础资料表，而不是固定延时后立即查找。
            const popupDeadline = Date.now() + 2500;
            while (Date.now() < popupDeadline) {
                const visibleStockTable = Array.from(document.querySelectorAll('.kd-table'))
                    .some(table => table !== root && isVisible(table) && table.querySelector('td[data-code="stockname"]'));
                if (visibleStockTable) break;
                await sleep(100);
            }
            const selected = await chooseWarehouseFromBatchPopup(warehouseValue);
            if (selected) {
                log(`已通过仓库表头批量设置全部明细行：${warehouseValue}`, 'success');
                return { total: -1, success: -1, batch: true };
            }
            log('仓库批量选择窗口未找到目标仓库，改用逐行填充', 'warn');
        }

        const cells = getVisibleWarehouseCells(root);
        if (!cells.length) {
            log('未找到仓库列单元格', 'error');
            return { total: 0, success: 0 };
        }

        let success = 0;
        for (let i = 0; i < cells.length; i++) {
            if (await fillWarehouseCell(cells[i], warehouseValue, i + 1)) success++;
        }
        return { total: cells.length, success };
    }

    function getVisibleWarehousePopupRows() {
        const selectors = [
            '[role="dialog"] tr', '[role="listbox"] [role="option"]',
            '.kd-modal tr', '.kd-dropdown tr', '.kd-select-dropdown tr',
            '.kd-table tbody tr'
        ];
        const rows = [];
        for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
                if (isInHelperPanel(el) || !isVisible(el)) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width < 80 || rect.height < 18) continue;
                const text = normalizeText(el.textContent);
                if (text) rows.push(el);
            }
        }
        return Array.from(new Set(rows));
    }

    async function chooseWarehouseFromBatchPopup(warehouseValue) {
        const target = normalizeText(warehouseValue);
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            // 仓库基础资料弹窗使用独立的 kd-table，列标识为 stockno/stockname。
            // 优先按仓库名称精确匹配，避免把明细表中的仓库单元格误当成弹窗选项。
            const stockNameCell = Array.from(document.querySelectorAll('td[data-code="stockname"]'))
                .find(cell => isVisible(cell) && normalizeText(cell.textContent) === target);
            if (stockNameCell) {
                const row = stockNameCell.closest('tr');
                if (row) {
                    row.click();
                    await sleep(220);
                    return true;
                }
            }
            const rows = getVisibleWarehousePopupRows();
            const exact = rows.find(row => {
                const cells = Array.from(row.querySelectorAll('td,[role="cell"]'));
                const text = normalizeText(row.textContent);
                return cells.some(cell => normalizeText(cell.textContent) === target) || text === target;
            });
            if (exact) {
                exact.click();
                await sleep(180);
                return true;
            }
            await sleep(100);
        }
        return false;
    }

    function activateBatchWarehouseButton(batchIcon) {
        const rect = batchIcon.getBoundingClientRect();
        const targets = [batchIcon, batchIcon.parentElement, batchIcon.closest('[data-slot="tips"]')].filter(Boolean);
        for (const target of targets) {
            // React/金蝶的批量设置入口有版本差异：有的版本监听图标本身，
            // 有的版本监听包裹层；两者都触发一次，避免只派发到不会处理的节点。
            target.click?.();
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                target.dispatchEvent(new MouseEvent(type, {
                bubbles: true, cancelable: true, composed: true, view: window,
                button: 0, buttons: type === 'mousedown' ? 1 : 0,
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2
                }));
            }
        }
    }

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
        'position:fixed',
        'top:120px',
        'right:20px',
        'width:340px',
        'background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)',
        'border-radius:12px',
        'box-shadow:0 8px 32px rgba(0,0,0,0.3)',
        'z-index:999998',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
        'color:white',
        'overflow:hidden'
    ].join(';');

    panel.innerHTML = `
        <div id="warehouse-helper-header" style="padding:16px;cursor:move;background:rgba(0,0,0,0.2);display:flex;justify-content:space-between;align-items:center;">
            <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:20px;">🏭</span>
                <span id="warehouse-helper-title" style="font-weight:bold;font-size:15px;">${detectBillType()}助手</span>
            </div>
            <button id="warehouse-close" style="width:24px;height:24px;border:none;background:rgba(255,255,255,0.2);color:white;border-radius:50%;cursor:pointer;font-size:18px;line-height:1;">×</button>
        </div>
        <div style="padding:20px;">
            <div style="margin-bottom:16px;">
                <div style="font-size:13px;font-weight:bold;margin-bottom:8px;display:flex;align-items:center;gap:6px;"><span>📅</span><span>单据日期</span></div>
                <input type="date" id="warehouse-date" value="${billDate}" style="width:100%;padding:10px;border:none;border-radius:8px;background:rgba(255,255,255,0.95);color:#333;font-size:14px;font-weight:bold;">
            </div>
            <div style="margin-bottom:16px;">
                <div style="font-size:13px;font-weight:bold;margin-bottom:8px;display:flex;align-items:center;gap:6px;"><span>🏬</span><span>仓库</span></div>
                <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px;color:rgba(255,255,255,0.92);cursor:pointer;">
                    <input type="checkbox" id="warehouse-enabled" style="width:16px;height:16px;cursor:pointer;">
                    <span>自动填充仓库</span>
                </label>
                <input type="text" id="warehouse-input" value="01" style="width:100%;padding:10px;border:none;border-radius:8px;background:rgba(255,255,255,0.95);color:#333;font-size:14px;font-weight:bold;">
                <div style="font-size:11px;color:rgba(255,255,255,0.85);margin-top:6px;">默认只填单据日期；勾选后才填仓库</div>
            </div>
            <button id="warehouse-fill" style="width:100%;padding:14px;background:linear-gradient(135deg,#11998e 0%,#38ef7d 100%);border:none;border-radius:10px;color:white;font-size:15px;font-weight:bold;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;">
                <span>🚀</span><span>自动填充</span>
            </button>
            <div id="${LOG_ID}" style="margin-top:14px;font-size:11px;line-height:1.45;max-height:220px;overflow:auto;"></div>
        </div>
    `;

    document.body.appendChild(panel);

    const header = document.getElementById('warehouse-helper-header');
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        offsetX = e.clientX - panel.offsetLeft;
        offsetY = e.clientY - panel.offsetTop;
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        panel.style.left = `${e.clientX - offsetX}px`;
        panel.style.top = `${e.clientY - offsetY}px`;
        panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });

    document.getElementById('warehouse-close').addEventListener('click', () => {
        panel.style.display = 'none';
    });

    document.getElementById('warehouse-date').addEventListener('change', (e) => {
        billDate = e.target.value || getTodayDate();
        log(`日期已更新为 ${billDate}`);
    });

    document.getElementById('warehouse-enabled').addEventListener('change', (e) => {
        log(e.target.checked ? '已开启自动填充仓库' : '已关闭自动填充仓库');
    });

    document.getElementById('warehouse-fill').addEventListener('click', async () => {
        updatePanelTitle();
        const dateValue = document.getElementById('warehouse-date').value || getTodayDate();
        const fillWarehouseEnabled = document.getElementById('warehouse-enabled').checked;
        const warehouseValue = document.getElementById('warehouse-input').value.trim();
        if (fillWarehouseEnabled && !warehouseValue) {
            log('请先输入仓库名称', 'error');
            alert('请先输入仓库名称');
            return;
        }

        const btn = document.getElementById('warehouse-fill');
        btn.disabled = true;
        btn.style.opacity = '0.7';

        try {
            log(`当前单据：${detectBillType()}`);
            const dateOk = await fillBillDate(dateValue);
            let warehouseResult = { total: 0, success: 0, skipped: true };
            if (fillWarehouseEnabled) {
                warehouseResult = await fillWarehouse(warehouseValue);
            } else {
                log('已跳过仓库填充');
            }
            const auditResult = await clickAuditButton();

            const warehouseSummary = !fillWarehouseEnabled
                ? '已跳过'
                : warehouseResult.batch
                    ? '已通过表头批量设置全部明细行'
                    : `${warehouseResult.success}/${warehouseResult.total}`;
            const summary = `单据：${detectBillType()}\n日期：${dateOk ? '✓' : '✗'}\n仓库：${warehouseSummary}\n审核：${auditResult.clicked ? '已点击' : auditResult.skipped ? '已跳过' : '未找到'}`;
            log(`填充完成：${summary.replace(/\n/g, ' / ')}`, warehouseResult.success > 0 || warehouseResult.skipped || dateOk ? 'success' : 'error');
            // alert(summary);
        } catch (error) {
            console.error(error);
            log(`填充失败：${error.message}`, 'error');
            alert(`填充失败：${error.message}`);
        } finally {
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    });

    updatePanelTitle();
    setInterval(updatePanelTitle, 1500);
    log('助手已加载，可用于采购入库/销售出库/销售入库');
})();


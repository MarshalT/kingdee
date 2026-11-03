// ==UserScript==
// @name         金蝶云星辰采购订单自动填充助手
// @namespace    http://tampermonkey.net/
// @version      13.3.1
// @description  自动填充金蝶云星辰（简道云）采购订单的含税单价和数量，支持虚拟滚动表格；支持粘贴并填充商品编码（materialid）
// @author       AutoFill Assistant
// @match        https://tf.jdy.com/*
// @match        https://service.jdy.com/*
// @match        https://*.jiandaoyun.com/*
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

/**
 * 金蝶云星辰订单自动填充助手 - 虚拟滚动版 v13.3.1
 *
 * 核心特性：
 * ✅ 支持采购订单和销售订单双模式
 * ✅ 支持虚拟滚动表格（DOM中只保留15行，实际可处理22+行）
 * ✅ 通过行号定位，逐行滚动并填充
 * ✅ 不受DOM渲染限制，支持任意行数
 *
 * 使用方法：
 * 1. F12打开控制台
 * 2. 粘贴此脚本并回车
 * 3. 选择订单类型（采购/销售）
 * 4. 输入数据（采购订单：数量+单价，销售订单：仅单价）
 * 5. 点击"智能填充"
 * 6. 自动完成所有行的填充
 */

(function() {
    'use strict';

    console.log('🚀 金蝶云星辰自动填充工具（虚拟滚动版 v13.3）加载中...');

    // 移除旧面板
    const oldPanel = document.getElementById('jdy-final-panel');
    if (oldPanel) oldPanel.remove();

    let orderData = {
        quantities: [],
        prices: []
    };

    let isFilling = false;
    let autoRunActive = false;
    let sourceOrders = [];
    let sourceOrderIndex = -1;
    let gridApi = null;
    let orderType = 'purchase'; // 'purchase'、'sales' 或 'warehouse'
    let savedDate = getTodayDate(); // 保存的日期
    let warehouseAutofillEnabled = false;
    let warehouseValue = '01';
    const salesCustomers = [
        '广东开尔文智能科技有限公司',
        '珠海精实测控技术股份有限公司'
    ];
    let selectedSalesCustomer = '';

    function isElementVisible(el) {
        if (!el || typeof el.getBoundingClientRect !== 'function') return false;
        try {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 &&
                rect.height > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0';
        } catch (e) {
            return false;
        }
    }

    function setNativeInputValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, value); else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    function getVisibleTables() {
        return Array.from(document.querySelectorAll('table')).filter(isElementVisible);
    }

    function getActiveKdTableRoot() {
        const roots = Array.from(document.querySelectorAll('.kd-table')).filter(isElementVisible);
        if (!roots.length) return null;

        const scoreRoot = (root) => {
            const text = (root.innerText || '').replace(/\s+/g, ' ');
            let score = 0;
            if (text.includes('商品编码')) score += 4;
            if (text.includes('仓库')) score += 4;
            if (text.includes('数量')) score += 3;
            if (text.includes('含税单价')) score += 3;
            if (text.includes('增值税税率')) score += 2;
            if (text.includes('单据编号')) score -= 6;
            if (text.includes('供应商')) score -= 4;
            score += root.querySelectorAll('tbody tr').length;
            return score;
        };

        return roots
            .map(root => ({ root, score: scoreRoot(root) }))
            .sort((a, b) => b.score - a.score)[0]?.root || null;
    }

    // 出入库助手：日期沿用共用面板；仓库仍按原助手的可选填充逻辑逐行处理。
    function findWarehouseDateInput() {
        const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test((value || '').trim());
        const labels = [...document.querySelectorAll('*')].filter(el => isElementVisible(el) && !el.closest('#jdy-final-panel') && (el.textContent || '').trim() === '单据日期');
        for (const label of labels) {
            let parent = label.parentElement;
            for (let i = 0; i < 5 && parent; i++, parent = parent.parentElement) {
                const input = [...parent.querySelectorAll('input[data-field="field"],input[type="date"],input[type="text"],input')]
                    .find(el => isElementVisible(el) && !el.closest('#jdy-final-panel') && (isDate(el.value) || el.type === 'date'));
                if (input) return input;
            }
        }
        return [...document.querySelectorAll('input[data-field="field"],input[type="date"],input[type="text"],input')]
            .find(el => isElementVisible(el) && !el.closest('#jdy-final-panel') && isDate(el.value)) || null;
    }

    async function fillWarehouseBillDate(value) {
        const input = findWarehouseDateInput();
        if (!input) { log('未找到单据日期输入框', 'error'); return false; }
        input.click(); input.focus(); setNativeInputValue(input, value);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
        input.blur(); await sleep(150);
        log(`单据日期已填充为 ${value}`, 'success'); return true;
    }

    function getVisibleWarehouseCells(root) {
        if (!root) return [];
        const cells = [...root.querySelectorAll('td[data-code="stockid"],td[data-code="billstockid"],td[data-code="storeid"]')]
            .filter(cell => isElementVisible(cell) && cell.classList.contains('editable-cell') && isElementVisible(cell.closest('tr')) && cell.closest('tr')?.querySelector('td[data-code="materialid"]'));
        const byRow = new Map();
        for (const cell of cells) { const key = cell.getAttribute('data-rowindex') || String(byRow.size); if (!byRow.has(key)) byRow.set(key, cell); }
        return [...byRow.values()];
    }

    function findWarehouseEditor(cell) {
        const rect = cell.getBoundingClientRect();
        const near = input => { const r = input.getBoundingClientRect(); return Math.abs(r.top - rect.top) <= 40 && r.left >= rect.left - 20 && r.right <= rect.right + 120; };
        const focused = document.activeElement;
        if (focused?.tagName === 'INPUT' && isElementVisible(focused) && near(focused)) return focused;
        const inner = cell.querySelector('input,textarea'); if (inner && isElementVisible(inner)) return inner;
        return [...document.querySelectorAll('input[type="text"],input:not([type]),textarea')].find(input => isElementVisible(input) && near(input) && input.getBoundingClientRect().width <= rect.width + 40) || null;
    }

    async function fillWarehouseCell(cell, value, rowNo) {
        cell.click(); cell.querySelector('.kd-table-cell-basedata-container,div,span')?.click();
        for (let i = 0; i < 12; i++) {
            await sleep(80); const input = findWarehouseEditor(cell); if (!input) continue;
            input.focus(); setNativeInputValue(input, value); await sleep(60);
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
            input.blur(); await sleep(120); log(`第${rowNo}行仓库已填充为 ${value}`, 'success'); return true;
        }
        log(`第${rowNo}行仓库未找到可编辑输入框`, 'error'); return false;
    }

    async function fillWarehouse(value) {
        const root = getActiveKdTableRoot(); if (!root) { log('未找到当前单据的商品表格', 'error'); return { total: 0, success: 0 }; }
        const cells = getVisibleWarehouseCells(root); if (!cells.length) { log('未找到仓库列单元格', 'error'); return { total: 0, success: 0 }; }
        let success = 0; for (let i = 0; i < cells.length; i++) if (await fillWarehouseCell(cells[i], value, i + 1)) success++;
        return { total: cells.length, success };
    }

    function findWarehouseActionButton(label) {
        return [...document.querySelectorAll('button,[role="button"],span,div')]
            .filter(el => isElementVisible(el) && !el.closest('#jdy-final-panel') && (el.textContent || '').trim() === label)
            .map(el => el.closest('button,[role="button"]') || el).find(el => isElementVisible(el) && !el.disabled) || null;
    }

    async function handleWarehouseAudit() {
        const alreadyAudited = [...document.querySelectorAll('*')].some(el => isElementVisible(el) && !el.closest('#jdy-final-panel') && (el.textContent || '').trim() === '反审核');
        if (alreadyAudited) { log('当前单据已是已审核状态，跳过审核'); return { clicked: false, skipped: true }; }
        const button = findWarehouseActionButton('审核');
        if (!button) { log('未找到审核按钮', 'error'); return { clicked: false, skipped: false }; }
        button.click(); await sleep(30); log('已自动点击审核按钮', 'success'); return { clicked: true, skipped: false };
    }

    async function runWarehouseFill() {
        const dateValue = document.getElementById('input-date').value || getTodayDate();
        const enabled = document.getElementById('input-warehouse-enabled').checked;
        const value = document.getElementById('input-warehouse').value.trim();
        if (enabled && !value) throw new Error('请先输入仓库名称');
        const button = document.getElementById('btn-warehouse-fill'); button.disabled = true;
        try {
            log(`当前单据：${detectWarehouseBillType()}`, 'info');
            const dateOk = await fillWarehouseBillDate(dateValue);
            const warehouseResult = enabled ? await fillWarehouse(value) : { total: 0, success: 0, skipped: true };
            if (!enabled) log('已跳过仓库填充', 'info');
            const audit = await handleWarehouseAudit();
            log(`填充完成：单据 ${detectWarehouseBillType()} / 日期 ${dateOk ? '✓' : '✗'} / 仓库 ${enabled ? `${warehouseResult.success}/${warehouseResult.total}` : '已跳过'} / 审核 ${audit.clicked ? '已点击' : audit.skipped ? '已跳过' : '未找到'}`, warehouseResult.success > 0 || warehouseResult.skipped || dateOk ? 'success' : 'error');
            return { success: dateOk, warehouse: warehouseResult, audit };
        } finally { button.disabled = false; }
    }

    function detectWarehouseBillType() {
        for (const name of ['采购入库单', '销售出库单', '销售入库单']) {
            if ([...document.querySelectorAll('*')].some(el => isElementVisible(el) && (el.textContent || '').trim() === name)) return name;
        }
        return '出入库单';
    }

    // 获取今天的日期（格式：YYYY-MM-DD）
    function getTodayDate() {
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // 获取AG-Grid API
    function getGridApi() {
        if (gridApi) return gridApi;

        const getFromDoc = (doc = document) => {
            const gridEls = Array.from(doc.querySelectorAll('[__agComponent]'))
                .filter(el => doc !== document || isElementVisible(el));
            for (const el of gridEls) {
                try {
                    const api = el && el.__agComponent && el.__agComponent.gridApi;
                    if (api) return api;
                } catch (e) {}
            }

            const grid = Array.from(doc.querySelectorAll('div[role="grid"]'))
                .find(el => doc !== document || isElementVisible(el));
            if (grid && grid.__agComponent && grid.__agComponent.gridApi) return grid.__agComponent.gridApi;
            return null;
        };

        const apiFromMain = getFromDoc();
        if (apiFromMain) {
            gridApi = apiFromMain;
            return gridApi;
        }

        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (const f of iframes) {
            try {
                const doc = f.contentDocument;
                if (!doc) continue;
                const api = getFromDoc(doc);
                if (api) {
                    gridApi = api;
                    return gridApi;
                }
            } catch (e) {}
        }

        return null;
    }

    // 创建UI
    function createUI() {
        const panel = document.createElement('div');
        panel.id = 'jdy-final-panel';
        panel.innerHTML = `
            <style>
                #jdy-final-panel {
                    position: fixed;
                    top: max(8px, 4vh);
                    right: max(8px, 2vw);
                    width: min(400px, calc(100vw - 16px));
                    max-height: calc(100vh - 16px);
                    display: flex;
                    flex-direction: column;
                    box-sizing: border-box;
                    overflow: hidden;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    border-radius: 12px;
                    box-shadow: 0 15px 40px rgba(0,0,0,0.5);
                    z-index: 999999;
                    font-family: 'Microsoft YaHei', sans-serif;
                    color: white;
                }
                .final-header {
                    background: rgba(0,0,0,0.3);
                    padding: 14px 18px;
                    cursor: move;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-radius: 12px 12px 0 0;
                }
                .final-title {
                    font-size: 16px;
                    font-weight: bold;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .version-badge {
                    background: rgba(255,255,255,0.2);
                    padding: 2px 8px;
                    border-radius: 10px;
                    font-size: 10px;
                }
                .order-type-switch {
                    display: flex;
                    gap: 8px;
                    margin-bottom: 14px;
                }
                .type-btn {
                    flex: 1;
                    padding: 10px;
                    border: 2px solid rgba(255,255,255,0.3);
                    border-radius: 8px;
                    background: rgba(255,255,255,0.1);
                    color: white;
                    font-size: 13px;
                    font-weight: bold;
                    cursor: pointer;
                    transition: all 0.3s;
                }
                .type-btn:hover {
                    background: rgba(255,255,255,0.2);
                }
                .type-btn.active {
                    background: rgba(56, 239, 125, 0.3);
                    border-color: #38ef7d;
                    box-shadow: 0 0 10px rgba(56, 239, 125, 0.5);
                }
                .final-close {
                    width: 26px;
                    height: 26px;
                    border: none;
                    background: rgba(255,255,255,0.2);
                    color: white;
                    border-radius: 50%;
                    cursor: pointer;
                    font-size: 20px;
                    line-height: 1;
                }
                .final-close:hover {
                    background: rgba(255,255,255,0.3);
                    transform: scale(1.1);
                }
                .final-content {
                    padding: 18px;
                    overflow-y: auto;
                    overscroll-behavior: contain;
                    min-height: 0;
                    box-sizing: border-box;
                }
                .final-section {
                    background: rgba(255,255,255,0.1);
                    border-radius: 8px;
                    padding: 14px;
                    margin-bottom: 14px;
                }
                .final-label {
                    font-size: 13px;
                    font-weight: bold;
                    margin-bottom: 8px;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                .final-textarea {
                    width: 100%;
                    max-width: 100%;
                    box-sizing: border-box;
                    min-height: 90px;
                    padding: 10px;
                    border: none;
                    border-radius: 6px;
                    background: rgba(255,255,255,0.95);
                    color: #333;
                    font-size: 12px;
                    font-family: Consolas, monospace;
                    resize: vertical;
                }
                .final-textarea:focus {
                    outline: 2px solid rgba(255,255,255,0.6);
                }
                .final-date-input {
                    width: 100%;
                    box-sizing: border-box;
                    padding: 10px;
                    border: none;
                    border-radius: 6px;
                    background: rgba(255,255,255,0.95);
                    color: #333;
                    font-size: 13px;
                    font-weight: bold;
                }
                .final-date-input:focus {
                    outline: 2px solid rgba(255,255,255,0.6);
                }
                .final-hint {
                    font-size: 11px;
                    color: rgba(255,255,255,0.85);
                    margin-top: 6px;
                }
                .final-buttons {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 10px;
                    min-width: 0;
                }
                .final-btn {
                    min-width: 0;
                    overflow-wrap: anywhere;
                    padding: 12px;
                    border: none;
                    border-radius: 8px;
                    font-size: 14px;
                    font-weight: bold;
                    cursor: pointer;
                    transition: all 0.3s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                }
                .final-btn:hover:not(:disabled) {
                    transform: translateY(-2px);
                    box-shadow: 0 6px 16px rgba(0,0,0,0.3);
                }
                .final-btn:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                .btn-fill {
                    background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
                    color: white;
                }
                .btn-clear {
                    background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
                    color: white;
                }
                .btn-help {
                    background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
                    color: white;
                }
                .btn-refresh {
                    background: linear-gradient(135deg, #fa709a 0%, #fee140 100%);
                    color: white;
                }
                .btn-paste {
                    background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%);
                    color: #333;
                    font-weight: bold;
                }
                .final-log {
                    background: rgba(0,0,0,0.3);
                    border-radius: 6px;
                    padding: 12px;
                    max-height: 220px;
                    overflow-y: auto;
                    font-size: 11px;
                    font-family: Consolas, monospace;
                    line-height: 1.6;
                }
                .final-log::-webkit-scrollbar {
                    width: 6px;
                }
                .final-log::-webkit-scrollbar-thumb {
                    background: rgba(255,255,255,0.3);
                    border-radius: 3px;
                }
                .log-item {
                    margin: 3px 0;
                    animation: slideIn 0.3s;
                }
                @keyframes slideIn {
                    from { opacity: 0; transform: translateX(-10px); }
                    to { opacity: 1; transform: translateX(0); }
                }
                .progress-bar {
                    background: rgba(0,0,0,0.3);
                    border-radius: 12px;
                    height: 24px;
                    overflow: hidden;
                    margin-top: 10px;
                }
                .progress-fill {
                    background: linear-gradient(90deg, #11998e 0%, #38ef7d 100%);
                    height: 100%;
                    transition: width 0.3s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 11px;
                    font-weight: bold;
                }
                .stats-box {
                    background: rgba(0,0,0,0.2);
                    border-radius: 6px;
                    padding: 8px 12px;
                    margin-top: 8px;
                    font-size: 11px;
                    display: flex;
                    justify-content: space-around;
                }
                .stat-item {
                    text-align: center;
                }
                .stat-value {
                    font-size: 16px;
                    font-weight: bold;
                    color: #38ef7d;
                }

                .amount-check-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                    margin: 4px 0;
                    font-size: 12px;
                }
                .amount-check-label {
                    color: rgba(255,255,255,0.85);
                }
                .amount-expected {
                    font-size: 22px;
                    font-weight: bold;
                    color: #fee140;
                    letter-spacing: 0.5px;
                }
                .amount-ok { color: #38ef7d; font-weight: bold; }
                .amount-bad { color: #ff6b6b; font-weight: bold; }
                .amount-pending { color: rgba(255,255,255,0.75); }
                .btn-check-amount {
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    width: 100%;
                    margin-top: 8px;
                }
                .btn-order-action { background: #fff3e0; color: #7a3e00; border: 1px solid #ffcc80; }
                .btn-audit-action { background: #ffebee; color: #b71c1c; border: 1px solid #ef9a9a; }
                .btn-auto-run { background: linear-gradient(135deg,#11998e,#38ef7d); color:#062b22; font-weight:bold; }
                .btn-auto-stop { background:#7f1d1d; color:#fff; }
                @media (max-width: 520px) {
                    #jdy-final-panel { left: 8px; right: 8px; top: 8px; width: auto; max-height: calc(100vh - 16px); }
                    .final-content { padding: 12px; }
                    .final-section { padding: 10px; margin-bottom: 10px; }
                    .final-header { padding: 10px 12px; }
                    .final-title { font-size: 14px; gap: 5px; }
                    .final-buttons { gap: 6px; }
                    .final-btn { padding: 9px 6px; font-size: 12px; }
                }
            </style>

            <div class="final-header" id="final-header">
                <div class="final-title">
                    <span>🎯</span>
                    <span>智能填充助手</span>
                    <span class="version-badge">API v13.3.1</span>
                </div>
                <button class="final-close" id="final-close">×</button>
            </div>

            <div class="final-content">
                <div class="order-type-switch">
                    <button class="type-btn active" id="btn-purchase">
                        <span>📦</span>
                        <span>采购订单</span>
                    </button>
                    <button class="type-btn" id="btn-sales">
                        <span>💰</span>
                        <span>销售订单</span>
                    </button>
                    <button class="type-btn" id="btn-warehouse">
                        <span>🏭</span>
                        <span>出入库</span>
                    </button>
                </div>

                <div class="final-section">
                    <div class="final-label">
                        <span>📅</span>
                        <span>单据日期</span>
                    </div>
                    <input type="date" class="final-date-input" id="input-date" value="${savedDate}">
                    <div class="final-hint">💡 智能填充前会先把这里的日期写入页面中的单据日期</div>
                </div>

                <div class="final-section" id="section-customer" style="display:none;">
                    <div class="final-label">
                        <span>🏢</span>
                        <span>客户</span>
                    </div>
                    <select class="final-date-input" id="input-customer">
                        <option value="">从订单备注自动读取客户</option>
                        ${salesCustomers.map(name => `<option value="${name}">${name}</option>`).join('')}
                    </select>
                    <div class="final-hint">💡 销售订单模式会自动将这里的客户写入页面中的客户输入框</div>
                </div>

                <div class="final-section" id="section-order-source">
                    <div class="final-label"><span>📂</span><span>本地订单队列</span></div>
                    <div id="source-order-status" class="final-hint">正在读取本地订单队列…</div>
                    <div class="final-buttons" style="margin-top:6px; grid-template-columns: 1fr auto; align-items:center;">
                        <div id="source-order-meta" class="final-hint"></div>
                        <button class="final-btn btn-paste" id="btn-copy-supplier" type="button">复制供应商名称</button>
                    </div>
                    <div class="final-buttons" style="margin-top:8px; grid-template-columns: 1fr 1fr 1fr;">
                        <button class="final-btn btn-paste" id="btn-load-orders" type="button">读取队列</button>
                        <button class="final-btn btn-refresh" id="btn-prev-order" type="button" disabled>上一单</button>
                        <button class="final-btn btn-refresh" id="btn-next-order" type="button" disabled>下一单</button>
                    </div>
                    <div class="final-hint">💡 切换只载入队列数据和日期，不会自动填充金蝶页面</div>
                </div>

                <div class="final-section" id="section-warehouse" style="display:none;">
                    <div class="final-label"><span>🏬</span><span>仓库</span></div>
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px;cursor:pointer;">
                        <input type="checkbox" id="input-warehouse-enabled"><span>自动填充仓库</span>
                    </label>
                    <input type="text" class="final-date-input" id="input-warehouse" value="01" placeholder="仓库名称或编号">
                    <div class="final-hint">默认只填单据日期；勾选后才填仓库。支持采购入库、销售出库、销售入库。</div>
                </div>

                <div class="final-section" id="section-codes">
                    <div class="final-label">
                        <span>🏷️</span>
                        <span>商品编码</span>
                    </div>
                    <textarea class="final-textarea" id="input-codes" placeholder="每行一个商品编码&#10;示例：&#10;2602Y0421&#10;运费"></textarea>
                    <div class="final-hint">💡 从Excel复制编码列；运费/#N/A 会按「运费」查找并优先选 BUD00052</div>
                    <div class="final-buttons" style="margin-top:8px; grid-template-columns: 1fr 1fr;">
                        <button class="final-btn btn-paste" id="btn-paste-codes" type="button">
                            <span>📋</span>
                            <span>粘贴编码</span>
                        </button>
                        <button class="final-btn btn-refresh" id="btn-fill-codes" type="button">
                            <span>🏷️</span>
                            <span>填充编码</span>
                        </button>
                    </div>
                </div>

                <div class="final-section" id="section-qty">
                    <div class="final-label">
                        <span>📝</span>
                        <span>数量数据</span>
                    </div>
                    <textarea class="final-textarea" id="input-qty" placeholder="每行一个数值，支持任意行数&#10;示例：&#10;10&#10;20&#10;30"></textarea>
                    <div class="final-hint">💡 从Excel复制所有数量列（支持45+行）</div>
                </div>

                <div class="final-section">
                    <div class="final-label">
                        <span>💰</span>
                        <span>含税单价</span>
                    </div>
                    <textarea class="final-textarea" id="input-price" placeholder="每行一个数值，支持任意行数&#10;示例：&#10;100.5&#10;200.75&#10;300.00"></textarea>
                    <div class="final-hint">💡 从Excel复制所有单价列（支持45+行）</div>
                </div>

                <div class="final-section" id="amount-check-section">
                    <div class="final-label">
                        <span>🧮</span>
                        <span>金额核对</span>
                    </div>
                    <div class="amount-check-row">
                        <span class="amount-check-label">预期总额 Σ(数量×单价)</span>
                        <span class="amount-expected" id="expected-total">0.00</span>
                    </div>
                    <div class="amount-check-row">
                        <span class="amount-check-label">有效行数</span>
                        <span id="expected-lines">0</span>
                    </div>
                    <div class="amount-check-row">
                        <span class="amount-check-label">页面成交金额</span>
                        <span id="deal-amount">—</span>
                    </div>
                    <div class="amount-check-row">
                        <span class="amount-check-label">差额</span>
                        <span id="amount-diff">—</span>
                    </div>
                    <div class="amount-check-row">
                        <span class="amount-check-label">状态</span>
                        <span id="amount-status" class="amount-pending">未核对</span>
                    </div>
                    <button class="final-btn btn-check-amount" id="btn-check-amount" type="button">
                        <span>✅</span>
                        <span>核对成交金额</span>
                    </button>
                    <div class="final-hint">💡 粘贴数量+单价后自动算预期；填充后点核对，或与页面「成交金额」比对（|差|≤0.01 视为一致）</div>
                </div>

                <div class="final-buttons">
                    <button class="final-btn btn-fill" id="btn-fill">
                        <span>🚀</span>
                        <span>智能填充</span>
                    </button>
                    <button class="final-btn btn-refresh" id="btn-repair-cells" type="button">
                        <span>🔧</span>
                        <span>逐格补填</span>
                    </button>
                    <button class="final-btn btn-paste" id="btn-paste-purchase">
                        <span>📋</span>
                        <span>粘贴数量+单价</span>
                    </button>
                    <button class="final-btn btn-refresh" id="btn-refresh">
                        <span>🔄</span>
                        <span>刷新检测</span>
                    </button>
                    <button class="final-btn btn-help" id="btn-help">
                        <span>❓</span>
                        <span>帮助</span>
                    </button>
                    <button class="final-btn btn-paste" id="btn-paste" style="display:none;">
                        <span>📋</span>
                        <span>粘贴单价</span>
                    </button>
                    <button class="final-btn btn-clear" id="btn-clear">
                        <span>🗑️</span>
                        <span>清空</span>
                    </button>
                </div>
                <div class="final-buttons" id="warehouse-actions" style="display:none;grid-template-columns:1fr;">
                    <button class="final-btn btn-fill" id="btn-warehouse-fill" type="button"><span>🚀</span><span>自动填充</span></button>
                </div>
                <div class="final-buttons" style="margin-top:8px; grid-template-columns:1fr 1fr;">
                    <button class="final-btn btn-order-action" id="btn-new-order" type="button">➕ 新建单据</button>
                    <button class="final-btn btn-audit-action" id="btn-audit-order" type="button">✅ 审核单据</button>
                </div>
                <div class="final-buttons" style="margin-top:8px; grid-template-columns:1fr;">
                    <button class="final-btn btn-auto-run" id="btn-auto-run" type="button">▶️ 启动自动录入全队列</button>
                </div>

                <div class="final-section" id="progress-section" style="display:none;">
                    <div class="final-label">
                        <span>📊</span>
                        <span>填充进度</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill" id="progress-fill" style="width: 0%">0%</div>
                    </div>
                    <div class="stats-box" id="stats-box">
                        <div class="stat-item">
                            <div class="stat-value" id="stat-qty">0</div>
                            <div>数量字段</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value" id="stat-price">0</div>
                            <div>单价字段</div>
                        </div>
                    </div>
                </div>

                <div class="final-section">
                    <div class="final-label">
                        <span>📜</span>
                        <span>操作日志</span>
                    </div>
                    <div class="final-log" id="final-log"></div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);
        return panel;
    }

    // 日志
    function log(msg, type = 'info') {
        const logDiv = document.getElementById('final-log');
        const emoji = { info: 'ℹ️', success: '✅', error: '❌', warn: '⚠️' };
        const item = document.createElement('div');
        item.className = 'log-item';
        item.textContent = `${emoji[type] || 'ℹ️'} ${msg}`;
        logDiv.appendChild(item);
        logDiv.scrollTop = logDiv.scrollHeight;
        console.log(`[填充] ${msg}`);
    }

    // 更新进度
    function updateProgress(current, total, qtyCount, priceCount) {
        const progressSection = document.getElementById('progress-section');
        const progressFill = document.getElementById('progress-fill');
        const statQty = document.getElementById('stat-qty');
        const statPrice = document.getElementById('stat-price');

        progressSection.style.display = 'block';
        const percent = Math.round((current / total) * 100);
        progressFill.style.width = percent + '%';
        progressFill.textContent = `${current}/${total} (${percent}%)`;

        statQty.textContent = qtyCount;
        statPrice.textContent = priceCount;
    }


    // ===== 金额核对（v13.3）=====
    function computeExpectedTotal() {
        const qtyEl = document.getElementById('input-qty');
        const priceEl = document.getElementById('input-price');
        const qtyLines = (qtyEl ? qtyEl.value : '').split(/\r?\n/);
        const priceLines = (priceEl ? priceEl.value : '').split(/\r?\n/);
        const n = Math.min(qtyLines.length, priceLines.length);
        let total = 0;
        let lines = 0;
        for (let i = 0; i < n; i++) {
            const qRaw = (qtyLines[i] || '').trim();
            const pRaw = (priceLines[i] || '').trim();
            if (!qRaw || !pRaw) continue;
            const q = parseFloat(qRaw.replace(/[^\d.-]/g, ''));
            const p = parseFloat(pRaw.replace(/[^\d.-]/g, ''));
            if (isNaN(q) || isNaN(p)) continue;
            total += q * p;
            lines += 1;
        }
        return { total, lines };
    }

    function resetAmountCheckUI() {
        const deal = document.getElementById('deal-amount');
        const diff = document.getElementById('amount-diff');
        const status = document.getElementById('amount-status');
        if (deal) deal.textContent = '—';
        if (diff) {
            diff.textContent = '—';
            diff.className = '';
        }
        if (status) {
            status.textContent = '未核对';
            status.className = 'amount-pending';
        }
    }

    function updateExpectedTotalUI() {
        const { total, lines } = computeExpectedTotal();
        const totalEl = document.getElementById('expected-total');
        const linesEl = document.getElementById('expected-lines');
        const sourceOrder = sourceOrders[sourceOrderIndex];
        const displayedTotal = orderType === 'sales' && sourceOrder?.salesTotal != null
            ? Number(sourceOrder.salesTotal)
            : total;
        if (totalEl) totalEl.textContent = displayedTotal.toFixed(2);
        if (linesEl) linesEl.textContent = String(lines);
        resetAmountCheckUI();
    }

    function parseMoneyText(raw) {
        if (raw == null) return NaN;
        let s = String(raw).replace(/\s+/g, '').replace(/,/g, '');
        s = s.replace(/[￥¥]/g, '');
        const m = s.match(/-?\d+(?:\.\d+)?/);
        if (!m) return NaN;
        return parseFloat(m[0]);
    }

    function readDealAmountFromPage() {
        // v13.3.1：优先整段匹配「本单成交金额：xxxx」，避免把旁边「折扣额 0」当成成交金额
        const DISCOUNT_RE = /折扣/;
        const LABEL_RE = /本单成交金额|成交金额|价税合计/;

        function isDiscountContext(text) {
            const t = String(text || '');
            // 含折扣且不含成交/价税 → 折扣上下文
            if (!DISCOUNT_RE.test(t)) return false;
            if (/本单成交金额|价税合计/.test(t)) return false;
            // 「折扣额」单独或与成交金额同区时，仍可能误读；交给更严规则
            return /折扣额|折扣金额|折扣合计/.test(t) && !/本单成交金额/.test(t);
        }

        function collectFromRegex(rootText) {
            const hits = [];
            const patterns = [
                /本单成交金额\s*[：:]\s*([\d,]+(?:\.\d+)?)/g,
                /成交金额\s*[：:]\s*([\d,]+(?:\.\d+)?)/g,
                /价税合计\s*[：:]\s*([\d,]+(?:\.\d+)?)/g
            ];
            for (const re of patterns) {
                let m;
                while ((m = re.exec(rootText)) !== null) {
                    const n = parseMoneyText(m[1]);
                    if (!isNaN(n)) {
                        const start = Math.max(0, m.index - 12);
                        const ctx = rootText.slice(start, m.index + m[0].length + 8);
                        hits.push({ n, pref: m[0].includes('本单') ? 3 : (m[0].includes('价税') ? 2 : 1), ctx });
                    }
                }
            }
            return hits;
        }

        // 1) 整页/页脚文本正则（最稳）
        const bodyText = (document.body && (document.body.innerText || document.body.textContent) || '').replace(/\u00a0/g, ' ');
        let hits = collectFromRegex(bodyText);
        // 只要有「本单成交金额」命中就优先用它（可含 0）
        const ben = hits.filter(h => h.pref === 3);
        if (ben.length) {
            // 取最后一次出现（页脚通常在后）
            return ben[ben.length - 1].n;
        }

        // 2) 在含标签的小节点上找同段数字，跳过折扣额
        const labels = ['本单成交金额', '成交金额', '价税合计'];
        const candidates = [];
        const nodes = Array.from(document.querySelectorAll('span, div, label, td, th, em, strong, p, li'));
        for (const el of nodes) {
            if (!el || (el.children && el.children.length > 12)) continue;
            const raw = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!raw || raw.length > 80) continue;
            if (!labels.some(l => raw.includes(l))) continue;
            if (isDiscountContext(raw) && !raw.includes('本单成交金额')) continue;

            // 同节点内「标签：金额」
            for (const label of labels) {
                const re = new RegExp(label + '\\s*[：:]\\s*([\\d,]+(?:\\.\\d+)?)');
                const m = raw.match(re);
                if (m) {
                    const n = parseMoneyText(m[1]);
                    if (!isNaN(n)) {
                        candidates.push({ n, pref: label.startsWith('本单') ? 3 : (label === '价税合计' ? 2 : 1), raw });
                    }
                }
            }

            // 邻近兄弟/父级输入，但排除折扣
            let parent = el.parentElement;
            for (let depth = 0; depth < 5 && parent; depth++) {
                const pt = (parent.innerText || parent.textContent || '').replace(/\s+/g, ' ');
                if (/折扣额|折扣金额/.test(pt) && !/本单成交金额/.test(pt)) {
                    parent = parent.parentElement;
                    continue;
                }
                const inputs = parent.querySelectorAll('input');
                for (const inp of inputs) {
                    if (!isElementVisible(inp)) continue;
                    const around = ((inp.parentElement && inp.parentElement.innerText) || '') + ' ' + (inp.getAttribute('aria-label') || '');
                    if (/折扣/.test(around) && !/成交金额|价税合计/.test(around)) continue;
                    const n = parseMoneyText(inp.value || inp.getAttribute('title'));
                    if (isNaN(n)) continue;
                    // 父级必须仍能看到成交/价税标签
                    if (!LABEL_RE.test(pt)) continue;
                    const pref = /本单成交金额/.test(pt) ? 3 : (/价税合计/.test(pt) ? 2 : 1);
                    candidates.push({ n, pref, raw: around || pt.slice(0, 40) });
                }
                parent = parent.parentElement;
            }
        }

        if (candidates.length) {
            candidates.sort((a, b) => b.pref - a.pref || Math.abs(b.n) - Math.abs(a.n));
            // 若最高优先级里既有 0 又有非 0，取非 0（折扣 0 干扰）
            const topPref = candidates[0].pref;
            const top = candidates.filter(c => c.pref === topPref);
            const nonzero = top.filter(c => Math.abs(c.n) > 0.0000001);
            return (nonzero.length ? nonzero[0] : top[0]).n;
        }

        // 3) 回退：正则命中的成交金额（非本单），取绝对值最大且非折扣上下文
        const weak = hits.filter(h => h.pref >= 1 && !isDiscountContext(h.ctx));
        if (weak.length) {
            weak.sort((a, b) => b.pref - a.pref || Math.abs(b.n) - Math.abs(a.n));
            const topPref = weak[0].pref;
            const top = weak.filter(c => c.pref === topPref);
            const nonzero = top.filter(c => Math.abs(c.n) > 0.0000001);
            return (nonzero.length ? nonzero[0] : top[0]).n;
        }
        return NaN;
    }

    function checkDealAmount() {
        const { total: expected, lines } = computeExpectedTotal();
        const expectedEl = document.getElementById('expected-total');
        const linesEl = document.getElementById('expected-lines');
        if (expectedEl) expectedEl.textContent = expected.toFixed(2);
        if (linesEl) linesEl.textContent = String(lines);

        let deal = readDealAmountFromPage();
        const dealEl = document.getElementById('deal-amount');
        const diffEl = document.getElementById('amount-diff');
        const statusEl = document.getElementById('amount-status');

        // 预期>0 却读到 0：几乎肯定误读了折扣额，按读失败处理，勿标「不一致」
        if (!isNaN(deal) && Math.abs(deal) < 0.0000001 && expected > 0.01) {
            log(`金额核对：读到成交金额=0 但预期=${expected.toFixed(2)}，疑似误读折扣额，按未读到处理`, 'warn');
            deal = NaN;
        }

        if (isNaN(deal)) {
            if (dealEl) dealEl.textContent = '未读到';
            if (diffEl) {
                diffEl.textContent = '—';
                diffEl.className = '';
            }
            if (statusEl) {
                statusEl.textContent = '未核对（请看页面本单成交金额）';
                statusEl.className = 'amount-pending';
            }
            log(`金额核对：预期=${expected.toFixed(2)}（${lines}行），页面成交金额未读到；请以页脚「本单成交金额」为准`, 'warn');
            return { consistent: false, expected: Number(expected.toFixed(2)), deal: null, difference: null, lines, status: 'unread' };
        }

        const diff = deal - expected;
        const absDiff = Math.abs(diff);
        const ok = absDiff <= 0.01;
        if (dealEl) dealEl.textContent = deal.toFixed(2);
        if (diffEl) {
            diffEl.textContent = (diff >= 0 ? '+' : '') + diff.toFixed(2);
            diffEl.className = ok ? 'amount-ok' : 'amount-bad';
        }
        if (statusEl) {
            statusEl.textContent = ok ? '✅一致' : '❌不一致';
            statusEl.className = ok ? 'amount-ok' : 'amount-bad';
        }
        log(
            `金额核对：预期=${expected.toFixed(2)} 成交=${deal.toFixed(2)} 差额=${diff.toFixed(2)} → ${ok ? '一致' : '不一致'}（${lines}行）`,
            ok ? 'success' : 'error'
        );
        return { consistent: ok, expected: Number(expected.toFixed(2)), deal: Number(deal.toFixed(2)), difference: Number(diff.toFixed(2)), lines, status: ok ? 'consistent' : 'mismatch' };
    }

    const ORDER_QUEUE_URL = 'http://127.0.0.1:8766/api/orders';
    const CONTROL_COMMAND_URL = 'http://127.0.0.1:8766/api/jdy/command';
    const CONTROL_RESULT_URL = 'http://127.0.0.1:8766/api/jdy/result';
    let lastControlCommandId = 0;

    function postControlResult(payload) {
        GM_xmlhttpRequest({ method: 'POST', url: CONTROL_RESULT_URL, data: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } });
    }
    function controlRequest(method, url, data) {
        return new Promise((resolve, reject) => GM_xmlhttpRequest({ method, url, data: data ? JSON.stringify(data) : undefined, headers: data ? { 'Content-Type': 'application/json' } : undefined, onload: r => r.status >= 200 && r.status < 300 ? resolve(JSON.parse(r.responseText || '{}')) : reject(new Error(`HTTP ${r.status}`)), onerror: () => reject(new Error('本地控制服务连接失败')) }));
    }

    async function executeControlCommand(command) {
        const action = command.action;
        if (action === 'status') return { orderIndex: sourceOrderIndex, orderCount: sourceOrders.length, orderType, order: sourceOrders[sourceOrderIndex] || null };
        if (action === 'load-orders') return requestSourceOrders();
        if (action === 'next-order') return loadSourceOrder(sourceOrderIndex + 1);
        if (action === 'previous-order') return loadSourceOrder(sourceOrderIndex - 1);
        if (action === 'switch-type') return switchOrderType(command.type || 'purchase');
        if (action === 'fill-codes') return fillCodesFromTextarea();
        if (action === 'paste-codes') return pasteCodes();
        if (action === 'paste-quantity-price') return pastePurchaseData();
        if (action === 'paste-price') return pasteToPrice();
        if (action === 'smart-fill') return smartFillData();
        if (action === 'warehouse-fill') return runWarehouseFill();
        if (action === 'repair') return runRepairCellsOnly();
        if (action === 'check-amount') return checkDealAmount();
        if (action === 'clear') return clearData();
        if (action === 'refresh') return detectRows();
        if (action === 'new-order') return clickKingdeeAction('new');
        if (action === 'auto-run') return startAutoRun();
        if (action === 'auto-stop') { stopAutoRun('收到停止命令'); return { stopped: true }; }
        if (action === 'audit') {
            const amount = checkDealAmount();
            if (!amount || amount.consistent !== true) throw new Error(`金额未核对一致，已阻止审核（预期 ${amount?.expected ?? '—'}，页面 ${amount?.deal ?? '—'}，差额 ${amount?.difference ?? '—'}）`);
            return clickKingdeeAction('audit');
        }
        throw new Error(`未知接口动作：${action}`);
    }

    function clickKingdeeAction(actionKey) {
        const config = {
            new: { label: '新增', selector: '[data-opk="new"]' },
            audit: { label: '审核', selector: '[data-opk="audit"]' }
        }[actionKey];
        if (!config) throw new Error('不支持的金蝶工具栏动作：' + actionKey);
        // 金蝶工具栏项是带 data-opk 的 div，不是 button；同一动作可能有隐藏副本。
        const candidates = [...document.querySelectorAll(config.selector)].filter(el =>
            el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none'
        );
        if (candidates.length !== 1) throw new Error('金蝶“' + config.label + '”工具栏项' + (candidates.length ? '有多个可见节点' : '当前不可见或不存在') + '；未执行操作');
        candidates[0].click();
        log('已点击金蝶“' + config.label + '”；如页面弹出确认窗口，请在金蝶页面完成确认。', 'info');
        return { clicked: true, action: config.label, selector: config.selector };
    }

    function getCurrentBillNo() {
        const input = document.querySelector('#billno input');
        return input ? String(input.value || '').trim() : '';
    }

    function waitForCondition(check, timeoutMs, intervalMs = 250) {
        return new Promise(resolve => {
            const deadline = Date.now() + timeoutMs;
            const poll = () => {
                let value = false;
                try { value = check(); } catch (_) {}
                if (value) return resolve(value);
                if (Date.now() >= deadline) return resolve(false);
                setTimeout(poll, intervalMs);
            };
            poll();
        });
    }

    function stopAutoRun(reason) {
        autoRunActive = false;
        const button = document.getElementById('btn-auto-run');
        if (button) { button.disabled = false; button.textContent = '▶️ 启动自动录入全队列'; button.classList.remove('btn-auto-stop'); }
        if (reason) log('自动录入已停止：' + reason, 'warn');
    }

    async function startAutoRun() {
        if (autoRunActive) { stopAutoRun('用户手动停止'); return { stopped: true }; }
        if (sourceOrders.length === 0 || sourceOrderIndex < 0) throw new Error('请先读取订单队列');
        if (!['purchase', 'sales'].includes(orderType)) throw new Error('当前订单类型不支持自动录入');
        const formId = [...document.querySelectorAll('[data-form-id]')].find(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')?.getAttribute('data-form-id') || '';
        // if (!/pur_bill_order|sal_bill_order|purchase.*order|sales.*order/i.test(formId)) {
        //     throw new Error('请先打开金蝶采购订单或销售订单录入界面，再启动自动录入');
        // }
        const accepted = confirm('将从队列第 ' + (sourceOrderIndex + 1) + '/' + sourceOrders.length + ' 单开始自动录入。每单依次填编码、智能填充、核对金额；金额一致才审核，审核完成后新建并载入下一单。遇到任何错误会暂停。启动后请保持页面打开。继续？');
        if (!accepted) return { started: false, cancelled: true };
        autoRunActive = true;
        const button = document.getElementById('btn-auto-run');
        if (button) { button.textContent = '⏹ 停止自动录入'; button.classList.add('btn-auto-stop'); }
        const startIndex = sourceOrderIndex;
        log('开始自动录入：从队列第 ' + (startIndex + 1) + '/' + sourceOrders.length + ' 单开始', 'info');
        try {
            for (let index = startIndex; index < sourceOrders.length && autoRunActive; index++) {
                if (sourceOrderIndex !== index) {
                    const loaded = loadSourceOrder(index);
                    if (!loaded.success) throw new Error(loaded.error || '载入订单失败');
                }
                const order = sourceOrders[index];
                log('自动录入 ' + (index + 1) + '/' + sourceOrders.length + '：' + order.orderNo + ' / ' + order.supplier, 'info');
                const codeOk = await fillCodesFromTextarea();
                if (!autoRunActive) break;
                if (codeOk !== true) throw new Error('订单 ' + order.orderNo + ' 编码未全部填充成功，已暂停');
                const fillResult = await smartFillData();
                if (!autoRunActive) break;
                if (!fillResult?.success) throw new Error('订单 ' + order.orderNo + ' 智能填充未确认成功，已暂停');
                const amount = checkDealAmount();
                if (!amount || amount.consistent !== true) throw new Error('订单 ' + order.orderNo + ' 金额不一致或无法读取（预期 ' + (amount?.expected ?? '—') + '，成交 ' + (amount?.deal ?? '—') + '），已暂停');
                const beforeAudit = getCurrentBillNo();
                clickKingdeeAction('audit');
                const audited = await waitForCondition(() => {
                    const mark = [...document.querySelectorAll('[data-opk="unaudit"], [data-opk="unAudit"]')].some(el => el.getClientRects().length);
                    const auditor = document.querySelector('[data-id="auditorid"] input');
                    return mark || (auditor && auditor.value && auditor.value !== '-');
                }, 12000);
                if (!audited) throw new Error('订单 ' + order.orderNo + ' 已触发审核，但未确认完成；已暂停');
                if (!autoRunActive) break;
                clickKingdeeAction('new');
                const created = await waitForCondition(() => {
                    const billNo = getCurrentBillNo();
                    const supplier = document.querySelector('[data-id="supplierid"] input');
                    return billNo && billNo !== beforeAudit && supplier && !String(supplier.value || '').trim() ? { billNo } : false;
                }, 12000);
                if (!created) throw new Error('订单 ' + order.orderNo + ' 已点击新建，但未确认新单据；已暂停');
                log('订单 ' + order.orderNo + ' 已审核，新单据 ' + created.billNo + ' 已就绪', 'success');
                if (index + 1 >= sourceOrders.length) {
                    stopAutoRun('队列已全部完成');
                    return { completed: true, completedOrders: index - startIndex + 1 };
                }
                const next = loadSourceOrder(index + 1);
                if (!next.success) throw new Error(next.error || '下一单载入失败');
                await sleep(500);
            }
            return { completed: false, stopped: !autoRunActive, currentIndex: sourceOrderIndex };
        } catch (error) {
            stopAutoRun(error.message);
            throw error;
        } finally {
            if (autoRunActive) stopAutoRun('自动流程结束');
        }
    }

    let commandPollInFlight = false;
    function pollControlCommand() {
        if (commandPollInFlight) return;
        commandPollInFlight = true;
        GM_xmlhttpRequest({ method: 'GET', url: CONTROL_COMMAND_URL, timeout: 5000, onload: response => {
            try {
                const command = JSON.parse(response.responseText || '{}');
                if (!command.id || command.id <= lastControlCommandId) { commandPollInFlight = false; return; }
                lastControlCommandId = command.id;
                Promise.resolve(executeControlCommand(command)).then(data => postControlResult({ id: command.id, action: command.action, success: true, data: data ?? null })).catch(error => postControlResult({ id: command.id, action: command.action, success: false, error: error.message }));
            } catch (error) { /* 保持人工按钮可用 */ }
            commandPollInFlight = false;
        }, onerror: () => { commandPollInFlight = false; }, ontimeout: () => { commandPollInFlight = false; }});
    }

    window.jdyAssistant = { execute: executeControlCommand, status: () => ({ orderIndex: sourceOrderIndex, orderCount: sourceOrders.length, orderType }) };
    function updateSourceOrderStatus(message) {
        const el = document.getElementById('source-order-status'); if (el) el.textContent = message;
        const prev = document.getElementById('btn-prev-order'); const next = document.getElementById('btn-next-order');
        if (prev) prev.disabled = sourceOrderIndex <= 0;
        if (next) next.disabled = sourceOrderIndex < 0 || sourceOrderIndex >= sourceOrders.length - 1;
    }
    function loadSourceOrder(index) {
        if (index < 0 || index >= sourceOrders.length) return { success: false, error: '订单索引超出队列范围', index, orderCount: sourceOrders.length };
        const order = sourceOrders[index]; const lines = Array.isArray(order.lines) ? order.lines : [];
        document.getElementById('input-date').value = order.date || savedDate; savedDate = order.date || savedDate;
        selectedSalesCustomer = String(order.salesCustomer || '');
        document.getElementById('input-customer').value = selectedSalesCustomer;
        document.getElementById('source-order-meta').textContent = `供应商：${order.supplier || '—'} · 供应商结算价格：${order.settlementPrice ?? '—'}`;
        document.getElementById('input-codes').value = lines.map(line => line.code || '').join('\n');
        document.getElementById('input-qty').value = lines.map(line => line.qty ?? '').join('\n');
        document.getElementById('input-price').value = lines.map(line => {
            const price = orderType === 'sales' ? line.salesPrice : line.price;
            return price == null || price === '' ? '' : Number(price).toFixed(5);
        }).join('\n');
        sourceOrderIndex = index; updateExpectedTotalUI();
        const expectedLabel = orderType === 'sales'
            ? `预期 ${order.salesLineTotal ?? '—'} · 精实价格总计 ${order.salesTotal ?? '—'}`
            : `预期 ${order.expectedTotal ?? '—'} · 供应商结算价格 ${order.settlementPrice ?? '—'}`;
        updateSourceOrderStatus(`第 ${index + 1}/${sourceOrders.length} 单：${order.orderNo} · ${order.supplier} · ${order.date || '—'} · ${expectedLabel}`);
        log(`已载入队列第 ${index + 1} 单：${order.orderNo} / ${order.supplier}（${lines.length} 行）`, 'success');
        return { success: true, index, orderCount: sourceOrders.length, orderNo: order.orderNo, supplier: order.supplier, date: order.date, lines: lines.length, expectedTotal: order.expectedTotal, settlementPrice: order.settlementPrice, salesLineTotal: order.salesLineTotal, salesTotal: order.salesTotal };
    }
    function requestSourceOrders() {
        updateSourceOrderStatus('正在读取本地订单队列…');
        return new Promise((resolve, reject) => GM_xmlhttpRequest({method:'GET', url:ORDER_QUEUE_URL, timeout:10000,
            onload: response => { try { if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`); const orders=JSON.parse(response.responseText); if (!Array.isArray(orders) || !orders.length) throw new Error('队列为空或格式不正确'); sourceOrders=orders; resolve(loadSourceOrder(0)); } catch(e) { updateSourceOrderStatus(`读取失败：${e.message}`); log(`读取本地订单队列失败：${e.message}`,'error'); reject(e); } },
            onerror: () => { updateSourceOrderStatus('连接失败，请先启动本地订单服务'); log('无法连接本地订单服务（127.0.0.1:8766）','error'); reject(new Error('无法连接本地订单服务')); },
            ontimeout: () => { updateSourceOrderStatus('连接超时，请确认本地订单服务正在运行'); log('读取本地订单队列超时','error'); reject(new Error('读取订单队列超时')); }
        }));
    }

    // 解析数据
    function parseData() {
        const qtyText = document.getElementById('input-qty').value.trim();
        const priceText = document.getElementById('input-price').value.trim();

        orderData.quantities = qtyText.split('\n')
            .map(l => l.trim())
            .filter(l => l)
            .map(l => parseFloat(l.replace(/[^\d.-]/g, '')))
            .filter(n => !isNaN(n));

        orderData.prices = priceText.split('\n')
            .map(l => l.trim())
            .filter(l => l)
            .map(l => parseFloat(l.replace(/[^\d.-]/g, '')))
            .filter(n => !isNaN(n));

        log(`解析完成：数量${orderData.quantities.length}条，单价${orderData.prices.length}条`, 'success');
        const ok = orderData.quantities.length > 0 || orderData.prices.length > 0;
        if (ok) updateExpectedTotalUI();
        return ok;
    }

    // 通过AG-Grid API或点击单元格填充
    async function fillCellViaApi(rowIndex, field, value, cellName) {
        return new Promise((resolve) => {
            try {
                const api = getGridApi();
                if (!api) {
                    log(`${cellName} - API不可用`, 'error');
                    resolve(false);
                    return;
                }

                // 获取行节点
                const rowNode = api.getDisplayedRowAtIndex(rowIndex);
                if (!rowNode) {
                    log(`${cellName} - 行${rowIndex}不存在`, 'error');
                    resolve(false);
                    return;
                }

                log(`${cellName} - 开始编辑 (rowIndex=${rowIndex}, field=${field})`, 'info');

                // 方法1：尝试使用AG-Grid API
                api.startEditingCell({
                    rowIndex: rowIndex,
                    colKey: field
                });

                // 等待编辑器激活
                setTimeout(() => {
                    let input = document.querySelector('input:focus');

                    // 如果API方式失败，尝试点击单元格（销售订单需要）
                    if (!input) {
                        log(`${cellName} - API方式失败，尝试点击单元格`, 'info');

                        // 获取所有该列的单元格，并按DOM顺序排列
                        const allRows = [];
                        api.forEachNode((node) => {
                            if (node.data && node.data.materialid && node.data.materialid !== '') {
                                allRows.push(node.rowIndex);
                            }
                        });

                        // 找到当前rowIndex在有效行中的位置
                        const targetPosition = allRows.indexOf(rowIndex);

                        if (targetPosition === -1) {
                            log(`${cellName} - 无法找到行位置`, 'error');
                            resolve(false);
                            return;
                        }

                        // 查找目标单元格 - 根据位置来匹配
                        const cells = Array.from(document.querySelectorAll(`[role="gridcell"][col-id="${field}"]`));
                        // 过滤出数据行（排除表头等）
                        const dataCells = cells.filter(cell => {
                            const text = cell.textContent.trim();
                            // 数据单元格通常包含数字或为空
                            return text.match(/^\d+(\.\d+)?$/) || text === '';
                        });

                        const targetCell = dataCells[targetPosition];

                        if (targetCell) {
                            log(`${cellName} - 找到单元格(位置${targetPosition})，执行点击`, 'info');
                            targetCell.click();

                            // 再次检查输入框
                            setTimeout(() => {
                                input = document.querySelector('input:focus');

                                if (input) {
                                    log(`${cellName} - 点击后编辑器已激活`, 'info');

                                    // 填充值
                                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                                        window.HTMLInputElement.prototype,
                                        'value'
                                    ).set;
                                    nativeInputValueSetter.call(input, value.toString());

                                    input.dispatchEvent(new Event('input', { bubbles: true }));
                                    input.dispatchEvent(new Event('change', { bubbles: true }));
                                    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
                                    input.blur();

                                    log(`${cellName} - 已填充并保存`, 'info');
                                    resolve(true);
                                } else {
                                    log(`${cellName} - 点击后仍无法激活编辑器`, 'error');
                                    resolve(false);
                                }
                            }, 100);
                        } else {
                            log(`${cellName} - 未找到目标单元格(位置${targetPosition})`, 'error');
                            resolve(false);
                        }
                        return; // 重要：在异步回调前返回，避免继续执行
                    }

                    // API方式成功激活了编辑器
                    log(`${cellName} - 编辑器已激活`, 'info');

                    // 使用React兼容的方式设置值
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype,
                        'value'
                    ).set;
                    nativeInputValueSetter.call(input, value.toString());

                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));

                    // 停止编辑（保存值）
                    setTimeout(() => {
                        api.stopEditing();
                        log(`${cellName} - 已保存`, 'info');
                        resolve(true);
                    }, 50);
                }, 100);

            } catch (error) {
                log(`${cellName} - 错误: ${error.message}`, 'error');
                resolve(false);
            }
        });
    }

    // 检测表格行数
    function detectRows() {
        gridApi = null;

        const api = getGridApi();
        if (api) {
            const allRows = [];
            api.forEachNode((node) => {
                if (node.data) {
                    const materialid = node.data.materialid;
                    if (materialid && materialid !== '') {
                        allRows.push({
                            rowIndex: node.rowIndex,
                            materialid: Array.isArray(materialid) ? materialid[0] : materialid
                        });
                    }
                }
            });

            log(`🔍 检测到表格共有 ${allRows.length} 个有效商品行`, 'info');

            if (allRows.length > 0) {
                const preview = allRows.slice(0, 5).map(r => r.materialid).join(', ');
                log(`📦 商品预览：${preview}${allRows.length > 5 ? '...' : ''}`, 'info');
            }

            return allRows.length;
        }

        const domTable = detectDomTable();
        if (!domTable) {
            log('无法获取表格数据结构（AG-Grid 或 DOM）', 'error');
            return 0;
        }

        const allRows = domTable.validRows.map(r => r.materialid).filter(Boolean);
        log(`🔍 检测到表格共有 ${domTable.validRows.length} 个有效商品行`, 'info');
        if (allRows.length > 0) {
            const preview = allRows.slice(0, 5).join(', ');
            log(`📦 商品预览：${preview}${allRows.length > 5 ? '...' : ''}`, 'info');
        }
        return domTable.validRows.length;
    }

    function detectDomTable() {
        const activeRoot = getActiveKdTableRoot();
        const tables = getVisibleTables();
        const headerTable = tables.find(t => {
            const tr = t.querySelector('thead tr');
            if (!tr) return false;
            return t.querySelector('[data-col-id=\"qty\"]') && t.querySelector('[data-col-id=\"taxprice\"]') && t.querySelector('[data-col-id=\"materialid\"]');
        });

        if (!headerTable) return null;

        const theadTr = headerTable.querySelector('thead tr');
        const ths = Array.from(theadTr ? theadTr.querySelectorAll('th') : []);
        if (!ths.length) return null;

        const findThIndex = (colId) => {
            return ths.findIndex(th => th.querySelector(`[data-col-id=\"${colId}\"]`));
        };

        const thMeta = (th) => {
            const colEl = th.querySelector('[data-col-id]');
            const colId = colEl ? (colEl.getAttribute('data-col-id') || '') : (th.getAttribute('data-col-id') || '');
            const text = (th.textContent || '').replace(/\s+/g, '');
            return { colId, text };
        };

        // 税率列：必须是 cess / 含「税率」，且绝不能是税额(taxamount)
        const findTaxRateIndex = () => {
            let byId = -1;
            let byText = -1;
            ths.forEach((th, i) => {
                const { colId, text } = thMeta(th);
                if (colId === 'taxamount' || text.includes('税额')) return;
                if (colId === 'cess' && byId < 0) byId = i;
                if ((text.includes('增值税税率') || text.includes('税率')) && byText < 0) byText = i;
            });
            return byId >= 0 ? byId : byText;
        };

        const qtyIndex = findThIndex('qty');
        const taxIndex = findThIndex('taxprice');
        const materialIndex = findThIndex('materialid');
        const taxAmountIndex = findThIndex('taxamount');
        const cessIndex = findTaxRateIndex();
        // 双重保险：若算出的「税率」下标其实是税额列，直接作废
        if (cessIndex >= 0 && taxAmountIndex >= 0 && cessIndex === taxAmountIndex) {
            // leave as -1 below
        }
        let safeCessIndex = cessIndex;
        if (safeCessIndex >= 0) {
            const { colId, text } = thMeta(ths[safeCessIndex]);
            if (colId === 'taxamount' || text.includes('税额') || (taxAmountIndex >= 0 && safeCessIndex === taxAmountIndex)) {
                safeCessIndex = -1;
            }
        }
        if (qtyIndex === -1 || taxIndex === -1) return null;

        let bodyTable = null;
        let bestBodyRows = -1;
        const maxIndex = Math.max(qtyIndex, taxIndex, materialIndex, safeCessIndex, taxAmountIndex);

        for (const t of tables) {
            if (activeRoot && !activeRoot.contains(t)) continue;
            const tbodyRows = Array.from(t.querySelectorAll('tbody tr'));
            if (!tbodyRows.length) continue;
            const firstTds = tbodyRows[0] ? Array.from(tbodyRows[0].querySelectorAll('td')) : [];
            if (firstTds.length <= maxIndex) continue;
            if (tbodyRows.length > bestBodyRows) {
                bestBodyRows = tbodyRows.length;
                bodyTable = t;
            }
        }

        if (!bodyTable) return null;

        const tbodyRows = Array.from(bodyTable.querySelectorAll('tbody tr'));
        const validRows = [];
        for (const tr of tbodyRows) {
            const tds = Array.from(tr.querySelectorAll('td'));
            const materialCell = materialIndex >= 0 ? tds[materialIndex] : null;
            const materialid = materialCell ? (materialCell.textContent || '').trim() : '';
            if (materialid) validRows.push({ tr, materialid, tds });
        }

        return { root: activeRoot, headerTable, bodyTable, qtyIndex, taxIndex, materialIndex, cessIndex: safeCessIndex, taxAmountIndex, validRows };
    }

    function findDomScrollContainer(domTable = null) {
        const activeRoot = (domTable && domTable.root) || getActiveKdTableRoot();
        const searchScope = activeRoot || document;
        const preferred = activeRoot && Array.from(activeRoot.querySelectorAll('.kd-table-body, .kd-virtual, div'))
            .find(el => isElementVisible(el) && (String(el.className || '').includes('kd-table-body') || el.scrollHeight > el.clientHeight + 10));
        if (preferred) return preferred;

        const divs = Array.from(searchScope.querySelectorAll('div')).filter(isElementVisible);
        let best = null;
        let bestScore = -1;
        for (const el of divs) {
            try {
                const style = window.getComputedStyle(el);
                const ovy = style.overflowY;
                const scrollable = el.scrollHeight > el.clientHeight + 10;
                if (!scrollable) continue;
                const score = (el.scrollHeight - el.clientHeight) + (el.getBoundingClientRect().height > 0 ? 0.1 : 0);
                if (score > bestScore) {
                    if (ovy === 'auto' || ovy === 'scroll' || String(el.className || '').includes('kd-table')) {
                        bestScore = score;
                        best = el;
                    }
                }
            } catch (e) {}
        }
        return best;
    }

    // 获取虚拟滚动表格的总行数
    async function getTotalRowCount() {
        const domTable = detectDomTable();
        const wrap = findDomScrollContainer(domTable);
        if (!wrap) return 0;

        // 滚动到底部
        for (let i = 0; i < 3; i++) {
            wrap.scrollTop = wrap.scrollHeight;
            wrap.dispatchEvent(new Event('scroll', { bubbles: true }));
            await new Promise(r => setTimeout(r, 200));
        }
        await new Promise(r => setTimeout(r, 300));

        // 读取最大行号
        const currentTable = detectDomTable();
        const tbody = currentTable && currentTable.bodyTable ? currentTable.bodyTable.querySelector('tbody') : null;
        if (!tbody) return 0;

        const rows = Array.from(tbody.querySelectorAll('tr'));
        const rowNumbers = rows.map(tr => {
            const firstCell = tr.querySelector('td');
            const num = firstCell ? firstCell.textContent.trim() : '';
            return num ? parseInt(num) : 0;
        }).filter(n => n > 0);

        return rowNumbers.length > 0 ? Math.max(...rowNumbers) : 0;
    }

    // 滚动到指定行号
    async function scrollToRow(targetRowNum) {
        const domTable = detectDomTable();
        const wrap = findDomScrollContainer(domTable);
        if (!wrap) return false;

        // 逐步滚动直到目标行可见（不回到顶部）
        for (let attempt = 0; attempt < 100; attempt++) {
            const currentTable = detectDomTable();
            const tbody = currentTable && currentTable.bodyTable ? currentTable.bodyTable.querySelector('tbody') : null;
            if (!tbody) return false;

            const rows = Array.from(tbody.querySelectorAll('tr'));
            const rowNumbers = rows.map(tr => {
                const firstCell = tr.querySelector('td');
                const num = firstCell ? firstCell.textContent.trim() : '';
                return num ? parseInt(num) : 0;
            }).filter(n => n > 0);

            if (rowNumbers.length === 0) return false;

            const minRow = Math.min(...rowNumbers);
            const maxRow = Math.max(...rowNumbers);

            // 目标行在可见范围内
            if (targetRowNum >= minRow && targetRowNum <= maxRow) {
                return true;
            }

            // 需要继续滚动
            if (targetRowNum > maxRow) {
                // 目标行在下方，向下滚动
                wrap.scrollTop += 100;
            } else {
                // 目标行在上方，向上滚动
                wrap.scrollTop -= 100;
            }
            wrap.dispatchEvent(new Event('scroll', { bubbles: true }));
            await new Promise(r => setTimeout(r, 150));
        }

        return false;
    }

    async function ensureDomRowsLoaded(desiredCount) {
        let lastCount = -1;
        let stableCount = 0;

        for (let i = 0; i < 20; i++) {
            const domTable = detectDomTable();
            const curCount = domTable && domTable.validRows ? domTable.validRows.length : 0;

            log(`🔄 滚动加载第${i+1}次：当前${curCount}行，目标${desiredCount}行`, 'info');

            if (curCount >= desiredCount) {
                log(`✅ 已加载足够行数：${curCount}行`, 'success');
                return domTable;
            }

            if (curCount === lastCount) {
                stableCount++;
                if (stableCount >= 3) {
                    log(`⚠️ 行数稳定在${curCount}行，停止滚动`, 'warn');
                    return domTable;
                }
            } else {
                stableCount = 0;
            }

            const wrap = findDomScrollContainer(domTable);
            if (wrap) {
                wrap.scrollTop = wrap.scrollHeight;
                wrap.dispatchEvent(new Event('scroll', { bubbles: true }));
                await new Promise(r => setTimeout(r, 200));
                wrap.scrollTop = wrap.scrollHeight;
                wrap.dispatchEvent(new Event('scroll', { bubbles: true }));
            }

            lastCount = curCount;
            await new Promise(r => setTimeout(r, 500));
        }

        const finalTable = detectDomTable();
        const finalCount = finalTable && finalTable.validRows ? finalTable.validRows.length : 0;
        log(`📊 最终加载${finalCount}行`, finalCount >= desiredCount ? 'success' : 'warn');
        return finalTable;
    }

    function readCellColId(td) {
        if (!td) return '';
        const inner = td.querySelector('[data-col-id]');
        if (inner) return inner.getAttribute('data-col-id') || '';
        return td.getAttribute('data-col-id') || '';
    }

    async function fillCellViaDomTable(rowInfo, colIndex, value, cellName, expectedColId) {
        const cell = rowInfo && rowInfo.tds ? rowInfo.tds[colIndex] : null;
        if (!cell) {
            log(`${cellName} - DOM列不存在`, 'error');
            return false;
        }

        const actualColId = readCellColId(cell);
        // 硬规则：永远不要写入税额列
        if (actualColId === 'taxamount' || (expectedColId && expectedColId !== 'taxamount' && actualColId === 'taxamount')) {
            log(`${cellName} - 拒绝写入税额列(taxamount)，跳过`, 'error');
            return false;
        }
        if (expectedColId && actualColId && actualColId !== expectedColId) {
            log(`${cellName} - 列错位：期望 ${expectedColId}，实际 ${actualColId}，跳过`, 'error');
            return false;
        }
        // 税率写入再保险：无 expected 时也不许写进 taxamount；有 expected=cess 时必须匹配
        if (String(cellName || '').includes('税率') && actualColId && actualColId !== 'cess') {
            log(`${cellName} - 非税率列(${actualColId || 'unknown'})，跳过写 13`, 'error');
            return false;
        }

        cell.click();

        const valueString = value.toString();
        const maxTry = 20;
        for (let tryIndex = 0; tryIndex < maxTry; tryIndex++) {
            await new Promise(r => setTimeout(r, 50));

            let input = document.querySelector('input:focus');
            if (!input) input = document.querySelector('textarea:focus');
            if (!input) input = cell.querySelector('input, textarea');
            if (!input) {
                const focused = document.querySelector('[contenteditable=\"true\"]:focus');
                if (focused) {
                    focused.focus();
                    focused.textContent = valueString;
                    focused.dispatchEvent(new Event('input', { bubbles: true }));
                    focused.dispatchEvent(new Event('change', { bubbles: true }));
                    focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
                    focused.blur();
                    log(`${cellName} - 已填充并保存`, 'info');
                    return true;
                }
            }

            if (input) {
                const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                nativeInputValueSetter.call(input, valueString);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
                input.blur();
                log(`${cellName} - 已填充并保存`, 'info');
                return true;
            }
        }

        log(`${cellName} - 点击后未找到编辑器输入框`, 'error');
        return false;
    }

    function getVisibleBodyRows(domTable) {
        if (!domTable || !domTable.bodyTable) return [];
        const tbody = domTable.bodyTable.querySelector('tbody');
        if (!tbody) return [];
        const materialIndex = domTable.materialIndex;
        const rows = [];
        for (const tr of Array.from(tbody.querySelectorAll('tr'))) {
            const tds = Array.from(tr.querySelectorAll('td'));
            if (!tds.length) continue;
            const first = (tds[0].textContent || '').trim();
            const rowNum = parseInt(first, 10);
            if (!rowNum || isNaN(rowNum)) continue;
            const materialCell = materialIndex >= 0 ? tds[materialIndex] : null;
            const materialid = materialCell ? (materialCell.textContent || '').trim() : '';
            rows.push({ tr, tds, rowNum, materialid });
        }
        return rows;
    }

    function parseCodesFromText(text) {
        const lines = String(text || '').split(/\r?\n/);
        const codes = [];
        for (const raw of lines) {
            // 去纯空行；含 tab 时取第一列作为编码
            if (!String(raw || '').trim()) continue;
            let line = raw;
            if (line.includes('\t')) {
                line = line.split('\t')[0];
            }
            line = (line || '').trim();
            const upper = line.toUpperCase();
            // 空编码 / #N/A / 运费 → 统一按名称「运费」查找（优先 BUD00052）
            if (!line || upper === '#N/A' || upper === 'N/A' || line === '运费') {
                codes.push('运费');
            } else {
                codes.push(line);
            }
        }
        return codes;
    }

    function findDropdownOptionNodes() {
        const panel = document.getElementById('jdy-final-panel');
        const candidates = [];
        const selectors = [
            '[role="listbox"] [role="option"]',
            '[role="option"]',
            'li[role="option"]',
            '.ant-select-item-option',
            '.ant-select-dropdown .ant-select-item',
            '.kd-select-dropdown li',
            '.kd-dropdown li',
            '.kd-cascader-menu-item',
            '[class*="dropdown"] li',
            '[class*="select"] li',
            '[class*="popup"] li',
            '[class*="cascader"] li',
            '[class*="kd-"] li'
        ];
        for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
                if (panel && panel.contains(el)) continue;
                if (!isElementVisible(el)) continue;
                const t = (el.textContent || '').trim();
                if (!t) continue;
                candidates.push(el);
            }
        }
        // de-dupe
        return Array.from(new Set(candidates));
    }

    async function waitForDropdownOptions(timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const opts = findDropdownOptionNodes();
            if (opts.length) return opts;
            await new Promise(r => setTimeout(r, 100));
        }
        return [];
    }

    function pickMaterialOption(options, searchText) {
        if (!options.length) return null;
        if (searchText === '运费') {
            const bud = options.find(el => (el.textContent || '').includes('BUD00052'));
            if (bud) return bud;
            const freight = options.filter(el => {
                const t = (el.textContent || '').replace(/\s+/g, ' ');
                return t.includes('运费') && !/RL\d+/i.test(t) && !t.includes('规格');
            });
            if (freight.length) return freight[0];
            const anyFreight = options.find(el => (el.textContent || '').includes('运费'));
            if (anyFreight) return anyFreight;
            return null;
        }
        const exactish = options.filter(el => (el.textContent || '').includes(searchText));
        if (exactish.length === 1) return exactish[0];
        if (exactish.length > 1) return exactish[0];
        if (options.length === 1) return options[0];
        return options[0];
    }

    async function fillMaterialViaDom(rowInfo, searchText) {
        const cellName = `行${rowInfo.rowNum}-商品编码`;
        if (!rowInfo || rowInfo.tds == null) {
            log(`${cellName} - 行信息无效`, 'error');
            return false;
        }
        const domTable = detectDomTable();
        if (!domTable || domTable.materialIndex < 0) {
            log(`${cellName} - 未找到商品编码列`, 'error');
            return false;
        }
        const cell = rowInfo.tds[domTable.materialIndex];
        if (!cell) {
            log(`${cellName} - DOM列不存在`, 'error');
            return false;
        }

        cell.click();
        let input = null;
        for (let tryIndex = 0; tryIndex < 30; tryIndex++) {
            await new Promise(r => setTimeout(r, 50));
            input = document.querySelector('input:focus') ||
                document.querySelector('textarea:focus') ||
                cell.querySelector('input, textarea');
            if (!input) {
                const focused = document.querySelector('[contenteditable="true"]:focus');
                if (focused) {
                    focused.focus();
                    focused.textContent = searchText;
                    focused.dispatchEvent(new Event('input', { bubbles: true }));
                    focused.dispatchEvent(new Event('change', { bubbles: true }));
                    input = focused;
                    break;
                }
            } else {
                break;
            }
        }

        if (!input) {
            log(`${cellName} - 点击后未找到编辑器`, 'error');
            return false;
        }

        if (input.isContentEditable || input.getAttribute('contenteditable') === 'true') {
            input.focus();
            input.textContent = searchText;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            nativeInputValueSetter.call(input, searchText);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        let options = await waitForDropdownOptions(2500);
        if (!options.length) {
            // try Enter/Tab to trigger search/select
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
            await new Promise(r => setTimeout(r, 300));
            options = await waitForDropdownOptions(1500);
            if (!options.length) {
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', keyCode: 9, bubbles: true }));
                log(`${cellName} - 未出现下拉，已尝试 Enter/Tab（search=${searchText}）`, 'warn');
                return false;
            }
        }

        let chosen = pickMaterialOption(options, searchText);
        if (!chosen) {
            log(`${cellName} - 下拉无匹配项（search=${searchText}）`, 'error');
            return false;
        }
        if (searchText !== '运费') {
            const matchCount = options.filter(el => (el.textContent || '').includes(searchText)).length;
            if (matchCount === 0 && options.length > 1) {
                log(`${cellName} - 无精确匹配，点击第一项：${(chosen.textContent || '').trim().slice(0, 40)}`, 'warn');
            }
        } else if (!(chosen.textContent || '').includes('BUD00052')) {
            log(`${cellName} - 运费未找到 BUD00052，选用：${(chosen.textContent || '').trim().slice(0, 40)}`, 'warn');
        }

        chosen.click();
        await new Promise(r => setTimeout(r, 150));
        log(`${cellName} - 已选择「${(chosen.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)}」`, 'success');
        return true;
    }

    function setCodeFillButtonsDisabled(disabled) {
        const ids = ['btn-paste-codes', 'btn-fill-codes', 'btn-fill', 'btn-repair-cells', 'btn-paste-purchase', 'btn-paste'];
        for (const id of ids) {
            const el = document.getElementById(id);
            if (el) el.disabled = disabled;
        }
    }

    async function fillCodesFromList(codes) {
        if (!codes || !codes.length) {
            log('没有可填充的商品编码', 'error');
            return false;
        }
        if (isFilling) {
            log('正在填充中，请勿重复操作', 'warn');
            return false;
        }

        isFilling = true;
        setCodeFillButtonsDisabled(true);
        log('==================== 开始填充商品编码 ====================', 'info');
        log(`📋 共 ${codes.length} 条编码`, 'info');

        let ok = 0;
        let fail = 0;
        try {
            const firstTable = detectDomTable();
            if (!firstTable || firstTable.materialIndex < 0) {
                log('未检测到商品编码列，请确认已打开采购订单明细表', 'error');
                return false;
            }

            // probe max visible row after scrolling toward end once
            let maxRow = 0;
            for (let i = 0; i < codes.length; i++) {
                const targetRowNum = i + 1;
                const searchText = codes[i];
                log(`➡️ 填充第 ${targetRowNum}/${codes.length} 行：${searchText}`, 'info');

                const scrolled = await scrollToRow(targetRowNum);
                if (!scrolled) {
                    log(`行${targetRowNum} - 滚动定位失败`, 'warn');
                }

                const currentTable = detectDomTable();
                if (!currentTable || currentTable.materialIndex < 0) {
                    log(`行${targetRowNum} - 表格丢失`, 'error');
                    fail++;
                    continue;
                }

                const visible = getVisibleBodyRows(currentTable);
                if (visible.length) {
                    maxRow = Math.max(maxRow, ...visible.map(r => r.rowNum));
                }
                if (maxRow > 0 && targetRowNum > maxRow && !visible.some(r => r.rowNum === targetRowNum)) {
                    // try one more bottom scroll to discover more empty rows
                    const wrap = findDomScrollContainer(currentTable);
                    if (wrap) {
                        wrap.scrollTop = wrap.scrollHeight;
                        wrap.dispatchEvent(new Event('scroll', { bubbles: true }));
                        await new Promise(r => setTimeout(r, 250));
                    }
                }

                const table2 = detectDomTable();
                const visible2 = getVisibleBodyRows(table2);
                if (visible2.length) {
                    maxRow = Math.max(maxRow, ...visible2.map(r => r.rowNum));
                }
                const rowInfo = visible2.find(r => r.rowNum === targetRowNum);
                if (!rowInfo) {
                    if (maxRow > 0 && targetRowNum > maxRow) {
                        log(`⚠️ 行数不足（可见最大行号 ${maxRow}，需要 ${codes.length}），请先在金蝶加够空行`, 'warn');
                    } else {
                        log(`行${targetRowNum} - 可见行中未找到该行号`, 'error');
                    }
                    fail++;
                    // still continue for remaining that might be visible? usually stop making sense if rows missing
                    continue;
                }

                const result = await fillMaterialViaDom(rowInfo, searchText);
                if (result) ok++; else fail++;
                await new Promise(r => setTimeout(r, 280 + Math.floor(Math.random() * 120)));
            }

            if (codes.length > maxRow && maxRow > 0) {
                log(`⚠️ 编码条数 ${codes.length} 大于可见最大行号 ${maxRow}，请先在金蝶加够空行`, 'warn');
            }
            log(`==================== 编码填充完成：成功 ${ok}，失败 ${fail} ====================`, ok && !fail ? 'success' : 'warn');
            return fail === 0;
        } catch (error) {
            log(`编码填充出错: ${error.message}`, 'error');
            return false;
        } finally {
            isFilling = false;
            setCodeFillButtonsDisabled(false);
        }
    }

    async function pasteCodes() {
        try {
            const text = await navigator.clipboard.readText();
            if (!text) {
                log('剪贴板为空', 'warn');
                return;
            }
            const codes = parseCodesFromText(text);
            document.getElementById('input-codes').value = codes.join('\n');
            log(`📋 已粘贴 ${codes.length} 条商品编码`, 'success');
            await fillCodesFromList(codes);
        } catch (err) {
            log('无法读取剪贴板，请手动粘贴到编码框后点「填充编码」', 'error');
            const box = document.getElementById('input-codes');
            if (box) box.focus();
        }
    }

    async function fillCodesFromTextarea() {
        const text = document.getElementById('input-codes').value;
        const codes = parseCodesFromText(text);
        if (!codes.length) {
            log('请先在商品编码框输入或粘贴编码', 'error');
            alert('⚠️ 请先输入商品编码！');
            return;
        }
        return await fillCodesFromList(codes);
    }

    function readNumericFromCell(td) {
        if (!td) return NaN;
        const input = td.querySelector('input, textarea');
        if (input && input.value != null && String(input.value).trim() !== '') {
            const n = parseFloat(String(input.value).replace(/,/g, ''));
            if (!isNaN(n)) return n;
        }
        const titled = td.querySelector('[title]');
        const titleCandidates = [
            td.getAttribute('title'),
            titled ? titled.getAttribute('title') : null
        ];
        for (const t of titleCandidates) {
            if (t != null && String(t).trim() !== '') {
                const n = parseFloat(String(t).replace(/,/g, ''));
                if (!isNaN(n)) return n;
            }
        }
        const text = (td.textContent || '').trim().replace(/,/g, '');
        if (!text) return NaN;
        const n = parseFloat(text);
        return isNaN(n) ? NaN : n;
    }

    function numbersClose(a, b) {
        if (a == null || b == null || isNaN(a) || isNaN(b)) return false;
        const abs = Math.abs(Number(a) - Number(b));
        if (abs < 0.0001) return true;
        const denom = Math.max(Math.abs(Number(a)), Math.abs(Number(b)), 1e-12);
        return (abs / denom) < 1e-6;
    }

    async function repairMismatchedQtyPrice(isSalesOrder) {
        const dataCount = isSalesOrder
            ? orderData.prices.length
            : Math.max(orderData.quantities.length, orderData.prices.length);
        if (!dataCount) {
            log('逐格补写：无价量数据', 'warn');
            return { fixed: 0, stillBad: [] };
        }

        let tableRows = await getTotalRowCount();
        const api = getGridApi();
        const apiRows = [];
        if (api) {
            api.forEachNode((node) => {
                if (node.data) {
                    const materialid = node.data.materialid;
                    if (materialid && materialid !== '') {
                        apiRows.push({
                            rowIndex: node.rowIndex,
                            materialid: Array.isArray(materialid) ? materialid[0] : materialid
                        });
                    }
                }
            });
            if (apiRows.length) tableRows = Math.max(tableRows || 0, apiRows.length);
        }

        const N = Math.min(dataCount, tableRows || dataCount);
        let fixed = 0;
        const stillBad = [];
        const fixedRows = new Set();

        log(`开始逐格核对补写（共 ${N} 行）`, 'info');

        for (let i = 0; i < N; i++) {
            const targetRowNum = i + 1;
            const expectQty = (!isSalesOrder && i < orderData.quantities.length)
                ? Number(orderData.quantities[i]) : null;
            const expectPrice = (i < orderData.prices.length)
                ? Number(orderData.prices[i]) : null;

            await scrollToRow(targetRowNum);
            await new Promise(r => setTimeout(r, 80));

            let current = detectDomTable();
            if (!current) {
                stillBad.push(targetRowNum);
                log(`行${targetRowNum} 逐格补写：表格不可见`, 'error');
                continue;
            }

            const findRow = (table) => {
                if (!table) return null;
                return (table.validRows || []).find(r => {
                    const firstCell = r.tr.querySelector('td');
                    const rowNum = firstCell ? parseInt(firstCell.textContent.trim(), 10) : 0;
                    return rowNum === targetRowNum;
                }) || getVisibleBodyRows(table).find(r => r.rowNum === targetRowNum) || null;
            };

            let rowInfo = findRow(current);
            if (!rowInfo) {
                stillBad.push(targetRowNum);
                log(`行${targetRowNum} 逐格补写：找不到行`, 'error');
                continue;
            }

            async function readFieldValue(field, colIndex) {
                if (api && apiRows[i]) {
                    try {
                        const node = api.getDisplayedRowAtIndex(apiRows[i].rowIndex);
                        if (node && node.data && node.data[field] != null && node.data[field] !== '') {
                            const n = parseFloat(String(node.data[field]).replace(/,/g, ''));
                            if (!isNaN(n)) return n;
                        }
                    } catch (e) { /* ignore */ }
                }
                current = detectDomTable() || current;
                rowInfo = findRow(current) || rowInfo;
                if (colIndex >= 0 && rowInfo && rowInfo.tds[colIndex]) {
                    return readNumericFromCell(rowInfo.tds[colIndex]);
                }
                return NaN;
            }

            async function ensureField(field, expected, colIndex, expectedColId, label) {
                if (expected == null || isNaN(expected)) return true;
                let matched = false;
                let didRewrite = false;
                for (let attempt = 1; attempt <= 5; attempt++) {
                    const curVal = await readFieldValue(field, colIndex);
                    if (numbersClose(curVal, expected)) {
                        matched = true;
                        if (didRewrite) {
                            log(`行${targetRowNum}-${label} 补写成功 = ${expected}`, 'success');
                        }
                        break;
                    }
                    didRewrite = true;
                    log(`行${targetRowNum}-${label} 不匹配 当前=${isNaN(curVal) ? '?' : curVal} 期望=${expected}，逐格重写(${attempt}/5)`, 'warn');

                    let ok = false;
                    if (api && apiRows[i]) {
                        ok = await fillCellViaApi(apiRows[i].rowIndex, field, expected, `行${targetRowNum}-${label}-补写`);
                    }
                    if (!ok) {
                        current = detectDomTable() || current;
                        rowInfo = findRow(current) || rowInfo;
                        if (colIndex >= 0 && rowInfo) {
                            ok = await fillCellViaDomTable(
                                rowInfo,
                                colIndex,
                                expected,
                                `行${targetRowNum}-${label}-补写`,
                                expectedColId
                            );
                        }
                    }
                    await new Promise(r => setTimeout(r, 120));
                }
                if (!matched) {
                    const finalVal = await readFieldValue(field, colIndex);
                    if (numbersClose(finalVal, expected)) {
                        matched = true;
                        log(`行${targetRowNum}-${label} 补写成功 = ${expected}`, 'success');
                    } else {
                        log(`行${targetRowNum}-${label} 逐格补写仍失败 当前=${isNaN(finalVal) ? '?' : finalVal} 期望=${expected}`, 'error');
                    }
                }
                if (matched && didRewrite) {
                    fixedRows.add(targetRowNum);
                }
                return matched;
            }

            let rowOk = true;
            if (!isSalesOrder && expectQty != null) {
                const ok = await ensureField('qty', expectQty, current.qtyIndex, 'qty', '数量');
                if (!ok) rowOk = false;
            }
            if (expectPrice != null) {
                // refresh col indexes after possible scroll/rerender
                current = detectDomTable() || current;
                const ok = await ensureField('taxprice', expectPrice, current.taxIndex, 'taxprice', '单价');
                if (!ok) rowOk = false;
            }
            if (!rowOk) stillBad.push(targetRowNum);
        }

        fixed = fixedRows.size;
        if (fixed) log(`逐格补写：已修复 ${fixed} 行`, 'success');
        if (stillBad.length) log(`逐格补写：仍失败行 ${stillBad.join(',')}`, 'error');
        else log('逐格补写：全部核对通过', 'success');
        return { fixed, stillBad };
    }

    async function repairLeakedTaxAmount() {
        const table = detectDomTable();
        if (!table || table.taxAmountIndex < 0) {
            log('税额修复：未找到 taxamount 列，跳过', 'info');
            return;
        }
        const taxAmountIndex = table.taxAmountIndex;
        const taxIndex = table.taxIndex;
        const qtyIndex = table.qtyIndex;
        let fixed = 0;
        const totalRows = await getTotalRowCount();
        const limit = totalRows || table.validRows.length;
        for (let i = 0; i < limit; i++) {
            const targetRowNum = i + 1;
            await scrollToRow(targetRowNum);
            const current = detectDomTable();
            if (!current || current.taxAmountIndex < 0) continue;
            const rowInfo = (current.validRows || []).find(r => {
                const firstCell = r.tr.querySelector('td');
                const rowNum = firstCell ? parseInt(firstCell.textContent.trim(), 10) : 0;
                return rowNum === targetRowNum;
            }) || getVisibleBodyRows(current).find(r => r.rowNum === targetRowNum);
            if (!rowInfo) continue;
            const tds = rowInfo.tds;
            const amtIdx = current.taxAmountIndex;
            const amtCell = tds[amtIdx];
            if (!amtCell) continue;
            const amtText = (amtCell.textContent || '').trim().replace(/,/g, '');
            const amt = parseFloat(amtText);
            if (!(amt === 13 || amt === 13.0 || amtText === '13' || amtText === '13.00' || amtText === '13.0')) continue;
            // 用含税价×数量估算税额；若远小于 13，判定为税率误写入税额
            let taxprice = NaN, qty = NaN;
            if (taxIndex >= 0 && tds[taxIndex]) {
                taxprice = parseFloat((tds[taxIndex].textContent || '').trim().replace(/,/g, ''));
            }
            if (qtyIndex >= 0 && tds[qtyIndex]) {
                qty = parseFloat((tds[qtyIndex].textContent || '').trim().replace(/,/g, ''));
            }
            let expectTax = NaN;
            if (!isNaN(taxprice) && !isNaN(qty) && qty > 0) {
                // 含税价合计 * 13/113
                expectTax = taxprice * qty * 13 / 113;
            }
            if (!isNaN(expectTax) && expectTax >= 10) {
                // 真实税额也可能接近 13，不乱动
                continue;
            }
            log(`行${targetRowNum} 税额=${amtText} 疑似税率泄露(估税额=${isNaN(expectTax) ? '?' : expectTax.toFixed(4)})，清空税额让系统重算`, 'warn');
            const ok = await clearTaxAmountCell(rowInfo, amtIdx, targetRowNum);
            if (ok) fixed++;
            await new Promise(r => setTimeout(r, 80));
        }
        if (fixed) log(`税额修复：已清空 ${fixed} 行误写税额`, 'success');
        else log('税额修复：未发现需清空的 13', 'info');
    }

    async function clearTaxAmountCell(rowInfo, colIndex, targetRowNum) {
        const cell = rowInfo && rowInfo.tds ? rowInfo.tds[colIndex] : null;
        if (!cell) return false;
        const colId = readCellColId(cell);
        if (colId && colId !== 'taxamount') {
            log(`行${targetRowNum}-清空税额 - 目标不是 taxamount(${colId})，放弃`, 'error');
            return false;
        }
        cell.click();
        const maxTry = 20;
        for (let tryIndex = 0; tryIndex < maxTry; tryIndex++) {
            await new Promise(r => setTimeout(r, 50));
            let input = document.querySelector('input:focus') || document.querySelector('textarea:focus') || cell.querySelector('input, textarea');
            if (!input) continue;
            const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            nativeInputValueSetter.call(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
            input.blur();
            log(`行${targetRowNum}-清空税额 - 已清空`, 'info');
            return true;
        }
        log(`行${targetRowNum}-清空税额 - 未找到编辑器`, 'error');
        return false;
    }

    // 主填充函数
    async function smartFillData() {
        if (!parseData()) {
            log('请先输入数据！', 'error');
            return { success: false, error: '没有有效的数量或单价数据' };
        }

        if (isFilling) {
            log('正在填充中，请勿重复操作', 'warn');
            return { success: false, error: '已有填充任务正在运行' };
        }

        gridApi = null;
        syncSavedDateFromInput();
        let api = getGridApi();
        for (let i = 0; i < 20 && !api; i++) {
            await new Promise(r => setTimeout(r, 100));
            api = getGridApi();
        }
        const useApi = !!api;

        isFilling = true;
        setCodeFillButtonsDisabled(true);

        const isSalesOrder = orderType === 'sales';
        log('==================== 开始智能填充 ====================', 'info');
        log(`📋 订单类型：${isSalesOrder ? '销售订单' : '采购订单'}`, 'info');
        log(useApi ? '✨ 使用AG-Grid API直接操作数据' : '✨ API不可用，使用DOM降级填充', 'info');

        try {
            if (isSalesOrder) {
                log(`输入数据：单价${orderData.prices.length}条`, 'info');
                if (orderData.prices.length === 0) {
                    log('销售订单模式需要输入含税单价数据！', 'error');
                    return { success: false, error: '销售订单缺少含税单价' };
                }
            } else {
                log(`输入数据：数量${orderData.quantities.length}条，单价${orderData.prices.length}条`, 'info');
            }

            const totalDataCount = isSalesOrder ? orderData.prices.length : Math.max(orderData.quantities.length, orderData.prices.length);
            await applyDocumentDate();
            if (isSalesOrder) {
                const customerOk = await applySalesCustomer();
                if (!customerOk) return { success: false, error: '销售客户未成功选择，已停止商品填充' };
            } else {
                await applyQueueSupplier();
            }

            let filledCount = 0;
            let qtySuccessCount = 0;
            let priceSuccessCount = 0;

            if (useApi) {
                const allRows = [];
                api.forEachNode((node) => {
                    if (node.data) {
                        const materialid = node.data.materialid;
                        if (materialid && materialid !== '') {
                            allRows.push({
                                rowIndex: node.rowIndex,
                                materialid: Array.isArray(materialid) ? materialid[0] : materialid
                            });
                        }
                    }
                });

                log(`表格中共有 ${allRows.length} 个有效商品行`, 'info');

                if (allRows.length < totalDataCount) {
                    log(`⚠️ 警告：商品行(${allRows.length})少于输入数据(${totalDataCount})`, 'warn');
                }

                for (let i = 0; i < Math.min(allRows.length, totalDataCount); i++) {
                    const rowInfo = allRows[i];
                    const rowIndex = rowInfo.rowIndex;
                    log(`━━━ 第${i+1}行 (${rowInfo.materialid}) ━━━`, 'info');

                    if (isSalesOrder) {
                        if (i < orderData.prices.length) {
                            const result = await fillCellViaApi(rowIndex, 'taxprice', orderData.prices[i], `行${i+1}-单价`);
                            if (result) {
                                priceSuccessCount++;
                                log(`行${i+1} 单价=${orderData.prices[i]} ✓`, 'success');
                            }
                            await new Promise(r => setTimeout(r, 100));
                        }
                    } else {
                        if (i < orderData.quantities.length) {
                            const result = await fillCellViaApi(rowIndex, 'qty', orderData.quantities[i], `行${i+1}-数量`);
                            if (result) {
                                qtySuccessCount++;
                                log(`行${i+1} 数量=${orderData.quantities[i]} ✓`, 'success');
                            }
                            await new Promise(r => setTimeout(r, 100));
                        }

                        if (i < orderData.prices.length) {
                            const result = await fillCellViaApi(rowIndex, 'taxprice', orderData.prices[i], `行${i+1}-单价`);
                            if (result) {
                                priceSuccessCount++;
                                log(`行${i+1} 单价=${orderData.prices[i]} ✓`, 'success');
                            }
                            await new Promise(r => setTimeout(r, 100));
                        }
                    }

                    filledCount++;
                    updateProgress(filledCount, Math.min(allRows.length, totalDataCount), qtySuccessCount, priceSuccessCount);
                }
            } else {
                // 获取表格总行数
                log('检测表格总行数...', 'info');
                const totalRows = await getTotalRowCount();
                log(`表格共有 ${totalRows} 行数据`, 'info');

                if (totalRows === 0) {
                    log('无法检测表格行数', 'error');
                    alert('❌ 无法检测表格行数');
                    return;
                }

                if (totalRows < totalDataCount) {
                    log(`⚠️ 警告：表格行数(${totalRows})少于输入数据(${totalDataCount})`, 'warn');
                }

                // 获取列索引
                const domTable = detectDomTable();
                if (!domTable) {
                    log('无法识别表格列结构', 'error');
                    alert('❌ 无法识别表格列结构');
                    return;
                }

                const limit = Math.min(totalRows, totalDataCount);

                // 逐行滚动并填充
                for (let i = 0; i < limit; i++) {
                    const targetRowNum = i + 1;

                    // 滚动到目标行
                    const scrolled = await scrollToRow(targetRowNum);
                    if (!scrolled) {
                        log(`无法滚动到第${targetRowNum}行`, 'error');
                        continue;
                    }

                    // 重新获取当前可见的行
                    const currentTable = detectDomTable();
                    if (!currentTable) continue;

                    // 在可见行中查找目标行
                    const rowInfo = currentTable.validRows.find(r => {
                        const firstCell = r.tr.querySelector('td');
                        const rowNum = firstCell ? parseInt(firstCell.textContent.trim()) : 0;
                        return rowNum === targetRowNum;
                    });

                    if (!rowInfo) {
                        log(`第${targetRowNum}行不在可见范围`, 'warn');
                        continue;
                    }

                    log(`━━━ 第${targetRowNum}行 (${rowInfo.materialid}) ━━━`, 'info');

                    // 先填充税率13（只写 cess；列错位或落到 taxamount 则跳过）
                    const rateIdx = (currentTable.cessIndex >= 0) ? currentTable.cessIndex : domTable.cessIndex;
                    if (rateIdx >= 0) {
                        const rateCell = rowInfo.tds[rateIdx];
                        const rateColId = readCellColId(rateCell);
                        if (rateColId && rateColId !== 'cess') {
                            log(`行${targetRowNum}-税率 - 跳过：目标列是 ${rateColId} 不是 cess`, 'warn');
                        } else {
                            await fillCellViaDomTable(rowInfo, rateIdx, 13, `行${targetRowNum}-税率`, 'cess');
                            await new Promise(r => setTimeout(r, 100));
                        }
                    }

                    if (isSalesOrder) {
                        if (i < orderData.prices.length) {
                            const result = await fillCellViaDomTable(rowInfo, currentTable.taxIndex >= 0 ? currentTable.taxIndex : domTable.taxIndex, orderData.prices[i], `行${targetRowNum}-单价`, 'taxprice');
                            if (result) {
                                priceSuccessCount++;
                                log(`行${targetRowNum} 单价=${orderData.prices[i]} ✓`, 'success');
                            }
                            await new Promise(r => setTimeout(r, 100));
                        }
                    } else {
                        if (i < orderData.quantities.length) {
                            const result = await fillCellViaDomTable(rowInfo, currentTable.qtyIndex >= 0 ? currentTable.qtyIndex : domTable.qtyIndex, orderData.quantities[i], `行${targetRowNum}-数量`, 'qty');
                            if (result) {
                                qtySuccessCount++;
                                log(`行${targetRowNum} 数量=${orderData.quantities[i]} ✓`, 'success');
                            }
                            await new Promise(r => setTimeout(r, 100));
                        }

                        if (i < orderData.prices.length) {
                            const result = await fillCellViaDomTable(rowInfo, currentTable.taxIndex >= 0 ? currentTable.taxIndex : domTable.taxIndex, orderData.prices[i], `行${targetRowNum}-单价`, 'taxprice');
                            if (result) {
                                priceSuccessCount++;
                                log(`行${targetRowNum} 单价=${orderData.prices[i]} ✓`, 'success');
                            }
                            await new Promise(r => setTimeout(r, 100));
                        }
                    }

                    filledCount++;
                    updateProgress(filledCount, limit, qtySuccessCount, priceSuccessCount);
                }
            }

            // 首轮批量填完后：逐格核对数量/含税单价，错行单个重写（不轻易放弃）
            try {
                log('开始逐格核对补写', 'info');
                await repairMismatchedQtyPrice(isSalesOrder);
            } catch (e) {
                log(`逐格补写跳过：${e && e.message ? e.message : e}`, 'warn');
            }

            // 修复：税额列误写成 13（税率泄露）时清空税额，让系统按含税价重算
            try {
                await repairLeakedTaxAmount();
            } catch (e) {
                log(`税额修复跳过：${e && e.message ? e.message : e}`, 'warn');
            }

            // 金额核对：预期 Σ(数量×单价) vs 页面成交金额
            try {
                checkDealAmount();
            } catch (e) {
                log(`金额核对跳过：${e && e.message ? e.message : e}`, 'warn');
            }

            log('==================== 填充完成 ====================', 'success');
            log(`✅ 成功填充 ${filledCount} 行`, 'success');
            if (isSalesOrder) {
                log(`📊 单价字段：${priceSuccessCount}个`, 'success');
            } else {
                log(`📊 数量字段：${qtySuccessCount}个，单价字段：${priceSuccessCount}个`, 'success');
            }
            log('💾 请按 Ctrl+S 保存订单', 'warn');
            const expectedQtyFields = isSalesOrder ? 0 : Math.min(totalDataCount, filledCount);
            const expectedPriceFields = Math.min(orderData.prices.length, filledCount);
            const fieldsOk = (isSalesOrder || qtySuccessCount >= expectedQtyFields) && priceSuccessCount >= expectedPriceFields;
            return { success: fieldsOk && filledCount > 0, filledCount, qtySuccessCount, priceSuccessCount, expectedQtyFields, expectedPriceFields };
        } catch (error) {
            log(`填充出错: ${error.message}`, 'error');
            alert(`❌ 填充出错：${error.message}`);
            return { success: false, error: error.message };
        } finally {
            isFilling = false;
            setCodeFillButtonsDisabled(false);
        }
    }

    // 清空
    function clearData() {
        document.getElementById('input-qty').value = '';
        document.getElementById('input-price').value = '';
        const codesBox = document.getElementById('input-codes');
        if (codesBox) codesBox.value = '';
        orderData.quantities = [];
        orderData.prices = [];
        document.getElementById('progress-section').style.display = 'none';
        updateExpectedTotalUI();
        log('已清空数据', 'info');

        // 如果是销售订单模式，提示用户刷新
        if (orderType === 'sales') {
            log('💡 提示：销售订单切换商品后建议刷新页面', 'warn');
        }
    }

    function syncSavedDateFromInput() {
        const input = document.getElementById('input-date');
        if (!input) return savedDate;
        if (input.value && /^\d{4}-\d{2}-\d{2}$/.test(input.value)) {
            savedDate = input.value;
        } else {
            input.value = savedDate;
        }
        return savedDate;
    }

    function findDocumentDateInput() {
        const isDateText = (value) => /^\d{4}-\d{2}-\d{2}$/.test((value || '').trim());
        const findVisibleInput = (root) => Array.from(root.querySelectorAll('input[data-field="field"], input[type="text"], input[type="date"], input'))
            .find(inp => isElementVisible(inp) && (isDateText(inp.value) || inp.type === 'date'));

        for (const el of Array.from(document.querySelectorAll('*'))) {
            if ((el.textContent || '').trim() !== '单据日期') continue;
            let parent = el.parentElement;
            for (let i = 0; i < 6 && parent; i++) {
                const matched = findVisibleInput(parent);
                if (matched) return matched;
                parent = parent.parentElement;
            }
        }

        return findVisibleInput(document) || null;
    }

    function findCustomerInput() {
        const input = document.querySelector('[data-id="customerid"] input');
        return input && isElementVisible(input) && !input.disabled && !input.readOnly ? input : null;
    }

    async function applyDocumentDate() {
        const targetDate = syncSavedDateFromInput();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
            log('❌ 日期格式无效，请使用 YYYY-MM-DD', 'error');
            return false;
        }

        const dateInput = findDocumentDateInput();
        if (!dateInput) {
            log('❌ 未找到单据日期输入框', 'error');
            return false;
        }

        try {
            dateInput.click();
            dateInput.focus();

            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                'value'
            ).set;
            nativeInputValueSetter.call(dateInput, targetDate);
            dateInput.dispatchEvent(new Event('input', { bubbles: true }));
            dateInput.dispatchEvent(new Event('change', { bubbles: true }));
            dateInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
            dateInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
            dateInput.blur();
            await new Promise(resolve => setTimeout(resolve, 150));
            log(`📅 单据日期已设置为 ${targetDate}`, 'success');
            return true;
        } catch (error) {
            log(`❌ 单据日期填充失败：${error.message}`, 'error');
            return false;
        }
    }

    async function applySalesCustomer() {
        const customerInputValue = String(sourceOrders[sourceOrderIndex]?.salesCustomer || selectedSalesCustomer || '').trim();
        if (!customerInputValue.trim()) {
            log('❌ 当前队列单备注未映射到销售客户，已停止客户填充；请检查 Excel「备注」列', 'error');
            return false;
        }

        const customerInput = findCustomerInput();
        if (!customerInput) {
            log('❌ 未找到客户输入框', 'error');
            return false;
        }

        try {
            const customerControl = customerInput.closest('[data-id="customerid"]');
            const isCustomerBound = () => String(customerInput.value || '').trim() === customerInputValue &&
                customerInput.getAttribute('title') === customerInputValue &&
                !!customerControl?.querySelector('.kdfont-chakanjichuziliao');
            if (isCustomerBound()) {
                log(`🏢 客户已是绑定状态：${customerInputValue}`, 'success');
                return true;
            }

            for (let attempt = 1; attempt <= 3; attempt++) {
                customerInput.click();
                customerInput.focus();
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype,
                    'value'
                ).set;
                nativeInputValueSetter.call(customerInput, customerInputValue);
                customerInput.dispatchEvent(new Event('input', { bubbles: true }));
                customerInput.dispatchEvent(new Event('change', { bubbles: true }));
                // 候选搜索是异步的；轮询最多 3 秒，避免固定延时遇到慢响应时误判失败。
                let matched = null;
                await waitForCondition(() => {
                    // 按候选名称精确匹配，等待金蝶异步搜索完成。
                    const options = [...document.querySelectorAll('.basedata-lookup-list li [title], [role="option"], li, .ant-select-item, [class*="option"], [class*="Option"]')]
                        .filter(el => isElementVisible(el) && (el.getAttribute('title') || (el.textContent || '')).replace(/\s+/g, ' ').trim() === customerInputValue);
                    matched = options.length === 1 ? options[0] : null;
                    return !!matched;
                }, 3000, 100);
                if (!matched) {
                    log(`⚠️ 第 ${attempt}/3 次未等到唯一客户候选：${customerInputValue}`, 'warn');
                    continue;
                }
                const rect = matched.getBoundingClientRect();
                // Tampermonkey 的隔离世界 Window 不能用作 PointerEvent.view；省略 view 让事件使用页面默认视图。
                const eventOptions = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
                // 金蝶客户资料列表依赖指针/鼠标按下和抬起完成绑定；click() 单事件只会关闭列表并清空输入。
                if (typeof PointerEvent === 'function') {
                    matched.dispatchEvent(new PointerEvent('pointerdown', { ...eventOptions, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
                }
                matched.dispatchEvent(new MouseEvent('mousedown', eventOptions));
                if (typeof PointerEvent === 'function') {
                    matched.dispatchEvent(new PointerEvent('pointerup', { ...eventOptions, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
                }
                matched.dispatchEvent(new MouseEvent('mouseup', eventOptions));
                matched.dispatchEvent(new MouseEvent('click', eventOptions));
                const selected = await waitForCondition(isCustomerBound, 2500, 100);
                if (selected) {
                    log(`🏢 客户已设置并确认绑定：${customerInputValue}`, 'success');
                    return true;
                }
                log(`⚠️ 第 ${attempt}/3 次点选后未确认客户绑定，当前输入值：${String(customerInput.value || '').trim() || '空'}`, 'warn');
                }
            log(`❌ 重试 3 次后仍未能绑定客户：${customerInputValue}`, 'error');
            return false;
        } catch (error) {
            log(`❌ 客户填充失败：${error.message}`, 'error');
            return false;
        }
    }

    async function applyQueueSupplier() {
        const supplierName = String(sourceOrders[sourceOrderIndex]?.supplier || '').trim();
        if (!supplierName) {
            log('⚠️ 当前队列单没有供应商名称，跳过供应商填充', 'warn');
            return false;
        }
        // Kingdee uses data-id="supplierid" for the purchase supplier selector;
        // searching by nearby label text can fail because the label and editor
        // live in separate layout containers.
        let supplierInput = document.querySelector('[data-id="supplierid"] input');
        if (!supplierInput || !isElementVisible(supplierInput) || supplierInput.readOnly || supplierInput.disabled) {
            const supplierLabel = [...document.querySelectorAll('*')].find(el =>
                el.children.length === 0 && (el.textContent || '').trim() === '供应商'
            );
            let parent = supplierLabel?.parentElement || null;
            for (let i = 0; i < 6 && parent && !supplierInput; i++, parent = parent.parentElement) {
                supplierInput = [...parent.querySelectorAll('input[type="text"], input[data-field="field"], input')]
                    .find(input => isElementVisible(input) && !input.readOnly && !input.disabled) || null;
            }
        }
        if (!supplierInput) {
            log('❌ 未找到供应商输入框，未能填充供应商', 'error');
            return false;
        }
        supplierInput.click();
        supplierInput.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(supplierInput, supplierName);
        supplierInput.dispatchEvent(new Event('input', { bubbles: true }));
        supplierInput.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 400));
        const options = [...document.querySelectorAll('[role="option"], li, .ant-select-item, [class*="option"], [class*="Option"]')]
            .filter(el => isElementVisible(el) && (el.textContent || '').trim() === supplierName);
        if (options.length === 1) {
            options[0].click();
            await new Promise(resolve => setTimeout(resolve, 150));
            log('✅ 已选择供应商：' + supplierName, 'success');
            return true;
        }
        supplierInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        supplierInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 150));
        if (String(supplierInput.value || '').trim() === supplierName) {
            log('✅ 供应商已填入：' + supplierName, 'success');
            return true;
        }
        log('⚠️ 已输入供应商“' + supplierName + '”，但未确认下拉选择，请检查供应商是否已绑定', 'warn');
        return false;
    }

    // 帮助
    function showHelp() {
        const api = getGridApi();
        const rowCount = api ? api.getDisplayedRowCount() : 0;
        const isSalesOrder = orderType === 'sales';

        alert(
            "🎯 智能填充助手 v13.3.1 - 虚拟滚动 / 编码填充 / 逐格补写 / 金额核对版\n\n" +
            "【能力】\n" +
            "✅ 支持采购订单和销售订单双模式\n" +
            "✅ 采购模式可粘贴/填充商品编码（materialid）\n" +
            "✅ 支持虚拟滚动表格，按行号定位\n" +
            `✅ 当前表格共 ${rowCount} 行（API检测）\n` +
            `✅ 当前模式：${isSalesOrder ? '销售订单' : '采购订单'}\n\n` +
            "【采购推荐流程】\n" +
            "1. 在金蝶先加够空行\n" +
            "2. 复制 Excel 编码列 →「粘贴编码」（或手填后「填充编码」）\n" +
            "3. 再「粘贴数量+单价」→「智能填充」\n" +
            "4. 运费行剪贴板写「运费」或 #N/A，脚本会优先选 BUD00052\n" +
            "5. 按 Ctrl+S 保存订单\n\n" +
            "【销售订单】\n" +
            "仅含税单价：粘贴单价后点「智能填充」。\n\n" +
            "【逐格补填】\n" +
            "智能填充后会自动逐格核对数量/含税单价；也可手动点「逐格补填」。\n\n" +
            "【金额核对】\n" +
            "粘贴数量+单价后面板显示预期总额 Σ(数量×单价)；\n" +
            "填充后自动/手动「核对成交金额」，优先读页面「本单成交金额」（勿误读折扣额）；|差|≤0.01 一致。"
        );
    }

    // 拖拽
    function makeDraggable(el) {
        const header = el.querySelector('#final-header');
        let isDrag = false, x, y, initX, initY;

        header.addEventListener('mousedown', e => {
            initX = e.clientX - el.offsetLeft;
            initY = e.clientY - el.offsetTop;
            isDrag = true;
        });

        document.addEventListener('mousemove', e => {
            if (isDrag) {
                e.preventDefault();
                x = e.clientX - initX;
                y = e.clientY - initY;
                el.style.left = x + 'px';
                el.style.top = y + 'px';
                el.style.right = 'auto';
            }
        });

        document.addEventListener('mouseup', () => isDrag = false);
    }

    function formatPriceDecimals(n) {
        if (isNaN(n)) return n;
        return parseFloat((Math.round(n * 1e5) / 1e5).toFixed(5));
    }

    // 粘贴剪贴板数据到含税单价
    async function pasteToPrice() {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                const lines = text.split(/\r?\n/);
                const formatted = lines.map(line => {
                    const trimmed = line.trim();
                    if (!trimmed) return line;
                    const n = parseFloat(trimmed.replace(/[^\d.-]/g, ''));
                    if (!isNaN(n)) return formatPriceDecimals(n);
                    return line;
                });
                document.getElementById('input-price').value = formatted.join('\n');
                log('📋 已粘贴剪贴板数据到含税单价', 'success');

                const lineCount = formatted.filter(l => l.trim()).length;
                log(`📊 检测到 ${lineCount} 行数据`, 'info');
                updateExpectedTotalUI();
            } else {
                log('剪贴板为空', 'warn');
            }
        } catch (err) {
            log('无法读取剪贴板，请手动粘贴', 'error');
            // 如果浏览器不支持clipboard API，使用传统方法
            document.getElementById('input-price').focus();
            log('💡 请在输入框中按 Ctrl+V 粘贴', 'info');
        }
    }

    async function pastePurchaseData() {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);
                const qtyArr = [];
                const priceArr = [];
                lines.forEach(line => {
                    const cols = line.split(/\t+/);
                    if (cols[0]) {
                        const q = parseFloat(cols[0].replace(/[^\d.-]/g, ''));
                        if (!isNaN(q)) qtyArr.push(q);
                    }
                    if (cols[2]) {
                        const p = parseFloat(cols[2].replace(/[^\d.-]/g, ''));
                        if (!isNaN(p)) priceArr.push(formatPriceDecimals(p));
                    }
                });
                document.getElementById('input-qty').value = qtyArr.join('\n');
                document.getElementById('input-price').value = priceArr.join('\n');
                log(`📋 采购粘贴：数量${qtyArr.length}条，单价${priceArr.length}条`, 'success');
                updateExpectedTotalUI();
                {
                    const exp = computeExpectedTotal();
                    log(`🧮 预期总额：${exp.total.toFixed(2)}（${exp.lines}行）`, 'info');
                }
            } else {
                log('剪贴板为空', 'warn');
            }
        } catch (err) {
            log('无法读取剪贴板，请手动粘贴', 'error');
            document.getElementById('input-qty').focus();
        }
    }

    // 填充基本信息（供应商+日期）
    async function fillBasicInfo() {
        try {
            syncSavedDateFromInput();
            // 读取剪贴板获取供应商名称
            const supplierName = await navigator.clipboard.readText();
            if (!supplierName || !supplierName.trim()) {
                log('剪贴板为空，请先复制供应商名称', 'error');
                alert('⚠️ 请先复制供应商名称到剪贴板！');
                return;
            }

            log('开始填充基本信息...', 'info');
            log(`供应商：${supplierName.trim()}`, 'info');
            log(`单据日期：${savedDate}`, 'info');

            const allText = document.querySelectorAll('*');
            await applyDocumentDate();

            // 查找供应商输入框（通过"供应商"文本标签）
            await new Promise(resolve => setTimeout(resolve, 200));

            let supplierInput = null;

            for (const el of allText) {
                if (el.textContent.trim() === '供应商') {
                    let parent = el.parentElement;
                    for (let i = 0; i < 5; i++) {
                        if (parent) {
                            const inp = parent.querySelector('input[type="text"]');
                            if (inp && inp.className.includes('_2qNurwY2')) {
                                supplierInput = inp;
                                break;
                            }
                            parent = parent.parentElement;
                        }
                    }
                    if (supplierInput) break;
                }
            }

            if (supplierInput) {
                // 点击激活输入框
                supplierInput.click();
                await new Promise(resolve => setTimeout(resolve, 100));

                // 填充供应商名称
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype,
                    'value'
                ).set;
                nativeInputValueSetter.call(supplierInput, supplierName.trim());
                supplierInput.dispatchEvent(new Event('input', { bubbles: true }));
                supplierInput.dispatchEvent(new Event('change', { bubbles: true }));

                // 模拟按下Enter键以触发搜索
                await new Promise(resolve => setTimeout(resolve, 100));
                supplierInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));

                log('✅ 供应商名称填充成功', 'success');
                log('💡 请从下拉列表中选择供应商', 'info');
            } else {
                log('❌ 未找到供应商输入框', 'error');
            }

        } catch (err) {
            log(`填充失败: ${err.message}`, 'error');
            alert(`❌ 填充失败：${err.message}`);
        }
    }

    // 切换订单类型
    function switchOrderType(type) {
        if (!['purchase', 'sales', 'warehouse'].includes(type)) throw new Error(`不支持的订单类型：${type}`);
        orderType = type;
        const warehouseMode = type === 'warehouse';
        const modeIds = { purchase: 'btn-purchase', sales: 'btn-sales', warehouse: 'btn-warehouse' };
        for (const [mode, id] of Object.entries(modeIds)) document.getElementById(id).classList.toggle('active', mode === type);
        document.getElementById('section-warehouse').style.display = warehouseMode ? 'block' : 'none';
        document.getElementById('warehouse-actions').style.display = warehouseMode ? 'grid' : 'none';
        for (const id of ['section-customer', 'section-codes', 'section-qty', 'amount-check-section']) {
            const el = document.getElementById(id);
            if (el) el.style.display = warehouseMode ? 'none' : (id === 'section-customer' ? (type === 'sales' ? 'block' : 'none') : '');
        }
        const priceSection = document.getElementById('input-price')?.closest('.final-section');
        if (priceSection) priceSection.style.display = warehouseMode ? 'none' : '';
        for (const id of ['btn-fill', 'btn-repair-cells', 'btn-paste-purchase', 'btn-refresh', 'btn-help', 'btn-paste', 'btn-clear', 'btn-new-order', 'btn-audit-order', 'btn-auto-run']) {
            const el = document.getElementById(id); if (el) el.style.display = warehouseMode ? 'none' : '';
        }
        document.getElementById('btn-fill-codes').closest('.final-section').style.display = warehouseMode ? 'none' : (type === 'sales' ? 'none' : '');
        document.getElementById('btn-paste-codes').style.display = type === 'sales' || warehouseMode ? 'none' : '';
        if (warehouseMode) { log('切换到出入库模式（队列日期 + 可选仓库填充）', 'info'); return { success: true, orderType: type }; }
        if (sourceOrderIndex >= 0) {
            const lines = sourceOrders[sourceOrderIndex].lines || [];
            document.getElementById('input-price').value = lines.map(line => {
                const price = type === 'sales' ? line.salesPrice : line.price;
                return price == null || price === '' ? '' : Number(price).toFixed(5);
            }).join('\n');
            updateExpectedTotalUI();
        }
        const sectionQty = document.getElementById('section-qty');
        const sectionCodes = document.getElementById('section-codes');
        const sectionCustomer = document.getElementById('section-customer');
        const btnPaste = document.getElementById('btn-paste');
        const btnPastePurchase = document.getElementById('btn-paste-purchase');

        if (type === 'purchase') {
            sectionQty.style.display = 'block';
            if (sectionCodes) sectionCodes.style.display = 'block';
            sectionCustomer.style.display = 'none';
            btnPaste.style.display = 'none';
            btnPastePurchase.style.display = 'block';
            log('切换到采购订单模式（编码+数量+含税单价）', 'info');
        } else {
            sectionQty.style.display = 'none';
            if (sectionCodes) sectionCodes.style.display = 'none';
            sectionCustomer.style.display = 'block';
            btnPaste.style.display = 'block';
            btnPastePurchase.style.display = 'none';
            log('切换到销售订单模式（仅含税单价）', 'info');
        }
        return { success: true, orderType: type };
    }

    // 初始化
    const panel = createUI();
    makeDraggable(panel);

    document.getElementById('input-date').value = savedDate;
    document.getElementById('input-date').addEventListener('change', (e) => {
        savedDate = e.target.value || getTodayDate();
        log(`📅 日期已更新：${savedDate}`, 'success');
    });
    document.getElementById('input-customer').addEventListener('change', (e) => {
        selectedSalesCustomer = e.target.value || salesCustomers[0];
        log(`🏢 客户已更新：${selectedSalesCustomer}`, 'success');
    });

    document.getElementById('final-close').addEventListener('click', () => {
        panel.style.display = 'none';
    });

    async function runRepairCellsOnly() {
        if (!parseData()) {
            log('请先输入数据！', 'error');
            alert('⚠️ 请先输入数据！');
            return;
        }
        if (isFilling) {
            log('正在填充中，请勿重复操作', 'warn');
            return;
        }
        isFilling = true;
        setCodeFillButtonsDisabled(true);
        const isSalesOrder = orderType === 'sales';
        try {
            log('==================== 开始手动逐格补填 ====================', 'info');
            log('开始逐格核对补写', 'info');
            await repairMismatchedQtyPrice(isSalesOrder);
            try {
                await repairLeakedTaxAmount();
            } catch (e) {
                log(`税额修复跳过：${e && e.message ? e.message : e}`, 'warn');
            }
            log('==================== 逐格补填完成 ====================', 'success');
        } catch (error) {
            log(`逐格补填出错: ${error.message}`, 'error');
            alert(`❌ 逐格补填出错：${error.message}`);
        } finally {
            isFilling = false;
            setCodeFillButtonsDisabled(false);
        }
    }

    document.getElementById('btn-fill').addEventListener('click', smartFillData);
    document.getElementById('btn-auto-run').addEventListener('click', () => {
        if (autoRunActive) stopAutoRun('用户手动停止');
        else startAutoRun().catch(error => log(error.message, 'error'));
    });
    document.getElementById('btn-new-order').addEventListener('click', () => { if (confirm('将点击金蝶“新增”并打开一张新单据。继续吗？')) executeControlCommand({ action: 'new-order' }).catch(e => log(e.message, 'error')); });
    document.getElementById('btn-audit-order').addEventListener('click', () => { if (confirm('审核会提交当前金蝶单据。请确认当前单据和金额均已核对。继续审核吗？')) executeControlCommand({ action: 'audit' }).catch(e => log(e.message, 'error')); });
    document.getElementById('btn-load-orders').addEventListener('click', requestSourceOrders);
    document.getElementById('btn-copy-supplier').addEventListener('click', () => { const name = sourceOrders[sourceOrderIndex]?.supplier; if (name) GM_setClipboard(name); });
    document.getElementById('btn-prev-order').addEventListener('click', () => loadSourceOrder(sourceOrderIndex - 1));
    document.getElementById('btn-next-order').addEventListener('click', () => loadSourceOrder(sourceOrderIndex + 1));
    document.getElementById('btn-repair-cells').addEventListener('click', runRepairCellsOnly);
    document.getElementById('btn-check-amount').addEventListener('click', checkDealAmount);
    document.getElementById('input-qty').addEventListener('input', updateExpectedTotalUI);
    document.getElementById('input-price').addEventListener('input', updateExpectedTotalUI);
    document.getElementById('btn-clear').addEventListener('click', clearData);
    document.getElementById('btn-help').addEventListener('click', showHelp);
    document.getElementById('btn-refresh').addEventListener('click', detectRows);
    document.getElementById('btn-paste').addEventListener('click', pasteToPrice);
    document.getElementById('btn-paste-purchase').addEventListener('click', pastePurchaseData);
    document.getElementById('btn-paste-codes').addEventListener('click', pasteCodes);
    document.getElementById('btn-fill-codes').addEventListener('click', fillCodesFromTextarea);
    document.getElementById('btn-purchase').addEventListener('click', () => switchOrderType('purchase'));
    document.getElementById('btn-sales').addEventListener('click', () => switchOrderType('sales'));
    document.getElementById('btn-warehouse').addEventListener('click', () => switchOrderType('warehouse'));
    document.getElementById('input-warehouse-enabled').addEventListener('change', e => { warehouseAutofillEnabled = e.target.checked; log(e.target.checked ? '已开启自动填充仓库' : '已关闭自动填充仓库', 'info'); });
    document.getElementById('input-warehouse').addEventListener('input', e => { warehouseValue = e.target.value; });
    document.getElementById('btn-warehouse-fill').addEventListener('click', () => runWarehouseFill().catch(e => log(`填充失败：${e.message}`, 'error')));

    // 设置初始状态
    switchOrderType('purchase');
    updateExpectedTotalUI();
    requestSourceOrders();
    pollControlCommand();
    setInterval(pollControlCommand, 900);

    // 检测API并初始化
    const api = getGridApi();
    if (api) {
        log(`✅ AG-Grid API 已加载！`, 'success');
        log(`💡 当前模式：采购订单（编码+数量+含税单价）`, 'info');
        log(`💡 可先「粘贴编码」再「粘贴数量+单价」→「智能填充」`, 'success');

        // 初始检测行数
        detectRows();
    } else {
        log(`⚠️ 未检测到AG-Grid API，使用DOM操作模式`, 'warn');
        log(`💡 支持虚拟滚动表格，可处理任意行数`, 'info');
    }

    console.log('✅ 智能填充工具 v13.3.1 已加载！（虚拟滚动版 / 逐格补写 / 金额核对）');
    console.log('🎯 支持采购订单和销售订单双模式');
    console.log('📦 采购订单：数量 + 含税单价');
    console.log('💰 销售订单：仅含税单价');
    console.log('🔄 支持虚拟滚动表格，可处理22+行数据');

})();



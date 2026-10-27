/* 越译中 · 内容脚本
 *
 * 目标：把一个越南语网页里「看得见、读得到」的文本全部换成中文，并且
 * 在 React/Vue 等框架重新渲染、打开新弹窗、切换路由之后依然保持译文。
 *
 * 覆盖范围：
 *   - 普通文本节点（含 <title>、<option>）
 *   - placeholder / title / aria-label / alt / 按钮 value
 *   - Shadow DOM（open）
 *   - iframe（内容脚本以 all_frames 注入，每个 frame 各自翻译）
 *   - 动态新增 / 被框架改回的节点（MutationObserver + 本地译文缓存）
 *
 * 不覆盖：canvas 绘制文字、伪元素 content、closed shadow root、图片里的文字。
 */
'use strict';

(() => {
  if (window.__VI2ZH_LOADED__) return;
  window.__VI2ZH_LOADED__ = true;

  // 扩展被重载后，旧脚本里迟到的 Promise 会以这个错误结束；静默丢弃即可
  const isStaleError = (value) => /extension context invalidated/i.test(String(value && (value.message || value)));
  window.addEventListener('unhandledrejection', (event) => {
    if (isStaleError(event.reason)) event.preventDefault();
  });
  window.addEventListener('error', (event) => {
    if (isStaleError(event.message)) event.preventDefault();
  });

  const DEFAULTS = globalThis.VI2ZH_DEFAULTS || {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    batchSize: 24,
    concurrency: 4,
    maxRequests: 300,
    showOriginal: true,
    autoHosts: [],
    skipSelectors: '',
    glossaryText: '',
    respectNoTranslate: false
  };

  const MARK = 'data-vi2zh';
  const TIP_ATTR = 'data-vi2zh-tip';
  const TEXT_MAX_LENGTH = 4000;

  const RE_LETTER = /\p{L}/u;
  const RE_VI = /[ăâđêôơưĂÂĐÊÔƠƯáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/;
  const RE_CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CODE', 'PRE', 'KBD', 'SAMP',
    'IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'VIDEO', 'AUDIO', 'MATH'
  ]);
  // <title> 在 <head> 里，需要遍历；<textarea> 只翻 placeholder，不碰用户输入内容。

  const ATTR_NAMES = ['placeholder', 'title', 'aria-label', 'alt'];

  const state = {
    settings: null,
    siteType: null,
    enabled: false,
    staleContext: false,
    generation: 0,
    observer: null,
    records: [],
    tips: [],
    textRecords: new WeakMap(),
    attrRecords: new WeakMap(),
    churn: new WeakMap(),
    pending: new Map(),       // key -> Set<record>
    queue: [],
    inFlight: new Set(),
    translatedByKey: new Map(),
    failedKeys: new Set(),
    knownKeys: new Set(),
    stats: { total: 0 },
    workers: 0,
    requestCount: 0,
    paused: false,
    lastError: '',
    startedAt: 0,
    pumpTimer: 0,
    reportTimer: 0,
    scanTimer: 0,
    pendingRoots: new Set(),
    hud: null,
    hudHideTimer: 0,
    hudErrorTimer: 0
  };

  /* ---------------------------------------------------------------- */
  /* 设置                                                              */
  /* ---------------------------------------------------------------- */

  function detectSite() {
    const sites = globalThis.VI2ZH_SITES;
    if (!sites) return { id: 'generic', label: '通用网页', confidence: 'low', source: 'missing' };
    const override = state.settings && state.settings.siteType;
    if (override && override !== 'auto' && sites.PROFILES[override]) {
      return { id: override, label: sites.PROFILES[override].label, confidence: 'manual', source: 'setting' };
    }
    let sample = '';
    try {
      sample = (document.body?.innerText || '').slice(0, 12000);
    } catch {
      /* ignore */
    }
    return sites.detect({ host: location.hostname, title: document.title, sample });
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get('settings');
      state.settings = { ...DEFAULTS, ...(stored.settings || {}) };
    } catch {
      state.settings = { ...DEFAULTS };
    }
    return state.settings;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    state.settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
    state.siteType = detectSite();
    if (!state.settings.showOriginal) removeAllTips();
  });

  /* ---------------------------------------------------------------- */
  /* 文本判定                                                          */
  /* ---------------------------------------------------------------- */

  function keyOf(text) {
    return String(text).replace(/\s+/g, ' ').trim();
  }

  function looksLikeCode(text) {
    if (/^(?:https?:\/\/|www\.|mailto:)\S+$/i.test(text)) return true;
    if (/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(text)) return true;
    if (/^#[A-Za-z][\w-]{1,30}$/.test(text)) return true;      // #锚点 / #标签
    if (/^[A-Za-z0-9_./:#@%+\-]+$/.test(text)) {
      if (/\d/.test(text)) return true;                       // 含数字的编号、型号
      if (/[./:#@_%]/.test(text)) return true;                // 路径、URL、代码
      if (/^[A-Z0-9]{2,}$/.test(text)) return true;           // 全大写缩写 MISA/ASP/VND
    }
    if (/^[A-Za-z]{24,}$/.test(text)) return true;            // 无空格长串
    return false;
  }

  function isTranslatable(raw) {
    const text = keyOf(raw);
    if (!text) return false;
    if (text.length < 2 || text.length > TEXT_MAX_LENGTH) return false;
    if (!RE_LETTER.test(text)) return false;
    if (RE_CJK.test(text) && !RE_VI.test(text)) return false;  // 已经是中文/日韩文
    if (looksLikeCode(text)) return false;

    // 金额、日期、比例：字母极少时保持原样，避免把 1.250.000 改坏
    const digits = (text.match(/\d/g) || []).length;
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (digits > 0 && letters <= 2) return false;

    return true;
  }

  /* ---------------------------------------------------------------- */
  /* DOM 遍历                                                          */
  /* ---------------------------------------------------------------- */

  function shouldSkipElement(el, settings) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute(MARK)) return true;
    if (settings.respectNoTranslate) {
      if (el.getAttribute('translate') === 'no') return true;
      const className = el.getAttribute('class');
      if (className && /(?:^|\s)notranslate(?:\s|$)/.test(className)) return true;
    }
    if (el.isContentEditable) return true;
    if (settings.skipSelectors) {
      try {
        if (el.matches(settings.skipSelectors)) return true;
      } catch {
        /* 用户填了非法选择器，忽略 */
      }
    }
    return false;
  }

  function walk(root) {
    const settings = state.settings || DEFAULTS;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;

      if (node.nodeType === Node.TEXT_NODE) {
        addTextNode(node);
        continue;
      }
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.tagName === 'TEXTAREA') {
        collectAttributes(node);
        continue;
      }
      // iframe 子树交给子框架自己的内容脚本，但 iframe 自身的 title 仍需翻译
      if (node.tagName === 'IFRAME') collectAttributes(node);
      if (shouldSkipElement(node, settings)) continue;

      collectAttributes(node);
      if (node.shadowRoot) stack.push(node.shadowRoot);
      for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child);
    }
  }

  function addTextNode(node) {
    if (!state.enabled) return;
    const raw = node.nodeValue;
    if (!raw) return;

    const existing = state.textRecords.get(node);
    if (existing) {
      if (raw === existing.applied) return;        // 我们自己写入的译文，忽略
      // 只对“亚秒级连续改写”熔断（如倒计时/毫秒时钟）；每秒级时钟仍正常翻译，
      // 其重复前缀由 DeepSeek 上下文缓存吸收，不会造成明显费用。
      const now = Date.now();
      let churn = state.churn.get(node);
      if (!churn) {
        churn = { count: 0, last: 0 };
        state.churn.set(node, churn);
      }
      churn.count = now - churn.last < 200 ? churn.count + 1 : 0;
      churn.last = now;
      if (churn.count > 12) return;
      existing.original = raw;
      existing.applied = '';
      enqueue(existing);
      return;
    }

    if (!isTranslatable(raw)) return;
    const record = { kind: 'text', node, original: raw, applied: '', key: '' };
    state.textRecords.set(node, record);
    state.records.push(record);
    enqueue(record);
  }

  function collectAttributes(el) {
    if (!state.enabled) return;
    for (const attr of ATTR_NAMES) {
      if (!el.hasAttribute(attr)) continue;
      const value = el.getAttribute(attr);
      if (value) handleAttributeValue(el, attr, value);
    }
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset') {
        const value = el.getAttribute('value');
        if (value) handleAttributeValue(el, 'value', value);
      }
    }
  }

  function handleAttributeValue(el, attr, raw) {
    if (!raw) return;
    if (attr === 'title' && el.getAttribute(TIP_ATTR) === raw) return; // 我们自己加的原文提示
    if (!isTranslatable(raw)) return;

    let map = state.attrRecords.get(el);
    if (!map) {
      map = new Map();
      state.attrRecords.set(el, map);
    }
    const existing = map.get(attr);
    if (existing) {
      if (raw === existing.applied) return;
      existing.original = raw;
      existing.applied = '';
      enqueue(existing);
      return;
    }
    const record = { kind: 'attr', el, attr, original: raw, applied: '', key: '' };
    map.set(attr, record);
    state.records.push(record);
    enqueue(record);
  }

  /* ---------------------------------------------------------------- */
  /* 队列与请求                                                        */
  /* ---------------------------------------------------------------- */

  function enqueue(record) {
    if (!state.enabled) return;
    const key = keyOf(record.original);
    if (!key) return;
    record.key = key;

    if (!state.knownKeys.has(key)) {
      state.knownKeys.add(key);
      state.stats.total = state.knownKeys.size;
    }

    const already = state.translatedByKey.get(key);
    if (already) {
      applyRecord(record, already);
      return;
    }
    if (state.failedKeys.has(key) || state.paused) return;

    let set = state.pending.get(key);
    if (!set) {
      set = new Set();
      state.pending.set(key, set);
      if (!state.inFlight.has(key)) state.queue.push(key);
    }
    set.add(record);
    schedulePump();
  }

  function schedulePump() {
    if (state.pumpTimer) return;
    state.pumpTimer = setTimeout(() => {
      state.pumpTimer = 0;
      pump();
    }, 40);
  }

  function takeBatch(settings) {
    const maxItems = Math.max(1, Math.min(40, Number(settings.batchSize) || 24));
    const maxChars = 2600;
    const keys = [];
    let chars = 0;
    while (state.queue.length && keys.length < maxItems) {
      const key = state.queue[0];
      if (state.inFlight.has(key)) {
        state.queue.shift();
        continue;
      }
      if (keys.length > 0 && chars + key.length > maxChars) break;
      state.queue.shift();
      keys.push(key);
      chars += key.length;
    }
    return keys;
  }

  function pump() {
    if (!state.enabled || state.paused) return;
    const settings = state.settings || DEFAULTS;
    const concurrency = Math.max(1, Math.min(8, Number(settings.concurrency) || 4));
    const maxRequests = Math.max(1, Number(settings.maxRequests) || 300);

    while (state.workers < concurrency && state.queue.length) {
      if (state.requestCount >= maxRequests) {
        state.paused = true;
        showError(`本次翻译已达到单页请求上限（${maxRequests} 次），可调高上限或还原后重试。`);
        break;
      }
      const batch = takeBatch(settings);
      if (!batch.length) break;
      state.workers += 1;
      state.requestCount += 1;
      runBatch(batch);
    }
    reportStats();
  }

  async function runBatch(keys) {
    const generation = state.generation;
    keys.forEach((key) => state.inFlight.add(key));

    let response;
    try {
      const siteType = state.siteType?.id || 'generic';
      response = await sendToBackground({ type: 'VI2ZH_TRANSLATE', texts: keys, siteType });
    } catch (err) {
      const message = err?.message || String(err);
      // 扩展被重新加载/更新后，旧页面里的脚本会失去 chrome.* 运行时
      if (/extension context invalidated/i.test(message)) {
        markContextStale();
        return;
      }
      response = { ok: false, error: message, translations: {}, failed: keys };
    } finally {
      keys.forEach((key) => state.inFlight.delete(key));
      state.workers = Math.max(0, state.workers - 1);
    }

    if (generation !== state.generation || !state.enabled) {
      pump();
      return;
    }
    if (!response || typeof response !== 'object') {
      response = { ok: false, error: '扩展后台无响应，请重试', translations: {}, failed: keys };
    }

    const translations = response.translations || {};

    for (const key of keys) {
      const set = state.pending.get(key);
      state.pending.delete(key);

      const translated = typeof translations[key] === 'string' ? translations[key].trim() : '';
      if (translated) {
        state.translatedByKey.set(key, translated);
        state.failedKeys.delete(key);
        if (set) {
          for (const record of set) {
            if (record.key === key) applyRecord(record, translated);
          }
        }
      } else {
        state.failedKeys.add(key);
      }
    }

    if (response.error) {
      if (response.fatal) {
        state.paused = true;
        state.queue.length = 0;
      }
      showError(response.error);
    } else if (state.lastError) {
      // 本批全部成功：清掉上一次的临时错误提示
      state.lastError = '';
    }

    reportStats(true);
    pump();
  }

  function applyRecord(record, translated) {
    if (!translated) return;
    if (record.kind === 'text') {
      const node = record.node;
      if (!node || node.nodeType !== Node.TEXT_NODE) return;
      const original = record.original;
      const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(original);
      const leading = match ? match[1] : '';
      const trailing = match ? match[3] : '';
      const value = leading + translated + trailing;
      record.applied = value;
      try {
        node.nodeValue = value;
      } catch {
        return;
      }
      if ((state.settings || DEFAULTS).showOriginal) attachOriginalTip(node, original);
    } else if (record.kind === 'attr') {
      const el = record.el;
      if (!el || !el.isConnected) return;
      record.applied = translated;
      try {
        el.setAttribute(record.attr, translated);
      } catch {
        /* 某些属性不可写，忽略 */
      }
    }
  }

  function attachOriginalTip(node, original) {
    const el = node.parentElement;
    if (!el) return;
    if (el.hasAttribute('title') || el.hasAttribute(TIP_ATTR)) return;
    if (el.hasAttribute(MARK)) return;
    const text = keyOf(original);
    if (!text || text.length > 200) return;
    try {
      el.setAttribute('title', text);
      el.setAttribute(TIP_ATTR, text);
      state.tips.push({ el, value: text });
    } catch {
      /* 忽略 */
    }
  }

  function removeAllTips() {
    for (const tip of state.tips) {
      if (!tip.el.isConnected) continue;
      if (tip.el.getAttribute('title') === tip.value) tip.el.removeAttribute('title');
      tip.el.removeAttribute(TIP_ATTR);
    }
    state.tips = [];
  }

  /* ---------------------------------------------------------------- */
  /* 观察动态内容                                                      */
  /* ---------------------------------------------------------------- */

  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(onMutations);
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['placeholder', 'title', 'aria-label', 'alt', 'value']
    });
  }

  function stopObserver() {
    if (!state.observer) return;
    state.observer.disconnect();
    state.observer = null;
  }

  function onMutations(mutations) {
    if (!state.enabled) return;
    let hasNewRoots = false;

    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const node = mutation.target;
        const record = state.textRecords.get(node);
        if (record && node.nodeValue === record.applied) continue;
        addTextNode(node);
      } else if (mutation.type === 'attributes') {
        const el = mutation.target;
        if (!el || el.nodeType !== Node.ELEMENT_NODE) continue;
        if (el.hasAttribute(MARK)) continue;
        const attr = mutation.attributeName;
        if (attr === 'title' && el.getAttribute(TIP_ATTR) === el.getAttribute('title')) continue;
        const raw = el.getAttribute(attr);
        if (!raw) continue;
        if (attr === 'value') {
          if (el.tagName !== 'INPUT') continue;
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (type !== 'button' && type !== 'submit' && type !== 'reset') continue;
        }
        handleAttributeValue(el, attr, raw);
      } else if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            addTextNode(node);
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.hasAttribute(MARK)) continue;
            state.pendingRoots.add(node);
            hasNewRoots = true;
          }
        }
      }
    }

    if (hasNewRoots) scheduleScan();
  }

  function scheduleScan() {
    if (state.scanTimer) return;
    state.scanTimer = setTimeout(() => {
      state.scanTimer = 0;
      const roots = [...state.pendingRoots];
      state.pendingRoots.clear();
      for (const root of roots) {
        if (root.isConnected) walk(root);
      }
    }, 220);
  }

  /* ---------------------------------------------------------------- */
  /* 进度 / HUD                                                        */
  /* ---------------------------------------------------------------- */

  function currentStats() {
    let translated = 0;
    for (const record of state.records) {
      if (record.applied) translated += 1;
    }
    return {
      enabled: state.enabled,
      total: state.records.length,
      translated,
      failed: state.failedKeys.size,
      running: state.workers > 0 || state.queue.length > 0,
      error: state.lastError || '',
      siteType: state.siteType?.id || 'generic',
      siteLabel: state.siteType?.label || '通用网页'
    };
  }

  function reportStats(force = false) {
    if (!runtimeAlive()) return;
    if (!force && state.reportTimer) return;
    if (!force) {
      state.reportTimer = setTimeout(() => {
        state.reportTimer = 0;
        reportStats(true);
      }, 250);
      return;
    }
    const stats = currentStats();
    updateHud(stats);
    try {
      try {
        chrome.runtime.sendMessage({ type: 'VI2ZH_STATS', stats }, () => void chrome.runtime.lastError);
      } catch {
        /* 扩展上下文已失效，忽略 */
      }
    } catch {
      /* 扩展被重新加载后 runtime 会失效，忽略 */
    }
  }

  function ensureHud() {
    if (state.hud && state.hud.host.isConnected) return state.hud;
    if (state.hud) state.hud = null;
    if (window.top !== window) return null;

    const host = document.createElement('div');
    host.setAttribute(MARK, 'hud');
    host.style.cssText =
      'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; pointer-events: none;';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .panel {
        display: flex; flex-direction: column; gap: 8px;
        min-width: 220px; max-width: 320px; padding: 10px 12px;
        border-radius: 12px; background: rgba(15, 23, 42, .96); color: #e2e8f0;
        font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        box-shadow: 0 10px 30px rgba(0, 0, 0, .28);
        border: 1px solid rgba(148, 163, 184, .25);
        pointer-events: auto;
      }
      .panel[hidden] { display: none; }
      .row { display: flex; align-items: center; gap: 8px; }
      .logo {
        width: 20px; height: 20px; border-radius: 6px; flex: none;
        background: linear-gradient(135deg, #2dd4bf, #0d9488); color: #fff;
        font-weight: 700; font-size: 11px;
        display: flex; align-items: center; justify-content: center;
      }
      .label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .action {
        all: unset; cursor: pointer; color: #5eead4; font-size: 11px;
        padding: 2px 4px; border-radius: 4px; flex: none;
      }
      .action:hover { background: rgba(94, 234, 212, .12); }
      .track { height: 3px; border-radius: 999px; background: rgba(148, 163, 184, .25); overflow: hidden; }
      .fill {
        width: 0%; height: 100%; border-radius: 999px;
        background: linear-gradient(90deg, #2dd4bf, #14b8a6);
        transition: width .25s ease;
      }
      .panel.error .fill { background: #f59e0b; }
      .panel.error .label { white-space: normal; color: #fde68a; }
      .panel.done .logo { background: linear-gradient(135deg, #34d399, #059669); }
    `;

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="row">
        <span class="logo">译</span>
        <span class="label">准备翻译…</span>
        <button class="action" type="button">还原</button>
      </div>
      <div class="track"><div class="fill"></div></div>
    `;

    shadow.append(style, panel);
    (document.body || document.documentElement).appendChild(host);

    const label = panel.querySelector('.label');
    const fill = panel.querySelector('.fill');
    const action = panel.querySelector('.action');
    action.addEventListener('click', () => restore());

    state.hud = { host, panel, label, fill, action };
    return state.hud;
  }

  function updateHud(stats) {
    const hud = ensureHud();
    if (!hud) return;
    clearTimeout(state.hudHideTimer);
    clearTimeout(state.hudErrorTimer);

    if (!stats.enabled && !stats.error) {
      hud.panel.hidden = true;
      return;
    }

    const total = stats.total || 0;
    const percent = total ? Math.round((stats.translated / total) * 100) : 0;
    hud.panel.hidden = false;
    hud.panel.classList.toggle('error', !!stats.error);
    hud.panel.classList.toggle('done', !stats.running && !stats.error && stats.translated > 0);
    hud.fill.style.width = `${stats.error ? 100 : percent}%`;
    hud.action.textContent = stats.enabled ? '还原' : '关闭';

    if (stats.error) {
      hud.label.textContent = stats.error.length > 90 ? `${stats.error.slice(0, 90)}…` : stats.error;
      if (!state.staleContext) {
        state.hudErrorTimer = setTimeout(() => {
          if (state.hud) state.hud.panel.hidden = true;
        }, 12000);
      }
    } else if (stats.running) {
      hud.label.textContent = total ? `正在翻译 ${stats.translated}/${total}` : '正在扫描页面…';
    } else {
      hud.label.textContent = `已翻译 ${stats.translated} 段`;
      state.hudHideTimer = setTimeout(() => {
        if (state.hud && !state.lastError) state.hud.panel.hidden = true;
      }, 3000);
    }
  }

  function showError(message) {
    state.lastError = message;
    // 扩展重载导致的失效只记 info，避免在 chrome://extensions 里堆成“错误”
    if (state.staleContext || /extension context invalidated/i.test(message)) {
      console.info('[越译中]', message);
    } else {
      console.warn('[越译中]', message);
    }
    try {
      updateHud(currentStats());
    } catch {
      /* HUD 失败不影响主流程 */
    }
    try {
      reportStats(true);
    } catch {
      /* 上下文失效时统计可能不可用 */
    }
  }

  /* ---------------------------------------------------------------- */
  /* 启动 / 还原                                                       */
  /* ---------------------------------------------------------------- */

  function resetBookkeeping() {
    state.records = [];
    state.tips = [];
    state.textRecords = new WeakMap();
    state.attrRecords = new WeakMap();
    state.churn = new WeakMap();
    state.pending = new Map();
    state.queue = [];
    state.inFlight = new Set();
    state.translatedByKey = new Map();
    state.failedKeys = new Set();
    state.knownKeys = new Set();
    state.stats = { total: 0 };
    state.workers = 0;
    state.requestCount = 0;
    state.paused = false;
    state.staleContext = false;
    state.lastError = '';
    state.pendingRoots.clear();
    if (state.pumpTimer) clearTimeout(state.pumpTimer);
    state.pumpTimer = 0;
    if (state.rescanTimers) {
      state.rescanTimers.forEach(clearTimeout);
      state.rescanTimers = null;
    }
    state.generation += 1;
  }

  function restoreDom() {
    for (const record of state.records) {
      try {
        if (record.kind === 'text') {
          const node = record.node;
          if (node && node.isConnected && record.applied && node.nodeValue === record.applied) {
            node.nodeValue = record.original;
          }
        } else if (record.kind === 'attr') {
          const el = record.el;
          if (el && el.isConnected && record.applied && el.getAttribute(record.attr) === record.applied) {
            el.setAttribute(record.attr, record.original);
          }
        }
      } catch {
        /* 节点可能已被移除 */
      }
    }
    for (const tip of state.tips) {
      if (!tip.el.isConnected) continue;
      if (tip.el.getAttribute('title') === tip.value) tip.el.removeAttribute('title');
      tip.el.removeAttribute(TIP_ATTR);
    }
  }

  function restore() {
    state.enabled = false;
    stopObserver();
    restoreDom();
    resetBookkeeping();
    if (state.hud) {
      state.hud.panel.hidden = true;
      clearTimeout(state.hudHideTimer);
      clearTimeout(state.hudErrorTimer);
    }
    reportStats(true);
    return { ok: true, enabled: false };
  }

  async function start({ auto = false } = {}) {
    if (!runtimeAlive()) {
      markContextStale();
      return { ok: false, stale: true };
    }
    if (!state.settings) await loadSettings();
    if (!state.settings.apiKey) {
      if (!auto) showError('尚未配置 DeepSeek API Key：请点击浏览器工具栏中的扩展图标填写。');
      return { ok: false, needKey: true };
    }
    state.siteType = detectSite();

    if (state.enabled) {
      // 上次因鉴权/额度/失败而暂停时，把这次点击当成“重新开始”：
      // 先还原成原文再重扫，已缓存的译文会直接复用，不会重复计费。
      if (state.paused || state.failedKeys.size > 0) {
        restore();
      } else {
        scanDocument();
        schedulePump();
        reportStats(true);
        return { ok: true, already: true };
      }
    }

    if (state.records.length) restoreDom();
    resetBookkeeping();
    state.enabled = true;
    state.startedAt = Date.now();

    ensureHud();
    startObserver();
    updateHud({ enabled: true, total: 0, translated: 0, failed: 0, running: true, error: '' });
    scanDocument();
    schedulePump();
    reportStats(true);
    scheduleRescans();
    return { ok: true };
  }

  // 部分后台（如 MISA）的外壳/侧边栏比正文晚渲染，首轮扫描时可能还没挂载。
  // 启动后补扫几次；已翻译的文本会命中内存缓存，不会产生额外请求。
  function scheduleRescans() {
    if (state.rescanTimers) state.rescanTimers.forEach(clearTimeout);
    state.rescanTimers = [1500, 4000, 9000].map((ms) =>
      setTimeout(() => {
        if (!state.enabled || state.paused || !runtimeAlive()) return;
        scanDocument();
        schedulePump();
      }, ms)
    );
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.enabled || state.paused) return;
    scanDocument();
    schedulePump();
  });

  async function toggle() {
    if (!state.settings) await loadSettings();
    if (state.enabled) return restore();
    return start();
  }

  function status() {
    return { ok: true, ...currentStats(), hasKey: !!(state.settings && state.settings.apiKey) };
  }

  function scanDocument() {
    if (!document.documentElement) return;
    walk(document.documentElement);
  }

  /* ---------------------------------------------------------------- */
  /* 消息                                                              */
  /* ---------------------------------------------------------------- */

  function runtimeAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function markContextStale() {
    state.paused = true;
    state.queue.length = 0;
    state.staleContext = true;
    showError('扩展已更新或重新加载，当前页面的翻译脚本已失效：请刷新页面（F5）后再翻译。');
  }

  function sendToBackground(message) {
    if (!runtimeAlive()) return Promise.reject(new Error('Extension context invalidated.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('请求超时（120 秒）')), 120000);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          clearTimeout(timer);
          const lastError = chrome.runtime.lastError;
          if (lastError) reject(new Error(lastError.message));
          else resolve(response);
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('VI2ZH_')) return false;

    (async () => {
      if (!state.settings) await loadSettings();
      switch (message.type) {
        case 'VI2ZH_PING':
          let version = '';
          try {
            version = chrome.runtime.getManifest().version;
          } catch {
            /* 上下文已失效 */
          }
          sendResponse({ ok: true, version, enabled: state.enabled });
          break;
        case 'VI2ZH_START':
          sendResponse(await start());
          break;
        case 'VI2ZH_RESTORE':
          sendResponse(restore());
          break;
        case 'VI2ZH_TOGGLE':
          sendResponse(await toggle());
          break;
        case 'VI2ZH_STATUS':
          sendResponse(status());
          break;
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    })();

    return true;
  });

  /* ---------------------------------------------------------------- */
  /* 自动翻译（按站点白名单）                                          */
  /* ---------------------------------------------------------------- */

  // 延迟加载的 iframe 在 START 广播之后才注入时，向背景确认标签页是否正在翻译
  async function syncLateFrame(attempt = 0) {
    if (state.enabled) return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'VI2ZH_FRAME_READY' });
      if (res && res.start) {
        await start();
        return;
      }
    } catch {
      /* 忽略 */
    }
    if (attempt < 3) setTimeout(() => syncLateFrame(attempt + 1), 1200 * (attempt + 1));
  }

  async function boot() {
    await loadSettings();
    try {
      const host = location.hostname;
      const autoHosts = Array.isArray(state.settings.autoHosts) ? state.settings.autoHosts : [];
      if (host && autoHosts.includes(host) && state.settings.apiKey) {
        setTimeout(() => {
          if (!state.enabled) start({ auto: true });
        }, 800);
      } else {
        syncLateFrame();
      }
    } catch {
      /* 忽略 */
    }
    return state.settings;
  }

  const ready = boot();

  // 便于调试 / 自动化测试（隔离环境内可见）
  globalThis.__VI2ZH_API__ = {
    start: () => start(),
    restore: () => restore(),
    toggle: () => toggle(),
    status: () => status(),
    ready: () => ready
  };
})();

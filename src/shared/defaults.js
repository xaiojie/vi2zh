/* 越译中：默认配置（后台、弹窗、内容脚本共用） */
(function (g) {
  'use strict';
  g.VI2ZH_DEFAULTS = Object.freeze({
    // 接口
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    // 翻译行为
    batchSize: 24,        // 每个请求最多携带多少条文本
    concurrency: 4,       // 并发请求数（提高可明显缩短整页耗时）
    maxRequests: 300,     // 单页单次翻译最多请求数，防止失控计费
    showOriginal: true,   // 悬停时用原生 title 显示原文
    // 翻译模式与交互
    mode: 'replace',      // replace=直接替换 / bilingual=原文+译文对照
    selectionTranslate: true, // 选中文本后显示悬浮“译”按钮
    inputTranslate: true,     // 输入框旁的“译”按钮（中越互译）
    sourceLang: 'auto',   // auto / vi / en / th / id / km / lo
    targetLang: 'zh',     // zh / vi
    siteRules: {},        // { "host": { auto, mode, siteType, disabled } }
    // 作用范围
    autoHosts: [],        // 打开即自动翻译的站点（hostname）
    skipSelectors: '',     // 不翻译的 CSS 选择器，逗号分隔
    siteType: 'auto',      // auto / generic / accounting / ecommerce / hr / news / education
    respectNoTranslate: false, // 是否尊重网页的 translate=no / .notranslate 标记
    // 费用与模型
    budgetDaily: 0,       // 每日预算（元），0=不限
    budgetMonthly: 0,     // 每月预算（元），0=不限
    modelMode: 'fixed',   // fixed=固定模型 / auto=按内容自动选
    // 隐私与同步
    privacyMode: false,   // 发送前脱敏金额/单号/邮箱/链接
    syncEnabled: false,   // 设置同步到 chrome.storage.sync（不含 API Key）
    glossaryText: ''      // 自定义术语表，每行：越南语=中文
  });
})(globalThis);

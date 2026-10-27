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
    // 作用范围
    autoHosts: [],        // 打开即自动翻译的站点（hostname）
    skipSelectors: '',     // 不翻译的 CSS 选择器，逗号分隔
    siteType: 'auto',      // auto / generic / accounting / ecommerce / hr / news / education
    respectNoTranslate: false, // 是否尊重网页的 translate=no / .notranslate 标记
    glossaryText: ''      // 自定义术语表，每行：越南语=中文
  });
})(globalThis);

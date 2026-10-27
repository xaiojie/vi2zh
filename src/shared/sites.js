/* 越译中 · 站点类型识别
 * 先按域名命中已知系统，再用页面文本里的领域词做打分；识别结果用于选择
 * 对应的翻译风格与术语提示。新增一类站点只要往 PROFILES 里加一项。
 */
'use strict';

(function () {
  const PROFILES = {
    accounting: {
      label: '财务会计 / ERP',
      short: '财务会计',
      hosts: ['misa.vn', 'fast.vn', 'bravo.com.vn', 'erp.vn', 'sap.com'],
      terms: [
        'hóa đơn', 'chứng từ', 'hạch toán', 'công nợ', 'nhà cung cấp', 'định khoản',
        'khóa sổ', 'báo cáo tài chính', 'tài sản cố định', 'tiền mặt', 'tiền gửi',
        'thuế gtgt', 'nghiệp vụ', 'số dư', 'kế toán', 'quyết toán'
      ],
      prompt: [
        '这是越南语财务会计 / ERP 后台。术语按中国会计准则的习惯译法：Chứng từ=凭证、Hạch toán=记账、Công nợ=应收应付、Khóa sổ=结账、Tiền gửi=银行存款、Tài sản cố định=固定资产、Nghiệp vụ=业务。',
        '菜单、页签用名词短语；按钮用简洁动宾结构（如“新增凭证”“保存”“审核”）。',
        '单据号、金额、日期、税率数字保持原样，不要改写。'
      ]
    },
    ecommerce: {
      label: '电商 / 订单管理',
      short: '电商',
      hosts: ['shopee.vn', 'lazada.vn', 'tiki.vn', 'sendo.vn', 'shopify.com'],
      terms: [
        'giỏ hàng', 'đơn hàng', 'vận chuyển', 'thanh toán', 'mã giảm giá', 'sản phẩm',
        'tồn kho', 'giao hàng', 'hoàn tiền', 'người bán', 'khuyến mãi', 'phí ship'
      ],
      prompt: [
        '这是越南语电商 / 订单后台。Đơn hàng=订单、Giỏ hàng=购物车、Thanh toán=支付、Vận chuyển=物流、Mã giảm giá=优惠券、Tồn kho=库存。',
        '状态词用中文电商惯用语（待付款、待发货、已签收、退款中），不要生硬直译。'
      ]
    },
    hr: {
      label: '招聘 / 人事',
      short: '人事',
      hosts: ['topcv.vn', 'vietnamworks.com', 'careerlink.vn', 'linkedin.com'],
      terms: [
        'ứng viên', 'tuyển dụng', 'chấm công', 'bảng lương', 'hợp đồng lao động',
        'nhân viên', 'phỏng vấn', 'nghỉ phép', 'thử việc', 'đào tạo', 'hồ sơ'
      ],
      prompt: [
        '这是越南语招聘 / 人事系统。Ứng viên=候选人、Tuyển dụng=招聘、Chấm công=考勤、Bảng lương=工资表、Hợp đồng lao động=劳动合同、Thử việc=试用期。',
        '职位、部门名称用中文常见说法；姓名保留原文。'
      ]
    },
    news: {
      label: '资讯 / 内容',
      short: '资讯',
      hosts: ['vnexpress.net', 'dantri.com.vn', 'tuoitre.vn', 'thanhnien.vn', 'vietnamnet.vn'],
      terms: [
        'tin tức', 'bài viết', 'chuyên mục', 'phóng viên', 'bình luận', 'sự kiện',
        'thời sự', 'giải trí', 'thể thao', 'đọc thêm', 'nguồn tin'
      ],
      prompt: [
        '这是越南语资讯 / 内容站点。标题与正文按中文新闻语感翻译，句子通顺优先于逐字对应。',
        '人名、地名、机构名保留越南语原名或用通用译名，不要音译得面目全非。'
      ]
    },
    education: {
      label: '教育 / 培训',
      short: '教育',
      hosts: ['edumall.vn', 'topica.edu.vn', 'coursera.org', 'udemy.com'],
      terms: [
        'khóa học', 'học viên', 'bài giảng', 'giảng viên', 'điểm số', 'lớp học',
        'tuyển sinh', 'học phí', 'chứng chỉ', 'bài tập', 'giáo trình'
      ],
      prompt: [
        '这是越南语教育 / 培训站点。Khóa học=课程、Học viên=学员、Bài giảng=讲义、Giảng viên=讲师、Học phí=学费、Chứng chỉ=证书。',
        '课程名和按钮用中文教育产品习惯说法；练习与考试用语要准确。'
      ]
    },
    generic: {
      label: '通用网页',
      short: '通用',
      hosts: [],
      terms: [],
      prompt: [
        '这是通用越南语网页，没有明显行业特征。按上下文选择自然、简洁的中文表达。',
        '不确定的专有名词、产品名保留原文，不要臆造译名。'
      ]
    }
  };

  const ORDER = ['accounting', 'ecommerce', 'hr', 'news', 'education'];

  function resolve(id) {
    return Object.prototype.hasOwnProperty.call(PROFILES, id) ? id : 'generic';
  }

  function profileOf(id) {
    return PROFILES[resolve(id)];
  }

  function hostMatch(host) {
    const h = String(host || '').toLowerCase();
    for (const id of ORDER) {
      const p = PROFILES[id];
      if (p.hosts.some((domain) => h === domain || h.endsWith(`.${domain}`))) return id;
    }
    return '';
  }

  /** 页面文本打分：命中一个领域词记 1 分，至少 4 分且明显领先才算识别成功 */
  function detect({ host = '', title = '', sample = '' } = {}) {
    const byHost = hostMatch(host);
    if (byHost) return { id: byHost, label: PROFILES[byHost].label, confidence: 'high', source: 'host' };

    const text = `${title}\n${sample}`.toLowerCase();
    if (!text.trim()) return { id: 'generic', label: PROFILES.generic.label, confidence: 'low', source: 'empty' };

    const scored = ORDER.map((id) => ({
      id,
      hits: PROFILES[id].terms.reduce((sum, term) => (text.includes(term) ? sum + 1 : sum), 0)
    })).sort((a, b) => b.hits - a.hits);

    const best = scored[0];
    const second = scored[1] || { hits: 0 };
    if (best.hits >= 4 && best.hits >= Math.max(2, second.hits * 1.3)) {
      return {
        id: best.id,
        label: PROFILES[best.id].label,
        confidence: best.hits >= 8 ? 'high' : 'medium',
        source: 'content',
        hits: best.hits
      };
    }
    return { id: 'generic', label: PROFILES.generic.label, confidence: 'low', source: 'fallback', hits: best.hits };
  }

  globalThis.VI2ZH_SITES = { PROFILES, ORDER, resolve, profileOf, detect };
})();

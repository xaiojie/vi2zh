#!/usr/bin/env node
/**
 * 本地 Mock DeepSeek 服务：仅用于离线端到端测试，不连接外网。
 *   node tools/mock-deepseek.js [port]
 * 接口：POST /chat/completions（OpenAI 兼容），GET /state，POST /reset
 */
'use strict';

const http = require('node:http');

const PORT = Number(process.argv[2] || 8787);

const PHRASES = {
  'MISA ASP - Bàn làm việc | Công ty TNHH Chuỗi Cung Ứng Liên Trang': 'MISA ASP - 工作台 | 联庄供应链有限公司',
  'CÔNG TY TNHH CHUỖI CUNG ỨNG LIÊN TRANG': '联庄供应链有限责任公司',
  'KẾ TOÁN_2026': '会计_2026',
  'Tính năng nổi bật': '热门功能',
  'Thêm nhanh': '快速添加',
  'Tổng quan': '总览',
  'Tiền mặt': '现金',
  'Tiền gửi': '银行存款',
  'Mua hàng': '采购',
  'Bán hàng': '销售',
  'Quản lý hóa đơn': '发票管理',
  'Công cụ dụng cụ': '工具用具',
  'Tài sản cố định': '固定资产',
  'Tiền lương': '工资',
  'Thuế': '税务',
  'Giá thành': '成本核算',
  'Tổng hợp': '总账',
  'Báo cáo': '报表',
  'Phiên bản 2026.10': '版本 2026.10',
  'Trợ giúp': '帮助',
  'Giới thiệu kế toán dịch vụ dùng MISA ASP — Nhận ngay 500k': '推介使用 MISA ASP 的服务会计 — 立得 50 万',
  'Nhận thưởng không giới hạn!': '奖励不限量！',
  'Giới thiệu ngay': '立即推荐',
  'Bàn làm việc': '工作台',
  'Biểu đồ': '图表',
  'Tính năng mới': '新功能',
  'Giới thiệu giao diện mới': '新版界面介绍',
  'Lưu ý quan trọng từ 2026': '2026 年重要提示',
  'Bắt đầu sử dụng': '开始使用',
  'Tự động hạch toán hóa đơn đầu vào': '进项发票自动记账',
  'Hóa đơn đầu vào đã xử lý và chờ xác nhận': '进项发票已处理，待确认',
  'Tự động hạch toán hóa đơn đầu ra': '销项发票自动记账',
  'Hóa đơn đầu ra đã xử lý và chờ xác nhận': '销项发票已处理，待确认',
  'Thực hiện hàng loạt nghiệp vụ': '批量执行业务',
  'Thực hiện nhanh nhiều nghiệp vụ trên một màn hình, không cần nhập lại chứng từ.': '在一个界面快速完成多项业务，无需重复录入凭证。',
  'Thực hiện': '执行',
  'Nghiệp vụ thường dùng': '常用业务',
  'Tùy chỉnh': '自定义',
  'Thu tiền mặt': '现金收款',
  'Chi tiền mặt': '现金付款',
  'Thu tiền gửi': '银行收款',
  'Chi tiền gửi': '银行付款',
  'Chứng từ mua hàng': '采购凭证',
  'Chứng từ mua dịch vụ': '服务采购凭证',
  'Chứng từ bán hàng': '销售凭证',
  'Hóa đơn mua hàng gần đây': '最近采购发票',
  'Thêm dòng': '添加行',
  'Số hóa đơn': '发票号',
  'Ngày hóa đơn': '发票日期',
  'Nhà cung cấp': '供应商',
  'Diễn giải': '摘要',
  'Tiền hàng': '货款',
  'Thuế GTGT': '增值税',
  'Tổng tiền': '价税合计',
  'Trạng thái': '状态',
  'Công ty TNHH Vật tư Minh Phát': '明发物资有限责任公司',
  'Mua văn phòng phẩm tháng 10': '10 月办公用品采购',
  'Chờ duyệt': '待审批',
  'Công ty CP Dịch vụ Sao Mai': '晨星服务股份公司',
  'Phí vận chuyển hàng hóa': '货物运输费',
  'Đã duyệt': '已审批',
  'Công ty TNHH Thiết bị Việt An': '越安设备有限责任公司',
  'Mua máy tính để bàn': '购买台式电脑',
  'Từ chối': '已拒绝',
  'Cửa hàng Văn phòng phẩm Hồng Hà': '红河办公用品商店',
  'Mua giấy in và mực máy in': '购买打印纸和打印机墨盒',
  'Công ty TNHH Phần mềm An Bình': '安平软件有限责任公司',
  'Gia hạn bản quyền phần mềm kế toán': '会计软件授权续期',
  'Tổng cộng:': '合计：',
  'Xem tất cả hóa đơn': '查看全部发票',
  'Thêm nhà cung cấp': '添加供应商',
  'Mã nhà cung cấp': '供应商编码',
  'Tên nhà cung cấp': '供应商名称',
  'Số điện thoại': '电话号码',
  'Mã số thuế': '税号',
  'Loại nhà cung cấp': '供应商类型',
  'Trong nước': '国内',
  'Nước ngoài': '国外',
  'Theo dõi công nợ': '跟踪往来账',
  'Lưu': '保存',
  'Hủy bỏ': '取消',
  'Phiếu thu tiền mặt': '现金收款单',
  'Nhúng iframe': '内嵌 iframe',
  'Tiện ích thường dùng': '常用工具',
  'Xem thêm': '查看更多',
  'Nhập khẩu sao kê từ Excel': '从 Excel 导入对账单',
  'Xuất khẩu hàng loạt': '批量导出',
  'Bỏ khóa sổ kỳ kế toán': '取消会计期间结账',
  'Đánh lại số chứng từ': '重排凭证号',
  'Phục hồi chứng từ đã xóa nhầm': '恢复误删凭证',
  'Thiết lập báo cáo tài chính': '设置财务报表',
  'Kiểm tra sổ sách': '检查账簿',
  'Khóa sổ kỳ kế toán': '会计期间结账',
  'Lấy chứng từ từ dữ liệu khác': '从其他数据获取凭证',
  'Kiểm thử bản dịch': '翻译测试',
  'Trang này chứa các trường hợp khó: văn bản động, iframe, Shadow DOM, placeholder, thuộc tính title, aria-label, alt, nút dạng input, số và mã chứng từ không được dịch.': '本页包含各种难题：动态文本、iframe、Shadow DOM、placeholder、title 属性、aria-label、alt、input 按钮，数字和凭证号不应被翻译。',
  'Mở hộp thoại xác nhận': '打开确认对话框',
  'Đổi trạng thái dòng đầu': '切换首行状态',
  'Thêm chứng từ mới': '新增凭证',
  '© 2026 MISA ASP. Trang demo phục vụ kiểm thử tiện ích dịch.': '© 2026 MISA ASP. 本演示页用于测试翻译扩展。',
  'Xác nhận khóa sổ kỳ kế toán': '确认会计期间结账',
  'Bạn có chắc chắn muốn khóa sổ kỳ kế toán tháng 10/2026?': '您确定要结转 2026 年 10 月会计期间吗？',
  'Sau khi khóa, bạn không thể sửa hoặc xóa chứng từ trong kỳ. Hãy kiểm tra kỹ số liệu trước khi tiếp tục.': '结账后，您将无法修改或删除该期间的凭证。请先仔细核对数据。',
  'Tổng số chứng từ:': '凭证总数：',
  'Chênh lệch tạm tính:': '暂估差异：',
  'Người thực hiện:': '执行人：',
  'Nguyễn Thu Trang': '阮秋庄',
  'Để sau': '稍后',
  'Đồng ý': '同意',
  'Tìm kiếm chức năng, chứng từ, khách hàng…': '搜索功能、凭证、客户…',
  'Tải dữ liệu': '加载数据',
  'Thông báo': '通知',
  'Cài đặt': '设置',
  'Mở menu người dùng': '打开用户菜单',
  'Đóng thông báo': '关闭通知',
  'Làm mới dữ liệu': '刷新数据',
  'Xác nhận': '确认',
  'Xem toàn bộ hóa đơn mua hàng': '查看全部采购发票',
  'Đóng biểu mẫu': '关闭表单',
  'Nhập mã nhà cung cấp': '输入供应商编码',
  'Nhập tên nhà cung cấp': '输入供应商名称',
  'Nhập số điện thoại': '输入电话号码',
  'Nhập mã số thuế': '输入税号',
  'Biểu đồ doanh thu theo tháng': '月度收入图表',
  'Đóng hộp thoại': '关闭对话框',
  'Số phiếu: PT000128': '单据号：PT000128',
  'Ngày lập phiếu': '制单日期',
  'Người nộp tiền': '缴款人',
  'Lý do nộp': '缴款事由',
  'Hình thức thanh toán': '支付方式',
  'Chuyển khoản': '银行转账',
  'Số tiền': '金额',
  'Kèm theo': '附件',
  'Phiếu thu được lập tự động từ phân hệ Bán hàng. Vui lòng kiểm tra trước khi in và lưu.': '该收款单由销售模块自动生成。打印和保存前请核对。',
  'Đóng': '关闭',
  'Nhập lý do nộp tiền': '输入缴款事由',
  'Số chứng từ gốc': '原始凭证号',
  'In phiếu': '打印单据',
  'Ghi chú nhanh': '快速备注',
  'Shadow DOM': 'Shadow DOM',
  'Đơn vị chưa đối chiếu số dư tiền gửi ngân hàng. Vui lòng kiểm tra trước khi khóa sổ.': '单位尚未核对银行存款余额。结账前请先检查。',
  'Đối chiếu ngay': '立即核对',
  'Công ty TNHH Dịch vụ Tân Phú': '新富服务有限责任公司',
  'Phí dịch vụ kế toán tháng 10': '10 月会计服务费',
  'Tải dữ liệu lên': '上传数据',
  'Đang xử lý…': '正在处理…',
  'Lưu thay đổi': '保存更改',
  'Bạn có chắc chắn muốn xóa chứng từ này?': '您确定要删除此凭证吗？',
  'Không thể hoàn tác sau khi xóa.': '删除后无法撤销。',
  'Xóa': '删除',
  'Hủy': '取消',
  'Đã sao chép': '已复制',
  'Vui lòng nhập đầy đủ thông tin bắt buộc.': '请填写所有必填信息。',
  'Tìm kiếm…': '搜索…',
  'Tất cả': '全部',
  'Đang tải dữ liệu…': '正在加载数据…',
  'Không có dữ liệu': '暂无数据',
  'Xem chi tiết': '查看详情',
  'Quay lại': '返回',
  'Tiếp tục': '继续',
  'Hoàn thành': '完成',
  'Kho': '仓库',
  'New': '新',
  'MISA ASP': 'MISA ASP',
  '100.210.000 VND': '100.210.000 VND',
  '0 VND': '0 VND',
  'Trang demo': '演示页',
  'Hotline: 1900 1234 · Email: hotro@example.vn · Website: https://example.vn': '热线：1900 1234 · 邮箱：hotro@example.vn · 网站：https://example.vn'
};

const WORDS = {
  'công ty': '公司', 'TNHH': '有限责任公司', 'dịch vụ': '服务', 'hóa đơn': '发票',
  'nhà cung cấp': '供应商', 'chứng từ': '凭证', 'báo cáo': '报表', 'kế toán': '会计',
  'khách hàng': '客户', 'sản phẩm': '产品', 'hàng hóa': '商品', 'doanh thu': '收入',
  'chi phí': '费用', 'lợi nhuận': '利润', 'tài khoản': '账户', 'ngân hàng': '银行',
  'thanh toán': '支付', 'số tiền': '金额', 'ngày': '日期', 'tháng': '月', 'năm': '年',
  'mới': '新建', 'sửa': '编辑', 'xóa': '删除', 'lưu': '保存', 'hủy': '取消',
  'tìm kiếm': '搜索', 'danh sách': '列表', 'chi tiết': '详情', 'tổng': '合计',
  'thuế': '税', 'tiền': '款', 'văn bản': '文本', 'dữ liệu': '数据', 'biểu đồ': '图表',
  'trạng thái': '状态', 'người dùng': '用户', 'màn hình': '界面', 'chức năng': '功能'
};

const state = { calls: 0, texts: 0, batches: [], unmatched: new Set(), seen: new Set(), errors: 0, retryHits: 0, systemPrompt: '' };
let failOnce = true;

function translate(text) {
  const clock = /^Cập nhật lúc (.+)$/.exec(text);
  if (clock) return `更新于 ${clock[1]}`;
  if (Object.prototype.hasOwnProperty.call(PHRASES, text)) return PHRASES[text];
  let out = text;
  for (const [vi, zh] of Object.entries(WORDS).sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(vi, 'gi'), zh);
  }
  if (out !== text) return out;
  // 纯 ASCII（品牌、单号、金额、邮箱、URL）原样保留，并记录未命中
  if (/^[\x20-\x7E]+$/.test(text)) return text;
  state.unmatched.add(text);
  return `〔待译〕${text}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    ...extraHeaders
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST, GET, OPTIONS'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/user/balance') {
    send(res, 200, {
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '88.88', granted_balance: '8.88', topped_up_balance: '80.00' }
      ]
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/state') {
    send(res, 200, {
      calls: state.calls,
      texts: state.texts,
      batches: state.batches.slice(-30),
      unmatched: [...state.unmatched],
      seen: [...state.seen],
      errors: state.errors,
      retryHits: state.retryHits,
      systemPrompt: state.systemPrompt
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/reset') {
    state.calls = 0;
    state.texts = 0;
    state.batches = [];
    state.unmatched = new Set();
    state.seen = new Set();
    state.errors = 0;
    state.retryHits = 0;
    state.systemPrompt = '';
    failOnce = true;
    state.batches.push({ resetAt: new Date().toISOString() });
    send(res, 200, { ok: true });
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/chat/completions') {
    send(res, 404, { error: { message: 'Not found' } });
    return;
  }

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7).length < 6) {
    state.errors += 1;
    send(res, 401, { error: { message: 'Authentication Fails, Your api key is invalid', type: 'authentication_error' } });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    send(res, 400, { error: { message: 'Invalid JSON body' } });
    return;
  }

  state.systemPrompt = (payload.messages || []).find((m) => m.role === 'system')?.content || '';

  let texts = [];
  try {
    const userMessage = (payload.messages || []).find((m) => m.role === 'user');
    texts = JSON.parse(userMessage.content).texts || [];
  } catch {
    send(res, 400, { error: { message: 'Cannot parse texts' } });
    return;
  }

  if (texts.some((t) => String(t).includes('TRIGGER_RETRY')) && failOnce) {
    failOnce = false;
    state.retryHits += 1;
    send(res, 429, { error: { message: 'Rate limit reached (mock)' } });
    return;
  }
  if (texts.some((t) => String(t).includes('TRIGGER_FATAL'))) {
    state.errors += 1;
    send(res, 401, { error: { message: 'Authentication Fails (mock fatal)' } });
    return;
  }

  state.calls += 1;
  state.texts += texts.length;
  texts.forEach((t) => state.seen.add(String(t)));
  state.batches.push({ at: Date.now(), count: texts.length, sample: texts.slice(0, 3) });

  const translations = texts.map((t) => translate(String(t)));
  const content = JSON.stringify({ translations });

  setTimeout(() => {
    send(res, 200, {
      id: `mock-${state.calls}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: payload.model || 'deepseek-flash',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: (() => {
        const promptTokens = 120 + texts.join('').length;
        const hit = Math.floor(promptTokens * 0.5);
        const completionTokens = translations.join('').length;
        return {
          prompt_tokens: promptTokens,
          prompt_cache_hit_tokens: hit,
          prompt_cache_miss_tokens: promptTokens - hit,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens
        };
      })()
    });
  }, 40);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-deepseek] listening on http://127.0.0.1:${PORT}`);
});

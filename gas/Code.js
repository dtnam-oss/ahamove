// Backend of the order-sorting tool (Google Apps Script web app).
// GET ?action=data returns a minimal lookup payload: order code -> district + location config.
// Customer PII (name, phone, address) never leaves the sheet.
//
// The UI is hosted outside Apps Script (GitHub Pages, see web/) because the Apps Script
// iframe does not grant the `camera` permission, so live camera scanning cannot work inside it.

// SHEET_ID is defined in config.js (git-ignored, pushed by clasp). See config.example.js.
const DATA_SHEET = 'data';
const CONFIG_SHEET = 'config';
const APP_URL = 'https://dtnam-oss.github.io/ahamove/';

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'data') return jsonOutput_(safeLookupData_());

  // Old links to this web app: point users to the hosted UI (top navigation needs a user click).
  return HtmlService.createHtmlOutput(
    '<div style="font-family:system-ui;text-align:center;padding:48px 16px">' +
      '<h2>Chia chọn đơn đã chuyển sang địa chỉ mới</h2>' +
      '<p><a href="' + APP_URL + '" target="_top" style="font-size:1.3rem">Mở công cụ chia chọn đơn</a></p>' +
      '<p style="color:#666">' + APP_URL + '</p>' +
    '</div>'
  )
    .setTitle('Chia chọn đơn')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Errors are returned as {error} with HTTP 200 (ContentService cannot set status codes). */
function safeLookupData_() {
  try {
    return getLookupData();
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

/** Read a tab as display strings; returns column-index lookup + data rows. */
function readTable_(spreadsheet, name, requiredColumns) {
  const sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error('Không tìm thấy sheet "' + name + '"');
  // Display values keep codes as text exactly as shown (no number/date coercion).
  const values = sheet.getDataRange().getDisplayValues();
  const header = (values[0] || []).map(function (h) { return String(h).trim(); });
  const col = {};
  requiredColumns.forEach(function (c) {
    col[c] = header.indexOf(c);
    if (col[c] < 0) throw new Error('Sheet "' + name + '" thiếu cột ' + c);
  });
  return { col: col, rows: values.slice(1) };
}

/** Called from the client via google.script.run. */
function getLookupData() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const data = readTable_(ss, DATA_SHEET, ['partner_order_code', 'district']);
  const conf = readTable_(ss, CONFIG_SHEET, ['ten_vi_tri', 'khu_vuc']);

  const orders = {};
  data.rows.forEach(function (r) {
    const code = String(r[data.col.partner_order_code]).trim().toUpperCase();
    if (code) orders[code] = String(r[data.col.district]).trim();
  });

  const config = [];
  conf.rows.forEach(function (r) {
    const name = String(r[conf.col.ten_vi_tri]).trim();
    if (!name) return;
    const areas = String(r[conf.col.khu_vuc])
      .split(/[,;\n]/)
      .map(function (a) { return a.trim(); })
      .filter(String);
    config.push({ ten_vi_tri: name, khu_vuc: areas });
  });

  return {
    updatedAt: new Date().toISOString(),
    orderCount: Object.keys(orders).length,
    orders: orders,
    config: config,
  };
}

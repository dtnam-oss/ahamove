// Backend of the order-sorting tool (Google Apps Script web app).
// GET ?action=data returns a minimal lookup payload: order code -> district/ward + location and route config.
// GET ?action=locate&code=X returns the map point of one order (see locate.js).
// GET ?action=trips&day=dd/MM/yyyy lists the trips of a day; POST {action:'trip', plate, codes} saves one (see trips.js).
// Customer PII (name, phone, address) never leaves the sheet.
//
// The UI is hosted outside Apps Script (GitHub Pages, see web/) because the Apps Script
// iframe does not grant the `camera` permission, so live camera scanning cannot work inside it.

// SHEET_ID is defined in config.js (git-ignored, pushed by clasp). See config.example.js.
const DATA_SHEET = 'raw_data'; // order source (columns found by header name)
const CONFIG_SHEET = 'config';
const BACKLOG_SHEET = 'back_log';
const BACKLOG_DAYS_COLUMN = 'Còn lại (ngày), âm là quá hạn'; // days left to the deadline, negative = overdue
const APP_URL = 'https://dtnam-oss.github.io/ahamove/';

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'data') return jsonOutput_(safeLookupData_());
  if (action === 'locate') return jsonOutput_(safely_(function () { return locateOrder(e.parameter.code); }));
  if (action === 'trips') return jsonOutput_(safely_(function () { return listTrips(e.parameter.day); }));

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
function safely_(fn) {
  try {
    return fn();
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

function safeLookupData_() {
  return safely_(getLookupData);
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
  return { col: col, header: header, rows: values.slice(1) };
}

/** Build the lookup payload (served by doGet ?action=data). */
function getLookupData() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  // tracking_number = "Mã vận đơn" printed on the waybill label.
  const data = readTable_(ss, DATA_SHEET, ['tracking_number', 'status', 'district']);
  const conf = readTable_(ss, CONFIG_SHEET, ['ten_vi_tri', 'khu_vuc']);

  // orders: code -> { district, ward, status }. Status is passed raw; the client owns the cancel rule.
  // ward is parsed from the address (dropoff, optional); the address itself never leaves the sheet.
  const dropoff = data.header.indexOf('dropoff');
  const orders = {};
  data.rows.forEach(function (r) {
    const code = String(r[data.col.tracking_number]).trim().toUpperCase();
    if (!code) return;
    orders[code] = {
      district: String(r[data.col.district]).trim(),
      ward: dropoff < 0 ? '' : parseWard_(r[dropoff]),
      status: String(r[data.col.status]).trim(),
    };
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

  const backlog = readBacklog_(ss);
  const routes = readRoutes_(ss); // see routes.js

  return {
    updatedAt: new Date().toISOString(),
    orderCount: Object.keys(orders).length,
    orders: orders,
    config: config,
    backlog: backlog.days, // code -> days left (display string), or null when back_log is unreadable
    backlogError: backlog.error,
    routes: routes.routes, // [{ten_tuyen, phuong_xa, quan_huyen}] from config_tuyen, or null when unreadable
    routesError: routes.error,
  };
}

/** back_log is optional for sorting: a problem there is reported, never breaks the main payload. */
function readBacklog_(ss) {
  try {
    const table = readTable_(ss, BACKLOG_SHEET, ['tracking_number', BACKLOG_DAYS_COLUMN]);
    const days = {};
    table.rows.forEach(function (r) {
      const code = String(r[table.col.tracking_number]).trim().toUpperCase();
      if (code && !(code in days)) days[code] = String(r[table.col[BACKLOG_DAYS_COLUMN]]).trim(); // first row wins
    });
    return { days: days, error: '' };
  } catch (err) {
    return { days: null, error: String((err && err.message) || err) };
  }
}

/**
 * Body is JSON sent as text/plain (a CORS "simple" request, so the browser needs no preflight).
 * Errors are returned as {error}, like doGet.
 */
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action !== 'trip') throw new Error('Thao tác không hợp lệ');
    return jsonOutput_(createTrip(body.plate, body.codes));
  } catch (err) {
    return jsonOutput_({ error: String((err && err.message) || err) });
  }
}

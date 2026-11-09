// Backend of the order-sorting tool (Google Apps Script web app).
// GET ?action=data returns a minimal lookup payload: order code -> district + location config.
// POST {action:'write', cell, code} appends a scanned code to sheet `data_don` (see writeScan).
// Customer PII (name, phone, address) never leaves the sheet.
//
// The UI is hosted outside Apps Script (GitHub Pages, see web/) because the Apps Script
// iframe does not grant the `camera` permission, so live camera scanning cannot work inside it.

// SHEET_ID is defined in config.js (git-ignored, pushed by clasp). See config.example.js.
const DATA_SHEET = 'data';
const CONFIG_SHEET = 'config';
const SCAN_SHEET = 'data_don';
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

/** Build the lookup payload (served by doGet ?action=data). */
function getLookupData() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  // tracking_number = "Mã vận đơn" printed on the waybill label.
  const data = readTable_(ss, DATA_SHEET, ['tracking_number', 'status', 'district']);
  const conf = readTable_(ss, CONFIG_SHEET, ['ten_vi_tri', 'khu_vuc']);

  // orders: code -> { district, status }. Status is passed raw; the client owns the cancel rule.
  const orders = {};
  data.rows.forEach(function (r) {
    const code = String(r[data.col.tracking_number]).trim().toUpperCase();
    if (!code) return;
    orders[code] = {
      district: String(r[data.col.district]).trim(),
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

  return {
    updatedAt: new Date().toISOString(),
    orderCount: Object.keys(orders).length,
    orders: orders,
    config: config,
  };
}

/**
 * Body is JSON sent as text/plain (a CORS "simple" request, so the browser needs no preflight).
 * Errors are returned as {error}, like doGet.
 */
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action !== 'write') throw new Error('Thao tác không hợp lệ');
    return jsonOutput_(writeScan(body.cell, body.code));
  } catch (err) {
    return jsonOutput_({ error: String((err && err.message) || err) });
  }
}

/**
 * Write a scanned code into `data_don` at `cell` (e.g. "C3"), or, when that cell is taken,
 * into the first empty cell below it in the same column. Never overwrites existing values,
 * so several scanners can share one column. Returns the cell actually written.
 */
function writeScan(cell, code) {
  const ref = parseCell_(cell);
  const value = String(code == null ? '' : code).trim().toUpperCase();
  // Codes only: letters/digits plus . _ - and starting with a letter/digit, so a scan can never
  // become a formula (=, +, @) in a sheet anyone with the API URL can write to.
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(value)) throw new Error('Mã không hợp lệ: ' + value);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // serialize writers so two scans never claim the same empty cell
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SCAN_SHEET);
    if (!sheet) throw new Error('Không tìm thấy sheet "' + SCAN_SHEET + '"');
    if (ref.col > sheet.getMaxColumns()) throw new Error('Ô ' + cell + ' nằm ngoài sheet "' + SCAN_SHEET + '"');

    let row = ref.row;
    const lastRow = sheet.getLastRow();
    if (lastRow >= row) {
      const values = sheet.getRange(row, ref.col, lastRow - row + 1, 1).getDisplayValues();
      let i = 0;
      while (i < values.length && String(values[i][0]).trim() !== '') i++;
      row += i;
    }
    const maxRows = sheet.getMaxRows();
    if (row > maxRows) sheet.insertRowsAfter(maxRows, row - maxRows);

    // Plain-text format keeps codes exactly as scanned (no number/date coercion).
    sheet.getRange(row, ref.col).setNumberFormat('@').setValue(value);
    SpreadsheetApp.flush();
    return { ok: true, cell: columnName_(ref.col) + row, code: value };
  } finally {
    lock.releaseLock();
  }
}

/** "c3" -> {col: 3, row: 3}. Column letters A..ZZZ, row >= 1. */
function parseCell_(cell) {
  const m = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(String(cell == null ? '' : cell).trim().toUpperCase());
  if (!m) throw new Error('Ô không hợp lệ: ' + cell);
  let col = 0;
  for (let i = 0; i < m[1].length; i++) col = col * 26 + (m[1].charCodeAt(i) - 64);
  return { col: col, row: Number(m[2]) };
}

/** 3 -> "C", 27 -> "AA". */
function columnName_(col) {
  let name = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

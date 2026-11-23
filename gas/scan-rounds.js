// Scan rounds by day + warehouse: orders scanned on the device and saved once when the user finishes.
//   "Đồng kiểm" (received orders): POST {action:'dongkiem', ngay, kho, codes} -> sheet data_dong_kiem
//                                  + a Telegram notice to the group (warehouse + picked-up codes)
//   "Trả hàng" (returned orders):  POST {action:'trahang',  ngay, kho, codes} -> sheet tra_hang
//   "Kiểm kho" (stock check):      POST {action:'kiemkho',  ngay, codes}      -> sheet kiem_kho
// Đồng kiểm checks each scan against the pending pick-up list: GET ?action=pendingpu -> pendingPu().
// Each sheet gets one row per order; its columns are found by header name, so a sheet made by hand
// with other columns (or another order) keeps working; missing headers are added at the end.

const SCAN_ROUND_WAREHOUSES = ['Thuận Thành', 'Yên Phong'];
const SCAN_ROUND_CODE = /^[A-Z0-9]{8}$/; // a waybill code: 8 letters/digits, e.g. GYE7WB4C
const SCAN_ROUND_MAX_CODES = 5000;

// Per kind: sheet name, its day / warehouse / code column headers, and the words used in error messages.
// Optional: khoCol null = no warehouse; fields + lookup = extra columns filled per code by the server;
// noTime = no thoi_gian column; notify(day, kho, codes) runs after the rows are saved and its status is
// returned as `telegram` (a failed notice never fails the save, so retrying cannot duplicate rows).
// Đồng kiểm also posts the warehouse + the picked-up codes to the Telegram group (telegram.js).
const DONG_KIEM = {
  sheet: 'data_dong_kiem', dayCol: 'ngay', khoCol: 'kho', codeCol: 'ma_don', dayName: 'Ngày nhận', khoName: 'Kho nhận',
  notify: notifyDongKiem_,
};
const TRA_HANG = { sheet: 'tra_hang', dayCol: 'ngay_tra', khoCol: 'kho_tra', codeCol: 'tracking_number', dayName: 'Ngày trả', khoName: 'Kho trả' };
// "Kiểm kho": one row per scanned order with its state + deadline result, read from raw_data at save time
// (never trusted from the device). An order missing from raw_data is still recorded.
const KIEM_KHO = {
  sheet: 'kiem_kho', dayCol: 'ngay_kiem', khoCol: null, codeCol: 'ma_don', dayName: 'Ngày kiểm kho',
  fields: ['trang_thai', 'ket_qua'], lookup: kiemKhoLookup_, noTime: true,
};
const KIEM_KHO_NOT_FOUND = 'Không có trong raw_data';

// Orders waiting for pick-up, in another spreadsheet (PENDING_PU_SHEET_ID, config.js), read only.
const PENDING_PU_SHEET = 'export_raw_pending_pu';

/** Column (1-based) of each header name, adding the missing headers after the last column. */
function scanRoundColumns_(sheet, header) {
  const lastCol = sheet.getLastColumn();
  const head = lastCol ? sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h).trim(); }) : [];
  const col = {};
  let next = head.length;
  header.forEach(function (name) {
    const at = head.indexOf(name);
    if (at >= 0) { col[name] = at + 1; return; }
    col[name] = ++next;
    sheet.getRange(1, next, 1, 1).setValues([[name]]);
  });
  return { col: col, width: next };
}

/**
 * Save one round of the given kind (DONG_KIEM, TRA_HANG or KIEM_KHO). ngay = 'dd/MM/yyyy',
 * kho = one of SCAN_ROUND_WAREHOUSES (ignored when the kind has no warehouse), codes = scanned waybill codes.
 * Returns {ok: true, count, thoi_gian}.
 */
function saveScanRound_(kind, ngay, kho, codes) {
  const day = String(ngay == null ? '' : ngay).trim();
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(day)) throw new Error(kind.dayName + ' không hợp lệ: ' + day);
  const warehouse = String(kho == null ? '' : kho).trim();
  if (kind.khoCol && SCAN_ROUND_WAREHOUSES.indexOf(warehouse) < 0) throw new Error(kind.khoName + ' không hợp lệ: ' + warehouse);
  if (!Array.isArray(codes) || !codes.length) throw new Error('Chưa quét đơn nào');
  if (codes.length > SCAN_ROUND_MAX_CODES) throw new Error('Quá ' + SCAN_ROUND_MAX_CODES + ' đơn');
  const list = [];
  codes.forEach(function (c) {
    const code = String(c == null ? '' : c).trim().toUpperCase();
    if (!SCAN_ROUND_CODE.test(code)) throw new Error('Mã không hợp lệ: ' + code);
    if (list.indexOf(code) < 0) list.push(code);
  });

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const extra = kind.lookup ? kind.lookup(ss, list) : {}; // code -> {field: value}, read before taking the lock
  const header = [kind.dayCol].concat(kind.khoCol ? [kind.khoCol] : [], [kind.codeCol], kind.fields || [],
    kind.noTime ? [] : ['thoi_gian']);
  let result;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    let sheet = ss.getSheetByName(kind.sheet);
    if (!sheet) {
      sheet = ss.insertSheet(kind.sheet);
      sheet.setFrozenRows(1);
    }
    const layout = scanRoundColumns_(sheet, header);
    const time = tripNow_().time; // trips.js
    const values = list.map(function (code) {
      const row = new Array(layout.width).fill('');
      row[layout.col[kind.dayCol] - 1] = day;
      if (kind.khoCol) row[layout.col[kind.khoCol] - 1] = warehouse;
      row[layout.col[kind.codeCol] - 1] = code;
      (kind.fields || []).forEach(function (f) { row[layout.col[f] - 1] = (extra[code] || {})[f] || ''; });
      if (!kind.noTime) row[layout.col.thoi_gian - 1] = time;
      return row;
    });
    // Plain text keeps the day and time as written (no date coercion).
    sheet.getRange(sheet.getLastRow() + 1, 1, values.length, layout.width).setNumberFormat('@').setValues(values);
    SpreadsheetApp.flush();
    result = { ok: true, count: list.length, thoi_gian: time };
  } finally {
    lock.releaseLock();
  }
  if (kind.notify) result.telegram = kind.notify(day, warehouse, list); // network call outside the lock
  return result;
}

/** Telegram notice of a saved Đồng kiểm round: warehouse + day, then the picked-up codes one per line. */
function notifyDongKiem_(day, kho, codes) {
  const header = 'Đồng kiểm kho ' + kho + ' · ngày nhận ' + day + '\nĐã lấy thành công ' + codes.length + ' đơn:';
  return sendTelegramAll_(telegramMessages_(header, codes));
}

/**
 * Pending pick-up orders for "Đồng kiểm": {orders: {CODE: warehouse}, count, updatedAt}.
 * Only the code and its pick-up warehouse (wh_pickup) leave the sheet.
 */
function pendingPu() {
  if (!PENDING_PU_SHEET_ID || PENDING_PU_SHEET_ID === 'YOUR_PENDING_PU_SHEET_ID') throw new Error('Chưa cấu hình PENDING_PU_SHEET_ID');
  const sheet = SpreadsheetApp.openById(PENDING_PU_SHEET_ID).getSheetByName(PENDING_PU_SHEET);
  if (!sheet) throw new Error('Không tìm thấy sheet ' + PENDING_PU_SHEET);
  const values = sheet.getDataRange().getDisplayValues();
  const head = (values[0] || []).map(function (h) { return String(h).trim().toLowerCase(); });
  const codeAt = head.indexOf('tracking_number');
  const khoAt = head.indexOf('wh_pickup');
  if (codeAt < 0 || khoAt < 0) throw new Error('Sheet ' + PENDING_PU_SHEET + ' thiếu cột tracking_number hoặc wh_pickup');
  const orders = {};
  let count = 0;
  for (let i = 1; i < values.length; i++) {
    const code = String(values[i][codeAt]).trim().toUpperCase();
    const kho = String(values[i][khoAt]).trim();
    if (!code || !kho) continue;
    if (!orders[code]) count++;
    orders[code] = kho;
  }
  return { orders: orders, count: count, updatedAt: new Date().toISOString() };
}

/** "Đồng kiểm": orders received at a warehouse on a receiving day. */
function saveDongKiem(ngay, kho, codes) {
  return saveScanRound_(DONG_KIEM, ngay, kho, codes);
}

/** "Trả hàng": orders returned at a warehouse on a return day. */
function saveTraHang(ngay, kho, codes) {
  return saveScanRound_(TRA_HANG, ngay, kho, codes);
}

/** "Kiểm kho": a stock-check session of one day; state + result come from raw_data. */
function saveKiemKho(ngay, codes) {
  return saveScanRound_(KIEM_KHO, ngay, '', codes);
}

/** code -> {trang_thai, ket_qua} from raw_data (first row wins); codes missing there get KIEM_KHO_NOT_FOUND. */
function kiemKhoLookup_(ss, codes) {
  const table = readTable_(ss, DATA_SHEET, ['tracking_number', 'trang_thai', 'ket_qua']); // Code.js
  const wanted = {};
  codes.forEach(function (c) { wanted[c] = true; });
  const out = {};
  table.rows.forEach(function (r) {
    const code = String(r[table.col.tracking_number]).trim().toUpperCase();
    if (!wanted[code] || out[code]) return;
    out[code] = { trang_thai: String(r[table.col.trang_thai]).trim(), ket_qua: String(r[table.col.ket_qua]).trim() };
  });
  codes.forEach(function (c) { if (!out[c]) out[c] = { trang_thai: KIEM_KHO_NOT_FOUND, ket_qua: '' }; });
  return out;
}

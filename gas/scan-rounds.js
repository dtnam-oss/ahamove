// Scan rounds by day + warehouse: orders scanned on the device and saved once when the user finishes.
//   "Đồng kiểm" (received orders): POST {action:'dongkiem', ngay, kho, codes} -> sheet data_dong_kiem
//   "Trả hàng" (returned orders):  POST {action:'trahang',  ngay, kho, codes} -> sheet tra_hang
// Each sheet gets one row per order; its columns are found by header name, so a sheet made by hand
// with other columns (or another order) keeps working; missing headers are added at the end.

const SCAN_ROUND_WAREHOUSES = ['Thuận Thành', 'Yên Phong'];
const SCAN_ROUND_CODE = /^[A-Z0-9]{8}$/; // a waybill code: 8 letters/digits, e.g. GYE7WB4C
const SCAN_ROUND_MAX_CODES = 5000;

// Per kind: sheet name, its day and warehouse column headers, and the words used in error messages.
const DONG_KIEM = { sheet: 'data_dong_kiem', dayCol: 'ngay_nhan', khoCol: 'kho_nhan', dayName: 'Ngày nhận', khoName: 'Kho nhận' };
const TRA_HANG = { sheet: 'tra_hang', dayCol: 'ngay_tra', khoCol: 'kho_tra', dayName: 'Ngày trả', khoName: 'Kho trả' };

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
 * Save one round of the given kind (DONG_KIEM or TRA_HANG). ngay = 'dd/MM/yyyy',
 * kho = one of SCAN_ROUND_WAREHOUSES, codes = scanned waybill codes. Returns {ok: true, count, thoi_gian}.
 */
function saveScanRound_(kind, ngay, kho, codes) {
  const day = String(ngay == null ? '' : ngay).trim();
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(day)) throw new Error(kind.dayName + ' không hợp lệ: ' + day);
  const warehouse = String(kho == null ? '' : kho).trim();
  if (SCAN_ROUND_WAREHOUSES.indexOf(warehouse) < 0) throw new Error(kind.khoName + ' không hợp lệ: ' + warehouse);
  if (!Array.isArray(codes) || !codes.length) throw new Error('Chưa quét đơn nào');
  if (codes.length > SCAN_ROUND_MAX_CODES) throw new Error('Quá ' + SCAN_ROUND_MAX_CODES + ' đơn');
  const list = [];
  codes.forEach(function (c) {
    const code = String(c == null ? '' : c).trim().toUpperCase();
    if (!SCAN_ROUND_CODE.test(code)) throw new Error('Mã không hợp lệ: ' + code);
    if (list.indexOf(code) < 0) list.push(code);
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(kind.sheet);
    if (!sheet) {
      sheet = ss.insertSheet(kind.sheet);
      sheet.setFrozenRows(1);
    }
    const layout = scanRoundColumns_(sheet, [kind.dayCol, kind.khoCol, 'tracking_number', 'thoi_gian']);
    const time = tripNow_().time; // trips.js
    const values = list.map(function (code) {
      const row = new Array(layout.width).fill('');
      row[layout.col[kind.dayCol] - 1] = day;
      row[layout.col[kind.khoCol] - 1] = warehouse;
      row[layout.col.tracking_number - 1] = code;
      row[layout.col.thoi_gian - 1] = time;
      return row;
    });
    // Plain text keeps the day and time as written (no date coercion).
    sheet.getRange(sheet.getLastRow() + 1, 1, values.length, layout.width).setNumberFormat('@').setValues(values);
    SpreadsheetApp.flush();
    return { ok: true, count: list.length, thoi_gian: time };
  } finally {
    lock.releaseLock();
  }
}

/** "Đồng kiểm": orders received at a warehouse on a receiving day. */
function saveDongKiem(ngay, kho, codes) {
  return saveScanRound_(DONG_KIEM, ngay, kho, codes);
}

/** "Trả hàng": orders returned at a warehouse on a return day. */
function saveTraHang(ngay, kho, codes) {
  return saveScanRound_(TRA_HANG, ngay, kho, codes);
}

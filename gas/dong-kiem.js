// "Đồng kiểm": orders received at a warehouse on a given day, scanned on the device and saved once
// when the user finishes: POST {action:'dongkiem', ngay, kho, codes} -> saveDongKiem.
// Sheet data_dong_kiem gets one row per order; its columns are found by header name, so a sheet made
// by hand with other columns (or another order) keeps working; missing headers are added at the end.

const DONG_KIEM_SHEET = 'data_dong_kiem';
const DONG_KIEM_HEADER = ['ngay_nhan', 'kho_nhan', 'tracking_number', 'thoi_gian'];
const DONG_KIEM_WAREHOUSES = ['Thuận Thành', 'Yên Phong'];
const DONG_KIEM_CODE = /^[A-Z0-9]{8}$/; // a waybill code: 8 letters/digits, e.g. GYE7WB4C
const DONG_KIEM_MAX_CODES = 5000;

/** Column (1-based) of each DONG_KIEM_HEADER name, adding the missing headers after the last column. */
function dongKiemColumns_(sheet) {
  const lastCol = sheet.getLastColumn();
  const head = lastCol ? sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h).trim(); }) : [];
  const col = {};
  let next = head.length;
  DONG_KIEM_HEADER.forEach(function (name) {
    const at = head.indexOf(name);
    if (at >= 0) { col[name] = at + 1; return; }
    col[name] = ++next;
    sheet.getRange(1, next, 1, 1).setValues([[name]]);
  });
  return { col: col, width: next };
}

/**
 * Save one "đồng kiểm" round. ngay = receiving day 'dd/MM/yyyy', kho = one of DONG_KIEM_WAREHOUSES,
 * codes = scanned waybill codes (8 letters/digits). Returns {ok: true, count, thoi_gian}.
 */
function saveDongKiem(ngay, kho, codes) {
  const day = String(ngay == null ? '' : ngay).trim();
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(day)) throw new Error('Ngày nhận không hợp lệ: ' + day);
  const warehouse = String(kho == null ? '' : kho).trim();
  if (DONG_KIEM_WAREHOUSES.indexOf(warehouse) < 0) throw new Error('Kho nhận không hợp lệ: ' + warehouse);
  if (!Array.isArray(codes) || !codes.length) throw new Error('Chưa quét đơn nào');
  if (codes.length > DONG_KIEM_MAX_CODES) throw new Error('Quá ' + DONG_KIEM_MAX_CODES + ' đơn');
  const list = [];
  codes.forEach(function (c) {
    const code = String(c == null ? '' : c).trim().toUpperCase();
    if (!DONG_KIEM_CODE.test(code)) throw new Error('Mã không hợp lệ: ' + code);
    if (list.indexOf(code) < 0) list.push(code);
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(DONG_KIEM_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(DONG_KIEM_SHEET);
      sheet.setFrozenRows(1);
    }
    const layout = dongKiemColumns_(sheet);
    const time = tripNow_().time; // trips.js
    const values = list.map(function (code) {
      const row = new Array(layout.width).fill('');
      row[layout.col.ngay_nhan - 1] = day;
      row[layout.col.kho_nhan - 1] = warehouse;
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

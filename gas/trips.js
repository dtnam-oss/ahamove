// Trips ("Chuyến đi"): a truck plate (BKS) plus the orders loaded onto it.
// The scanner checks each order on the device and sends the whole trip once, when the user finishes:
// POST {action:'trip', plate, codes} -> createTrip; GET ?action=trips&day=dd/MM/yyyy -> listTrips.
// Sheet chuyen_di holds one row per order, so it can be filtered or pivoted directly in Sheets.

const TRIP_SHEET = 'chuyen_di';
const TRIP_HEADER = ['ma_chuyen', 'bks', 'thoi_gian', 'tracking_number'];
const TRIP_TZ = 'Asia/Ho_Chi_Minh';
const TRIP_MAX_CODES = 2000;
// Letters/digits first, so neither a plate nor a code can become a formula (=, +, @) in the sheet.
const PLATE_PATTERN = /^[A-Z0-9][A-Z0-9 .-]{3,14}$/;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;

/** "29c-123.45 " -> "29C-123.45" (upper case, single spaces). */
function normalizePlate_(plate) {
  return String(plate == null ? '' : plate).trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Today and now in Vietnam time: {day: 'dd/MM/yyyy', time: 'dd/MM/yyyy HH:mm:ss', stamp: 'yyMMdd'}. */
function tripNow_() {
  const now = new Date();
  return {
    day: Utilities.formatDate(now, TRIP_TZ, 'dd/MM/yyyy'),
    time: Utilities.formatDate(now, TRIP_TZ, 'dd/MM/yyyy HH:mm:ss'),
    stamp: Utilities.formatDate(now, TRIP_TZ, 'yyMMdd'),
  };
}

function tripSheet_(ss) {
  let sheet = ss.getSheetByName(TRIP_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(TRIP_SHEET);
    sheet.getRange(1, 1, 1, TRIP_HEADER.length).setValues([TRIP_HEADER]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Rows of chuyen_di as objects (header row skipped, blank rows dropped). */
function readTripRows_(sheet) {
  return sheet.getDataRange().getDisplayValues().slice(1)
    .map(function (r) {
      return {
        ma_chuyen: String(r[0]).trim(),
        bks: String(r[1]).trim(),
        thoi_gian: String(r[2]).trim(),
        code: String(r[3]).trim().toUpperCase(),
      };
    })
    .filter(function (r) { return r.ma_chuyen && r.code; });
}

function onDay_(row, day) {
  return row.thoi_gian.indexOf(day + ' ') === 0;
}

/**
 * Save a finished trip. Orders already in another trip today are refused as a whole
 * ({ok: false, conflicts: [{code, ma_chuyen, bks}]}) so the scanner can drop them and finish again;
 * this catches two devices loading the same order at the same time.
 * Returns {ok: true, ma_chuyen, bks, thoi_gian, codes}. Trip id = CD<yyMMdd>-<nn>, numbered per day.
 */
function createTrip(plate, codes) {
  const bks = normalizePlate_(plate);
  if (!PLATE_PATTERN.test(bks)) throw new Error('Biển kiểm soát không hợp lệ: ' + bks);
  if (!Array.isArray(codes) || !codes.length) throw new Error('Chuyến chưa có đơn');
  if (codes.length > TRIP_MAX_CODES) throw new Error('Chuyến quá ' + TRIP_MAX_CODES + ' đơn');
  const list = [];
  codes.forEach(function (c) {
    const code = String(c == null ? '' : c).trim().toUpperCase();
    if (!CODE_PATTERN.test(code)) throw new Error('Mã không hợp lệ: ' + code);
    if (list.indexOf(code) < 0) list.push(code);
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // serialize writers: one trip number per trip, conflicts checked against saved rows
  try {
    const sheet = tripSheet_(SpreadsheetApp.openById(SHEET_ID));
    const now = tripNow_();
    const todayRows = readTripRows_(sheet).filter(function (r) { return onDay_(r, now.day); });

    const taken = {};
    todayRows.forEach(function (r) { taken[r.code] = r; });
    const conflicts = list.filter(function (c) { return taken[c]; })
      .map(function (c) { return { code: c, ma_chuyen: taken[c].ma_chuyen, bks: taken[c].bks }; });
    if (conflicts.length) return { ok: false, conflicts: conflicts };

    const prefix = 'CD' + now.stamp + '-';
    let last = 0;
    todayRows.forEach(function (r) {
      if (r.ma_chuyen.indexOf(prefix) === 0) last = Math.max(last, Number(r.ma_chuyen.slice(prefix.length)) || 0);
    });
    const id = prefix + String(last + 1).padStart(2, '0');

    // Plain-text format keeps codes, plates and times exactly as written (no number/date coercion).
    sheet.getRange(sheet.getLastRow() + 1, 1, list.length, TRIP_HEADER.length)
      .setNumberFormat('@')
      .setValues(list.map(function (c) { return [id, bks, now.time, c]; }));
    SpreadsheetApp.flush();
    return { ok: true, ma_chuyen: id, bks: bks, thoi_gian: now.time, codes: list };
  } finally {
    lock.releaseLock();
  }
}

/** Trips of one day (default today), newest first: {day, trips: [{ma_chuyen, bks, thoi_gian, codes}]}. */
function listTrips(day) {
  const wanted = day ? String(day).trim() : tripNow_().day;
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(wanted)) throw new Error('Ngày không hợp lệ: ' + wanted);
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRIP_SHEET);
  const byId = {};
  const trips = [];
  (sheet ? readTripRows_(sheet) : []).forEach(function (r) {
    if (!onDay_(r, wanted)) return;
    if (!byId[r.ma_chuyen]) {
      byId[r.ma_chuyen] = { ma_chuyen: r.ma_chuyen, bks: r.bks, thoi_gian: r.thoi_gian, codes: [] };
      trips.push(byId[r.ma_chuyen]);
    }
    byId[r.ma_chuyen].codes.push(r.code);
  });
  trips.reverse(); // rows are appended in creation order
  return { day: wanted, trips: trips };
}

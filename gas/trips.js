// Trips ("Chuyến đi"): a truck plate (BKS) plus the orders loaded onto it.
// The scanner checks each order on the device and sends the whole trip once, when the user finishes:
//   POST {action:'trip', plate, codes}               -> createTrip
//   POST {action:'endTrip', ma_chuyen, failed, checked} -> endTrip (after the FAILED orders were scanned back)
//   GET  ?action=trips&day=dd/MM/yyyy                -> listTrips
//   GET  ?action=opentrips                           -> openTrips (orders still on a truck, any day)
// Sheet chuyen_di holds one row per order, so it can be filtered or pivoted directly in Sheets.
// An order on a trip that is not ended yet cannot join another trip; ending a trip frees its orders.

const TRIP_SHEET = 'chuyen_di';
const TRIP_HEADER = ['ma_chuyen', 'bks', 'thoi_gian', 'tracking_number', 'ket_thuc', 'ban_kiem'];
const TRIP_TZ = 'Asia/Ho_Chi_Minh';
const TRIP_MAX_CODES = 2000;
const CHECKED = 'Đã kiểm'; // ban_kiem of a FAILED order scanned back at the end of the trip
const MISSING = 'Thiếu'; // ban_kiem of a FAILED order not scanned back
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

/** Upper-cased, de-duplicated codes; throws on anything that is not a plain code. */
function cleanCodes_(codes) {
  if (!Array.isArray(codes)) return [];
  const list = [];
  codes.forEach(function (c) {
    const code = String(c == null ? '' : c).trim().toUpperCase();
    if (!CODE_PATTERN.test(code)) throw new Error('Mã không hợp lệ: ' + code);
    if (list.indexOf(code) < 0) list.push(code);
  });
  return list;
}

/**
 * chuyen_di with its rows. Creates the sheet on first use and adds the ket_thuc/ban_kiem headers
 * to sheets made before trips could be ended (their rows simply read as "not ended").
 * rows: [{row (1-based), ma_chuyen, bks, thoi_gian, code, ket_thuc, ban_kiem}].
 */
function readTripSheet_(ss, create) {
  let sheet = ss.getSheetByName(TRIP_SHEET);
  if (!sheet) {
    if (!create) return { sheet: null, rows: [] };
    sheet = ss.insertSheet(TRIP_SHEET);
    sheet.setFrozenRows(1);
  }
  const values = sheet.getDataRange().getDisplayValues();
  const head = (values[0] || []).map(function (h) { return String(h).trim(); });
  if (create && TRIP_HEADER.some(function (h, i) { return head[i] !== h; })) {
    sheet.getRange(1, 1, 1, TRIP_HEADER.length).setValues([TRIP_HEADER]);
  }
  const rows = [];
  values.slice(1).forEach(function (r, i) {
    const row = {
      row: i + 2,
      ma_chuyen: String(r[0]).trim(),
      bks: String(r[1]).trim(),
      thoi_gian: String(r[2]).trim(),
      code: String(r[3]).trim().toUpperCase(),
      ket_thuc: String(r[4] == null ? '' : r[4]).trim(),
      ban_kiem: String(r[5] == null ? '' : r[5]).trim(),
    };
    if (row.ma_chuyen && row.code) rows.push(row);
  });
  return { sheet: sheet, rows: rows };
}

function onDay_(row, day) {
  return row.thoi_gian.indexOf(day + ' ') === 0;
}

/** Group rows into trips in sheet order: [{ma_chuyen, bks, thoi_gian, ket_thuc, codes, missing}]. */
function groupTrips_(rows) {
  const byId = {};
  const trips = [];
  rows.forEach(function (r) {
    let trip = byId[r.ma_chuyen];
    if (!trip) {
      trip = byId[r.ma_chuyen] = { ma_chuyen: r.ma_chuyen, bks: r.bks, thoi_gian: r.thoi_gian, ket_thuc: '', codes: [], missing: [] };
      trips.push(trip);
    }
    trip.codes.push(r.code);
    if (r.ket_thuc) trip.ket_thuc = r.ket_thuc;
    if (r.ban_kiem === MISSING) trip.missing.push(r.code);
  });
  return trips;
}

/** Trips not ended yet (any day) and the orders on them. */
function openTripsOf_(rows) {
  return groupTrips_(rows).filter(function (t) { return !t.ket_thuc; });
}

/**
 * Save a finished trip. Orders already on a trip that is not ended (any day) are refused as a whole
 * ({ok: false, conflicts: [{code, ma_chuyen, bks}]}) so the scanner can drop them and finish again;
 * this also catches two devices loading the same order at the same time.
 * Returns {ok: true, ma_chuyen, bks, thoi_gian, codes}. Trip id = CD<yyMMdd>-<nn>, numbered per day.
 */
function createTrip(plate, codes) {
  const bks = normalizePlate_(plate);
  if (!PLATE_PATTERN.test(bks)) throw new Error('Biển kiểm soát không hợp lệ: ' + bks);
  if (!Array.isArray(codes) || !codes.length) throw new Error('Chuyến chưa có đơn');
  if (codes.length > TRIP_MAX_CODES) throw new Error('Chuyến quá ' + TRIP_MAX_CODES + ' đơn');
  const list = cleanCodes_(codes);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // serialize writers: one trip number per trip, conflicts checked against saved rows
  try {
    const trips = readTripSheet_(SpreadsheetApp.openById(SHEET_ID), true);
    const now = tripNow_();

    const taken = {};
    openTripsOf_(trips.rows).forEach(function (t) {
      t.codes.forEach(function (c) { taken[c] = t; });
    });
    const conflicts = list.filter(function (c) { return taken[c]; })
      .map(function (c) { return { code: c, ma_chuyen: taken[c].ma_chuyen, bks: taken[c].bks }; });
    if (conflicts.length) return { ok: false, conflicts: conflicts };

    const prefix = 'CD' + now.stamp + '-';
    let last = 0;
    trips.rows.forEach(function (r) {
      if (r.ma_chuyen.indexOf(prefix) === 0) last = Math.max(last, Number(r.ma_chuyen.slice(prefix.length)) || 0);
    });
    const id = prefix + String(last + 1).padStart(2, '0');

    // Plain-text format keeps codes, plates and times exactly as written (no number/date coercion).
    trips.sheet.getRange(trips.sheet.getLastRow() + 1, 1, list.length, TRIP_HEADER.length)
      .setNumberFormat('@')
      .setValues(list.map(function (c) { return [id, bks, now.time, c, '', '']; }));
    SpreadsheetApp.flush();
    return { ok: true, ma_chuyen: id, bks: bks, thoi_gian: now.time, codes: list };
  } finally {
    lock.releaseLock();
  }
}

/**
 * End a trip after its FAILED orders were scanned back ("bắn kiểm"): every row of the trip gets the
 * end time; each FAILED order gets ban_kiem "Đã kiểm" (scanned) or "Thiếu" (not scanned).
 * failed = the trip's FAILED orders when the check started; checked = those scanned back.
 * Returns {ok: true, ma_chuyen, ket_thuc, missing}. Its orders may then join later trips.
 */
function endTrip(id, failed, checked) {
  const tripId = String(id == null ? '' : id).trim().toUpperCase();
  if (!tripId) throw new Error('Thiếu mã chuyến');
  const failedList = cleanCodes_(failed);
  const checkedSet = {};
  cleanCodes_(checked).forEach(function (c) { checkedSet[c] = true; });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const trips = readTripSheet_(SpreadsheetApp.openById(SHEET_ID), true);
    const rows = trips.rows.filter(function (r) { return r.ma_chuyen.toUpperCase() === tripId; });
    if (!rows.length) throw new Error('Không tìm thấy chuyến ' + tripId);
    const ended = rows.find(function (r) { return r.ket_thuc; });
    if (ended) throw new Error('Chuyến ' + tripId + ' đã kết thúc lúc ' + ended.ket_thuc);
    const inTrip = {};
    rows.forEach(function (r) { inTrip[r.code] = true; });
    const outside = failedList.filter(function (c) { return !inTrip[c]; });
    if (outside.length) throw new Error('Đơn không thuộc chuyến ' + tripId + ': ' + outside.join(', '));

    const now = tripNow_();
    const isFailed = {};
    failedList.forEach(function (c) { isFailed[c] = true; });
    // One write per trip row (E:F only), so nothing else in the sheet is touched.
    rows.forEach(function (r) {
      const check = isFailed[r.code] ? (checkedSet[r.code] ? CHECKED : MISSING) : '';
      trips.sheet.getRange(r.row, 5, 1, 2).setNumberFormat('@').setValues([[now.time, check]]);
    });
    SpreadsheetApp.flush();
    return {
      ok: true,
      ma_chuyen: rows[0].ma_chuyen,
      ket_thuc: now.time,
      missing: failedList.filter(function (c) { return !checkedSet[c]; }),
    };
  } finally {
    lock.releaseLock();
  }
}

/** Trips of one day (default today), newest first: {day, trips: [{ma_chuyen, bks, thoi_gian, ket_thuc, codes, missing}]}. */
function listTrips(day) {
  const wanted = day ? String(day).trim() : tripNow_().day;
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(wanted)) throw new Error('Ngày không hợp lệ: ' + wanted);
  const rows = readTripSheet_(SpreadsheetApp.openById(SHEET_ID), false).rows
    .filter(function (r) { return onDay_(r, wanted); });
  return { day: wanted, trips: groupTrips_(rows).reverse() }; // rows are appended in creation order
}

/** Trips not ended yet, any day: {trips: [{ma_chuyen, bks, thoi_gian, codes}]} (the scanner's "taken" list). */
function openTrips() {
  const trips = openTripsOf_(readTripSheet_(SpreadsheetApp.openById(SHEET_ID), false).rows);
  return {
    trips: trips.map(function (t) { return { ma_chuyen: t.ma_chuyen, bks: t.bks, thoi_gian: t.thoi_gian, codes: t.codes }; }),
  };
}

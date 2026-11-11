// Order location for the scan page's map (GET ?action=locate&code=...).
// The order's full address (raw_data.dropoff) is geocoded with Goong once, then cached in sheet
// `toa_do_don` so later scans of the same order cost no API call. Only the point of the one scanned
// order is returned: the bulk payload (?action=data) never carries customer coordinates.

const ORDER_POINT_SHEET = 'toa_do_don';
const ORDER_POINT_HEADER = ['tracking_number', 'lat', 'lng', 'nguon'];

/**
 * Returns {code, lat, lng, nguon} where nguon is 'dia_chi' (address geocoded) or 'phuong_xa'
 * (address not found, or Goong placed it outside the order's district: the ward point from
 * config_tuyen is used instead).
 */
function locateOrder(code) {
  const value = String(code == null ? '' : code).trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(value)) throw new Error('Mã không hợp lệ: ' + value);
  const ss = SpreadsheetApp.openById(SHEET_ID);

  const cached = findCachedPoint_(ss, value);
  if (cached) return cached;

  const data = readTable_(ss, DATA_SHEET, ['tracking_number', 'district', 'dropoff']);
  const row = data.rows.find(function (r) { return String(r[data.col.tracking_number]).trim().toUpperCase() === value; });
  if (!row) throw new Error('Không tìm thấy đơn ' + value);
  const address = String(row[data.col.dropoff]).trim();
  const district = String(row[data.col.district]).trim();

  let point = address ? goongGeocode_(address, district) : null;
  let source = 'dia_chi';
  if (!point) { point = findWardPoint_(ss, parseWard_(address), district); source = 'phuong_xa'; }
  if (!point) throw new Error('Không định vị được đơn ' + value);

  const result = { code: value, lat: point.lat, lng: point.lng, nguon: source };
  cacheOrderPoints_(ss, [result]);
  return result;
}

/** toa_do_don as code -> {code, lat, lng, nguon} ({} when the sheet does not exist yet). */
function readOrderPoints_(ss) {
  const sheet = ss.getSheetByName(ORDER_POINT_SHEET);
  const points = {};
  if (!sheet) return points;
  sheet.getDataRange().getDisplayValues().slice(1).forEach(function (r) {
    const code = String(r[0]).trim().toUpperCase();
    const lat = parseNumber_(r[1]);
    const lng = parseNumber_(r[2]);
    if (code && !(code in points) && isFinite(lat) && isFinite(lng)) {
      points[code] = { code: code, lat: lat, lng: lng, nguon: String(r[3]).trim() };
    }
  });
  return points;
}

function findCachedPoint_(ss, code) {
  return readOrderPoints_(ss)[code] || null;
}

/** Ward point from config_tuyen (used when the address itself cannot be placed). */
function findWardPoint_(ss, ward, district) {
  if (!ward) return null;
  const key = wardKey_(ward, district);
  const match = readRouteRows_(ss).rows.find(function (r) {
    return wardKey_(r.phuong_xa, r.quan_huyen) === key && isFinite(r.lat) && isFinite(r.lng) && r.lat !== '' && r.lng !== '';
  });
  return match ? { lat: Number(match.lat), lng: Number(match.lng) } : null;
}

/** Append points ({code, lat, lng, nguon}) not cached yet to toa_do_don. */
function cacheOrderPoints_(ss, points) {
  if (!points.length) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // concurrent scans of new orders must not write the same rows
  try {
    let sheet = ss.getSheetByName(ORDER_POINT_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(ORDER_POINT_SHEET);
      sheet.getRange(1, 1, 1, ORDER_POINT_HEADER.length).setValues([ORDER_POINT_HEADER]);
    }
    const known = {};
    sheet.getDataRange().getDisplayValues().forEach(function (r) { known[String(r[0]).trim().toUpperCase()] = true; });
    const fresh = points.filter(function (p) {
      if (known[p.code]) return false; // another request cached it meanwhile
      known[p.code] = true;
      return true;
    });
    if (!fresh.length) return;
    const row = sheet.getLastRow() + 1;
    sheet.getRange(row, 1, fresh.length, 1).setNumberFormat('@'); // keep codes as text (no number coercion)
    sheet.getRange(row, 1, fresh.length, ORDER_POINT_HEADER.length)
      .setValues(fresh.map(function (p) { return [p.code, p.lat, p.lng, p.nguon]; }));
  } finally {
    lock.releaseLock();
  }
}

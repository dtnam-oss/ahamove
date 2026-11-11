// Delivery routes by ward (phường/xã), stored in sheet `config_tuyen` and reused day after day.
//
// Run from the Apps Script editor (select the function, press Run):
//   taoCauHinhTuyen() - first build: groups every ward found in raw_data into routes of nearby wards.
//                        Refuses to run when config_tuyen already has rows (never overwrites edits).
//   boSungTuyen()     - later runs: adds only wards missing from config_tuyen, to the nearest route
//                        with room, or to new routes. Existing rows are never changed.
// Limits live in sheet `cai_dat_tuyen` (created with defaults on first run) so users can tune them.
//
// Ward coordinates come from the built-in Maps geocoder, queried with the ward/district/city names
// only (never the customer's street address), and are cached in config_tuyen (columns lat, lng).

const ROUTE_SHEET = 'config_tuyen';
const ROUTE_HEADER = ['ten_tuyen', 'phuong_xa', 'quan_huyen', 'lat', 'lng', 'so_don'];
const ROUTE_SETTINGS_SHEET = 'cai_dat_tuyen';
const ROUTE_SETTINGS = [
  // [key, default, note]
  ['so_don_toi_da_moi_tuyen', 30, 'Tổng số đơn tối đa của một tuyến (tính theo raw_data lúc chạy script)'],
  ['khoang_cach_toi_da_km', 5, 'Hai phường/xã bất kỳ trong cùng một tuyến cách nhau không quá số km này'],
];
const ROUTE_PREFIX = 'Tuyến ';

/** Menu-less entry point: first full build of config_tuyen. */
function taoCauHinhTuyen() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const existing = readRouteRows_(ss);
  if (existing.rows.length) {
    throw new Error('Sheet "' + ROUTE_SHEET + '" đã có ' + existing.rows.length +
      ' dòng. Chạy boSungTuyen() để thêm xã mới, hoặc xoá sheet này để tạo lại từ đầu.');
  }
  const settings = readRouteSettings_(ss);
  const wards = locateWards_(collectWards_(ss));
  const rows = clusterWards_(wards.located, settings, 1);
  writeRouteRows_(ss, rows.concat(wards.unlocated.map(unroutedRow_)));
  return logRouteSummary_('Tạo', rows, wards.unlocated);
}

/** Add wards that appeared in raw_data since the last run; existing assignments stay as they are. */
function boSungTuyen() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const settings = readRouteSettings_(ss);
  const existing = readRouteRows_(ss);
  const known = {};
  existing.rows.forEach(function (r) { known[wardKey_(r.phuong_xa, r.quan_huyen)] = true; });
  const fresh = collectWards_(ss).filter(function (w) { return !known[w.key]; });
  const wards = locateWards_(fresh);
  const rows = assignNewWards_(existing.rows, wards.located, settings);
  writeRouteRows_(ss, rows.concat(wards.unlocated.map(unroutedRow_)));
  return logRouteSummary_('Bổ sung', rows, wards.unlocated);
}

function logRouteSummary_(verb, rows, unlocated) {
  const routes = {};
  rows.forEach(function (r) { routes[r.ten_tuyen] = true; });
  const msg = verb + ' ' + rows.length + ' xã vào ' + Object.keys(routes).length + ' tuyến.' +
    (unlocated.length
      ? ' ' + unlocated.length + ' xã không tìm được toạ độ, cần điền ten_tuyen bằng tay: ' +
        unlocated.map(function (w) { return w.phuong_xa + ' (' + w.quan_huyen + ')'; }).join('; ')
      : '');
  console.log(msg);
  return msg;
}

// ---------- Reading raw_data ----------

/** Same folding as Lookup.normalizeText in web/lookup.js (diacritics, case, spaces, tone placement). */
function foldText_(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function wardKey_(ward, district) {
  return foldText_(ward) + '|' + foldText_(district);
}

/**
 * Ward-level part of an address ("…, Xã Đại Đồng, Huyện Thạch Thất, Hà Nội" -> "Xã Đại Đồng").
 * Searches from the end so street names like "Phường Mới" earlier in the address are not picked.
 */
function parseWard_(address) {
  const parts = String(address == null ? '' : address).split(',').map(function (p) { return p.trim(); });
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^(phuong|xa|thi tran) \S/.test(foldText_(parts[i]))) return parts[i].replace(/\s+/g, ' ');
  }
  return '';
}

/** Last address part = province/city, used only to make the geocoding query unambiguous. */
function parseCity_(address) {
  const parts = String(address == null ? '' : address).split(',').map(function (p) { return p.trim(); }).filter(String);
  return parts.length ? parts[parts.length - 1] : '';
}

/** Distinct wards in raw_data with their order counts, most orders first. */
function collectWards_(ss) {
  const data = readTable_(ss, DATA_SHEET, ['tracking_number', 'district', 'dropoff']);
  const byKey = {};
  data.rows.forEach(function (r) {
    if (!String(r[data.col.tracking_number]).trim()) return;
    const address = r[data.col.dropoff];
    const ward = parseWard_(address);
    const district = String(r[data.col.district]).trim();
    if (!ward || !district) return;
    const key = wardKey_(ward, district);
    if (!byKey[key]) byKey[key] = { key: key, phuong_xa: ward, quan_huyen: district, city: parseCity_(address), so_don: 0 };
    byKey[key].so_don++;
  });
  return Object.keys(byKey).map(function (k) { return byKey[k]; })
    .sort(function (a, b) { return b.so_don - a.so_don || (a.key < b.key ? -1 : 1); });
}

// ---------- Geocoding ----------

/** Adds lat/lng to each ward (falls back to the district centre); splits off the ones not found. */
function locateWards_(wards) {
  const geocoder = Maps.newGeocoder().setRegion('vn').setLanguage('vi');
  const districtCache = {};
  const located = [];
  const unlocated = [];
  wards.forEach(function (w) {
    let point = geocode_(geocoder, [w.phuong_xa, w.quan_huyen, w.city]);
    if (!point) {
      const dk = foldText_(w.quan_huyen + ',' + w.city);
      if (!(dk in districtCache)) districtCache[dk] = geocode_(geocoder, [w.quan_huyen, w.city]);
      point = districtCache[dk];
    }
    if (point) located.push(Object.assign({}, w, point));
    else unlocated.push(w);
  });
  return { located: located, unlocated: unlocated };
}

function geocode_(geocoder, parts) {
  const query = parts.filter(String).join(', ') + ', Việt Nam';
  try {
    const res = geocoder.geocode(query);
    Utilities.sleep(150); // stay well under the Maps service rate limit
    const loc = res && res.status === 'OK' && res.results && res.results[0] && res.results[0].geometry.location;
    return loc ? { lat: Number(loc.lat), lng: Number(loc.lng) } : null;
  } catch (err) {
    console.warn('Geocode lỗi "' + query + '": ' + err);
    return null;
  }
}

// ---------- Grouping (pure, unit-tested) ----------

/** Great-circle distance in km. */
function distanceKm_(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True when `w` is within khoang_cach_toi_da_km of every point (pairwise limit inside a route). */
function withinReach_(w, points, settings) {
  return points.every(function (p) { return distanceKm_(w, p) <= settings.khoang_cach_toi_da_km; });
}

function centroid_(points) {
  const n = points.length;
  return {
    lat: points.reduce(function (s, p) { return s + p.lat; }, 0) / n,
    lng: points.reduce(function (s, p) { return s + p.lng; }, 0) / n,
  };
}

/**
 * Group wards into routes of nearby wards. Greedy and deterministic:
 * each route starts at the outermost remaining ward (so outlying wards are not left over as
 * scattered leftovers), then repeatedly takes the remaining ward closest to the route's centre
 * that keeps the route within `so_don_toi_da_moi_tuyen` orders and within `khoang_cach_toi_da_km`
 * of every ward already in the route (so any two wards of a route are at most that far apart). A single ward with more orders than the limit becomes a route on its own.
 * Returns config rows numbered from `startNo`.
 */
function clusterWards_(wards, settings, startNo) {
  const remaining = wards.slice();
  const rows = [];
  if (!remaining.length) return rows;
  const middle = centroid_(remaining);
  let no = startNo;
  while (remaining.length) {
    let seedIdx = 0;
    remaining.forEach(function (w, i) {
      if (distanceKm_(w, middle) > distanceKm_(remaining[seedIdx], middle)) seedIdx = i;
    });
    const seed = remaining.splice(seedIdx, 1)[0];
    const members = [seed];
    let load = seed.so_don;
    for (;;) {
      const centre = centroid_(members);
      let best = -1;
      remaining.forEach(function (w, i) {
        if (load + w.so_don > settings.so_don_toi_da_moi_tuyen) return;
        if (!withinReach_(w, members, settings)) return;
        if (best < 0 || distanceKm_(w, centre) < distanceKm_(remaining[best], centre)) best = i;
      });
      if (best < 0) break;
      const next = remaining.splice(best, 1)[0];
      members.push(next);
      load += next.so_don;
    }
    const name = ROUTE_PREFIX + no++;
    members.forEach(function (w) { rows.push(routeRow_(name, w)); });
  }
  return rows;
}

/**
 * Incremental run: each new ward joins the closest existing route (by route centre) that still has
 * room and whose every ward is within khoang_cach_toi_da_km of it; the rest are grouped into new routes numbered after
 * the highest existing one. Route load = sum of so_don recorded in config_tuyen.
 */
function assignNewWards_(existingRows, newWards, settings) {
  const routes = {};
  let maxNo = 0;
  existingRows.forEach(function (r) {
    const name = String(r.ten_tuyen).trim();
    if (!name) return;
    const m = /(\d+)\s*$/.exec(name);
    if (m) maxNo = Math.max(maxNo, Number(m[1]));
    if (!routes[name]) routes[name] = { name: name, points: [], load: 0 };
    routes[name].load += Number(r.so_don) || 0;
    if (isFinite(r.lat) && isFinite(r.lng) && r.lat !== '' && r.lng !== '') {
      routes[name].points.push({ lat: Number(r.lat), lng: Number(r.lng) });
    }
  });
  const list = Object.keys(routes).map(function (k) { return routes[k]; })
    .filter(function (r) { return r.points.length; });
  list.forEach(function (r) { r.centre = centroid_(r.points); });

  const rows = [];
  const leftover = [];
  newWards.forEach(function (w) {
    let best = null;
    list.forEach(function (r) {
      if (r.load + w.so_don > settings.so_don_toi_da_moi_tuyen) return;
      if (!withinReach_(w, r.points, settings)) return;
      const d = distanceKm_(w, r.centre);
      if (!best || d < best.d) best = { route: r, d: d };
    });
    if (!best) { leftover.push(w); return; }
    best.route.load += w.so_don;
    best.route.points.push({ lat: w.lat, lng: w.lng });
    rows.push(routeRow_(best.route.name, w));
  });
  return rows.concat(clusterWards_(leftover, settings, maxNo + 1));
}

function routeRow_(name, w) {
  return { ten_tuyen: name, phuong_xa: w.phuong_xa, quan_huyen: w.quan_huyen, lat: w.lat, lng: w.lng, so_don: w.so_don };
}

/** Ward without coordinates: listed with an empty route so the user can fill it in by hand. */
function unroutedRow_(w) {
  return { ten_tuyen: '', phuong_xa: w.phuong_xa, quan_huyen: w.quan_huyen, lat: '', lng: '', so_don: w.so_don };
}

// ---------- Sheets ----------

function readRouteSettings_(ss) {
  let sheet = ss.getSheetByName(ROUTE_SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(ROUTE_SETTINGS_SHEET);
    sheet.getRange(1, 1, ROUTE_SETTINGS.length + 1, 3)
      .setValues([['ten', 'gia_tri', 'ghi_chu']].concat(ROUTE_SETTINGS));
  }
  const values = sheet.getDataRange().getDisplayValues();
  const settings = {};
  ROUTE_SETTINGS.forEach(function (s) {
    const row = values.find(function (r) { return String(r[0]).trim() === s[0]; });
    const value = row ? Number(String(row[1]).trim().replace(',', '.')) : s[1];
    if (!(value > 0)) throw new Error('Sheet "' + ROUTE_SETTINGS_SHEET + '": ' + s[0] + ' phải là số > 0');
    settings[s[0]] = value;
  });
  return settings;
}

/** Rows of config_tuyen as objects ({rows: []} when the sheet does not exist yet). */
function readRouteRows_(ss) {
  const sheet = ss.getSheetByName(ROUTE_SHEET);
  if (!sheet) return { rows: [] };
  const table = readTable_(ss, ROUTE_SHEET, ['ten_tuyen', 'phuong_xa', 'quan_huyen']);
  const header = table.header;
  const rows = table.rows
    .filter(function (r) { return String(r[table.col.phuong_xa]).trim(); })
    .map(function (r) {
      const obj = {};
      ROUTE_HEADER.forEach(function (h) {
        const i = header.indexOf(h);
        obj[h] = i < 0 ? '' : String(r[i]).trim();
      });
      ['lat', 'lng', 'so_don'].forEach(function (h) {
        if (obj[h] !== '') obj[h] = Number(obj[h].replace(',', '.'));
      });
      return obj;
    });
  return { rows: rows };
}

/** Append rows below the existing ones (creating the sheet with its header when missing). */
function writeRouteRows_(ss, rows) {
  let sheet = ss.getSheetByName(ROUTE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(ROUTE_SHEET);
    sheet.getRange(1, 1, 1, ROUTE_HEADER.length).setValues([ROUTE_HEADER]);
    sheet.setFrozenRows(1);
  }
  if (!rows.length) return;
  const values = rows.map(function (r) { return ROUTE_HEADER.map(function (h) { return r[h]; }); });
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, ROUTE_HEADER.length).setValues(values);
}

// ---------- Payload for the scan page ----------

/** config_tuyen is optional for the other modes: a problem there is reported, never breaks the payload. */
function readRoutes_(ss) {
  try {
    const table = readTable_(ss, ROUTE_SHEET, ['ten_tuyen', 'phuong_xa', 'quan_huyen']);
    const routes = [];
    table.rows.forEach(function (r) {
      const name = String(r[table.col.ten_tuyen]).trim();
      const ward = String(r[table.col.phuong_xa]).trim();
      if (name && ward) routes.push({ ten_tuyen: name, phuong_xa: ward, quan_huyen: String(r[table.col.quan_huyen]).trim() });
    });
    return { routes: routes, error: '' };
  } catch (err) {
    return { routes: null, error: String((err && err.message) || err) };
  }
}

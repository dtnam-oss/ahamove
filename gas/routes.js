// Delivery routes by ward (phường/xã), stored in sheet `config_tuyen` and reused day after day.
//
// Run from the Apps Script editor (select the function, press Run):
//   taoCauHinhTuyen() - first build: groups every ward found in raw_data into truck routes of nearby
//                        wards, each with between so_don_toi_thieu and so_don_toi_da orders.
//                        Refuses to run when config_tuyen already has rows (never overwrites edits).
//   boSungTuyen()     - later runs: adds only wards missing from config_tuyen, to the nearest route
//                        with room, or to new routes. Existing rows are never changed.
// Limits live in sheet `cai_dat_tuyen` (created with defaults on first run) so users can tune them.
//
// Ward coordinates come from Goong geocoding (goong.js) of up to WARD_SAMPLES real order addresses of
// that ward (the ward name alone geocodes poorly), and are cached in config_tuyen (columns lat, lng).
// The order points found on the way are cached in toa_do_don for the scan page's map.

const ROUTE_SHEET = 'config_tuyen';
const ROUTE_HEADER = ['ten_tuyen', 'phuong_xa', 'quan_huyen', 'lat', 'lng', 'so_don'];
const ROUTE_SETTINGS_SHEET = 'cai_dat_tuyen';
const ROUTE_SETTINGS = [
  // [key, default, note]
  ['so_don_toi_thieu_moi_tuyen', 30, 'Một tuyến (một chuyến xe) có ít nhất số đơn này (tính theo raw_data lúc chạy script)'],
  ['so_don_toi_da_moi_tuyen', 45, 'Một tuyến có nhiều nhất số đơn này (sức chở của xe)'],
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
  const wards = locateWards_(collectWards_(ss), readOrderPoints_(ss), function (points) { cacheOrderPoints_(ss, points); });
  const rows = clusterWards_(wards.located, settings, 1);
  writeRouteRows_(ss, rows.concat(wards.unlocated.map(unroutedRow_)));
  return logRouteSummary_('Tạo', rows, rows, wards.unlocated, settings);
}

/** Add wards that appeared in raw_data since the last run; existing assignments stay as they are. */
function boSungTuyen() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const settings = readRouteSettings_(ss);
  const existing = readRouteRows_(ss);
  const known = {};
  existing.rows.forEach(function (r) { known[wardKey_(r.phuong_xa, r.quan_huyen)] = true; });
  const fresh = collectWards_(ss).filter(function (w) { return !known[w.key]; });
  const wards = locateWards_(fresh, readOrderPoints_(ss), function (points) { cacheOrderPoints_(ss, points); });
  const rows = assignNewWards_(existing.rows, wards.located, settings);
  writeRouteRows_(ss, rows.concat(wards.unlocated.map(unroutedRow_)));
  return logRouteSummary_('Bổ sung', rows, existing.rows.concat(rows), wards.unlocated, settings);
}

/** `rows` = rows written now; `allRows` = whole config afterwards (to flag routes under the minimum). */
function routeLoads_(rows) {
  const loads = {};
  rows.forEach(function (r) {
    const name = String(r.ten_tuyen).trim();
    if (name) loads[name] = (loads[name] || 0) + (Number(r.so_don) || 0);
  });
  return Object.keys(loads).map(function (name) { return { name: name, load: loads[name] }; });
}

function logRouteSummary_(verb, rows, allRows, unlocated, settings) {
  const routes = {};
  rows.forEach(function (r) { routes[r.ten_tuyen] = true; });
  const small = routeLoads_(allRows).filter(function (r) { return r.load < settings.so_don_toi_thieu_moi_tuyen; });
  const msg = verb + ' ' + rows.length + ' xã vào ' + Object.keys(routes).length + ' tuyến.' +
    (small.length
      ? ' ' + small.length + ' tuyến dưới ' + settings.so_don_toi_thieu_moi_tuyen + ' đơn (không còn tuyến gần còn chỗ để nhập): ' +
        small.map(function (r) { return r.name + ' (' + r.load + ' đơn)'; }).join('; ') + '.'
      : '') +
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
    if (!byKey[key]) byKey[key] = { key: key, phuong_xa: ward, quan_huyen: district, city: parseCity_(address), so_don: 0, samples: [] };
    byKey[key].so_don++;
    if (byKey[key].samples.length < WARD_SAMPLES) {
      byKey[key].samples.push({ code: String(r[data.col.tracking_number]).trim().toUpperCase(), address: String(address).trim() });
    }
  });
  return Object.keys(byKey).map(function (k) { return byKey[k]; })
    .sort(function (a, b) { return b.so_don - a.so_don || (a.key < b.key ? -1 : 1); });
}

// ---------- Geocoding ----------

const WARD_SAMPLES = 3; // order addresses geocoded per ward

/** "Xã Tuy Lai" -> "Tuy Lai" (Goong matches bare names far better than prefixed ones). */
function stripAdminPrefix_(name) {
  return String(name).replace(/^(xã|phường|thị trấn|huyện|quận|thị xã|thành phố)\s+/i, '').trim();
}

function median_(values) {
  const v = values.slice().sort(function (a, b) { return a - b; });
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Adds lat/lng to each ward: the median point of its sample order addresses that Goong places in
 * the ward's own district. A ward with no usable sample falls back to its bare name, accepted only
 * when Goong returns that same ward and district. Wards still without a point are split off for
 * manual entry.
 * `cached` (code -> point, from toa_do_don) avoids re-geocoding orders located in an earlier run;
 * `onOrderPoints(points)` receives new order points after every Goong batch so a run stopped by the
 * quota keeps its progress. Also returns all new order points ({code, lat, lng, nguon}).
 */
function locateWards_(wards, cached, onOrderPoints) {
  const points = wards.map(function () { return []; });
  const orderPoints = [];

  const queries = [];
  const owners = [];
  wards.forEach(function (w, wi) {
    (w.samples || []).forEach(function (sample) {
      if (!sample.address) return;
      const hit = cached && cached[sample.code];
      if (hit && hit.nguon === 'dia_chi') { points[wi].push(hit); return; } // ward-point fallbacks are not samples
      queries.push({ address: sample.address, district: w.quan_huyen });
      owners.push({ ward: wi, code: sample.code });
    });
  });
  goongGeocodeMany_(queries, function (results, offset) {
    const fresh = [];
    results.forEach(function (p, k) {
      if (!p) return;
      const owner = owners[offset + k];
      points[owner.ward].push(p);
      fresh.push({ code: owner.code, lat: p.lat, lng: p.lng, nguon: 'dia_chi' });
    });
    Array.prototype.push.apply(orderPoints, fresh);
    if (onOrderPoints && fresh.length) onOrderPoints(fresh);
  });

  const missing = [];
  wards.forEach(function (w, wi) { if (!points[wi].length) missing.push(wi); });
  goongGeocodeMany_(missing.map(function (wi) {
    const w = wards[wi];
    return { address: [stripAdminPrefix_(w.phuong_xa), stripAdminPrefix_(w.quan_huyen), w.city].filter(String).join(', '), district: w.quan_huyen };
  })).forEach(function (p, k) {
    const w = wards[missing[k]];
    if (p && adminName_(p.commune) === adminName_(w.phuong_xa)) points[missing[k]].push(p);
  });

  const located = [];
  const unlocated = [];
  wards.forEach(function (w, wi) {
    const ps = points[wi];
    if (!ps.length) { unlocated.push(w); return; }
    located.push(Object.assign({}, w, {
      lat: median_(ps.map(function (p) { return p.lat; })),
      lng: median_(ps.map(function (p) { return p.lng; })),
    }));
  });
  return { located: located, unlocated: unlocated, orderPoints: orderPoints };
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

function centroid_(points) {
  const n = points.length;
  return {
    lat: points.reduce(function (s, p) { return s + p.lat; }, 0) / n,
    lng: points.reduce(function (s, p) { return s + p.lng; }, 0) / n,
  };
}

/** Index of the item in `list` closest to `point`, among those accepted by `ok` (or -1). */
function nearestIndex_(list, point, ok) {
  let best = -1;
  let bestD = Infinity;
  list.forEach(function (item, i) {
    if (!ok(item)) return;
    const d = distanceKm_(item, point);
    if (d < bestD) { best = i; bestD = d; }
  });
  return best;
}

function groupLoad_(members) {
  return members.reduce(function (s, w) { return s + w.so_don; }, 0);
}

/**
 * Group wards into truck routes. Greedy and deterministic, by orders only (no distance cap):
 * 1. Each route starts at the outermost remaining ward (so outlying wards are not left over as
 *    scattered leftovers) and keeps taking the remaining ward closest to the route's centre until
 *    it has at least `so_don_toi_thieu_moi_tuyen` orders, never going over `so_don_toi_da_moi_tuyen`.
 * 2. Routes still under the minimum (usually the last leftovers) are dissolved: each of their wards
 *    moves to the closest other route that stays within the maximum. Wards that fit nowhere keep
 *    their small route (reported by the run summary).
 * A single ward with more orders than the maximum becomes a route on its own.
 * Returns config rows numbered from `startNo`.
 */
function clusterWards_(wards, settings, startNo) {
  const min = settings.so_don_toi_thieu_moi_tuyen;
  const max = settings.so_don_toi_da_moi_tuyen;
  const remaining = wards.slice();
  if (!remaining.length) return [];
  const middle = centroid_(remaining);
  const groups = [];
  while (remaining.length) {
    let seedIdx = 0;
    remaining.forEach(function (w, i) {
      if (distanceKm_(w, middle) > distanceKm_(remaining[seedIdx], middle)) seedIdx = i;
    });
    const members = remaining.splice(seedIdx, 1);
    let load = members[0].so_don;
    while (load < min) {
      const i = nearestIndex_(remaining, centroid_(members), function (w) { return load + w.so_don <= max; });
      if (i < 0) break;
      load += remaining[i].so_don;
      members.push(remaining.splice(i, 1)[0]);
    }
    groups.push(members);
  }

  groups
    .filter(function (g) { return groupLoad_(g) < min; })
    .sort(function (a, b) { return groupLoad_(a) - groupLoad_(b); })
    .forEach(function (small) {
      small.slice().forEach(function (w) {
        const others = groups.filter(function (g) { return g !== small && g.length; });
        const centres = others.map(function (g) { return centroid_(g); });
        const i = nearestIndex_(centres, w, function (c) {
          return groupLoad_(others[centres.indexOf(c)]) + w.so_don <= max;
        });
        if (i < 0) return;
        others[i].push(w);
        small.splice(small.indexOf(w), 1);
      });
    });

  const rows = [];
  let no = startNo;
  groups.filter(function (g) { return g.length; }).forEach(function (g) {
    const name = ROUTE_PREFIX + no++;
    g.forEach(function (w) { rows.push(routeRow_(name, w)); });
  });
  return rows;
}

/**
 * Incremental run: each new ward joins the closest existing route (by route centre) that stays
 * within so_don_toi_da_moi_tuyen; the rest are grouped into new routes numbered after the highest
 * existing one. Route load = sum of so_don recorded in config_tuyen.
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

  const rows = [];
  const leftover = [];
  newWards.forEach(function (w) {
    const centres = list.map(function (r) { return centroid_(r.points); });
    const i = nearestIndex_(centres, w, function (c) {
      return list[centres.indexOf(c)].load + w.so_don <= settings.so_don_toi_da_moi_tuyen;
    });
    if (i < 0) { leftover.push(w); return; }
    list[i].load += w.so_don;
    list[i].points.push({ lat: w.lat, lng: w.lng });
    rows.push(routeRow_(list[i].name, w));
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
    if (!row) sheet.getRange(sheet.getLastRow() + 1, 1, 1, 3).setValues([s]); // new setting: show its default
    const value = row ? Number(String(row[1]).trim().replace(',', '.')) : s[1];
    if (!(value > 0)) throw new Error('Sheet "' + ROUTE_SETTINGS_SHEET + '": ' + s[0] + ' phải là số > 0');
    settings[s[0]] = value;
  });
  if (settings.so_don_toi_da_moi_tuyen < settings.so_don_toi_thieu_moi_tuyen) {
    throw new Error('Sheet "' + ROUTE_SETTINGS_SHEET + '": so_don_toi_da_moi_tuyen phải ≥ so_don_toi_thieu_moi_tuyen');
  }
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
/** Display value -> number, accepting a decimal comma (vi locale); empty/missing -> NaN. */
function parseNumber_(value) {
  const text = String(value == null ? '' : value).trim();
  return text ? Number(text.replace(',', '.')) : NaN;
}

function readRoutes_(ss) {
  try {
    const table = readTable_(ss, ROUTE_SHEET, ['ten_tuyen', 'phuong_xa', 'quan_huyen']);
    const latCol = table.header.indexOf('lat');
    const lngCol = table.header.indexOf('lng');
    const routes = [];
    table.rows.forEach(function (r) {
      const name = String(r[table.col.ten_tuyen]).trim();
      const ward = String(r[table.col.phuong_xa]).trim();
      if (!name || !ward) return;
      const row = { ten_tuyen: name, phuong_xa: ward, quan_huyen: String(r[table.col.quan_huyen]).trim() };
      // Ward points (not customer data) let the scan page draw the route's area on the map.
      const lat = parseNumber_(r[latCol]);
      const lng = parseNumber_(r[lngCol]);
      if (isFinite(lat) && isFinite(lng)) { row.lat = lat; row.lng = lng; }
      routes.push(row);
    });
    return { routes: routes, error: '' };
  } catch (err) {
    return { routes: null, error: String((err && err.message) || err) };
  }
}

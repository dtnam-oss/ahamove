// Tests for the client lookup (web/lookup.js) and the Apps Script backend (gas/Code.js).
// Both files are loaded into a Node VM so the deployed code is exactly what is tested.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function loadLookup() {
  const src = read('web/lookup.js');
  const ctx = vm.createContext({});
  vm.runInContext(`${src}\nthis.Lookup = Lookup;`, ctx);
  return ctx.Lookup;
}

/** Sheet backed by a 2D array (read as display strings, writable through getRange().setValues()). */
function gridSheet(values) {
  return {
    values,
    getDataRange: () => ({ getDisplayValues: () => values.map((r) => r.map((v) => String(v))) }),
    getLastRow: () => values.length,
    setFrozenRows() {},
    getRange: (row, col, numRows, numCols) => ({
      setNumberFormat() { return this; },
      setValues(v) {
        assert.equal(v.length, numRows);
        v.forEach((r, i) => { assert.equal(r.length, numCols); values[row - 1 + i] = r.slice(); });
        return this;
      },
    }),
  };
}

/**
 * Fake SpreadsheetApp over `tables` (sheet name -> 2D display values, or a fake sheet object).
 * `geo` maps the first part of a Goong geocoding query (the street part of a full address, or a bare
 * ward name) to {lat, lng, district, commune} - Goong's location + `compound`. Limits: `geo.httpStatus`
 * forces an HTTP error, `geo.tooFast` = number of next calls answered 429 (quota left), `geo.quota` =
 * successful calls allowed before 429 with X-RateLimit-Remaining 0. Queried addresses: ctx.geocoded.
 */
function loadServer(tables, geo = {}) {
  const spreadsheet = {
    getSheetByName: (name) => {
      const t = tables[name];
      if (!t) return null;
      return Array.isArray(t) ? gridSheet(t) : t;
    },
    insertSheet: (name) => { tables[name] = []; return gridSheet(tables[name]); },
  };
  const geocoded = [];
  const goong = (url) => {
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://rsapi.goong.io/geocode');
    assert.equal(u.searchParams.get('api_key'), 'test-key');
    const address = u.searchParams.get('address');
    const limited = (status, left) => ({
      getResponseCode: () => status,
      getHeaders: () => ({ 'X-RateLimit-Limit': '1000', 'X-RateLimit-Remaining': String(left) }),
      getContentText: () => '{}',
    });
    if (geo.tooFast > 0) { geo.tooFast--; return limited(429, 500); }
    if (geo.quota !== undefined && geo.quota-- <= 0) return limited(429, 0);
    geocoded.push(address);
    const point = geo[address.split(',')[0].trim()];
    const body = point
      ? { status: 'OK', results: [{ geometry: { location: { lat: point.lat, lng: point.lng } }, compound: { district: point.district, commune: point.commune, province: 'Hà Nội' } }] }
      : { status: 'OK', results: [] };
    return { getResponseCode: () => geo.httpStatus || 200, getHeaders: () => ({}), getContentText: () => JSON.stringify(body) };
  };
  const UrlFetchApp = {
    fetch: goong,
    fetchAll: (requests) => {
      if (geo.networkErrors > 0) { geo.networkErrors--; throw new Error('Địa chỉ không khả dụng: ' + requests[0].url); }
      return requests.map((r) => { assert.equal(r.muteHttpExceptions, true); return goong(r.url); });
    },
  };
  // formatDate supports the patterns the backend uses, in Vietnam time (UTC+7, no DST).
  const Utilities = {
    sleep() {},
    formatDate: (date, tz, pattern) => {
      assert.equal(tz, 'Asia/Ho_Chi_Minh');
      const v = new Date(date.getTime() + 7 * 3600e3);
      const p2 = (n) => String(n).padStart(2, '0');
      const parts = {
        yyyy: String(v.getUTCFullYear()), yy: String(v.getUTCFullYear()).slice(2), MM: p2(v.getUTCMonth() + 1),
        dd: p2(v.getUTCDate()), HH: p2(v.getUTCHours()), mm: p2(v.getUTCMinutes()), ss: p2(v.getUTCSeconds()),
      };
      return pattern.replace(/yyyy|yy|MM|dd|HH|mm|ss/g, (k) => parts[k]);
    },
  };
  const ContentService = {
    MimeType: { JSON: 'json' },
    createTextOutput: (text) => ({ text, setMimeType(m) { this.mime = m; return this; } }),
  };
  const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const ctx = vm.createContext({
    SpreadsheetApp: { openById: () => spreadsheet, flush() {} }, ContentService, LockService, UrlFetchApp, Utilities, console, geocoded,
  });
  vm.runInContext(read('gas/config.example.js').replace("GOONG_API_KEY = ''", "GOONG_API_KEY = 'test-key'"), ctx);
  vm.runInContext(read('gas/Code.js'), ctx);
  vm.runInContext(read('gas/routes.js'), ctx);
  vm.runInContext(read('gas/goong.js'), ctx);
  vm.runInContext(read('gas/locate.js'), ctx);
  vm.runInContext(read('gas/trips.js'), ctx);
  return ctx;
}

// Mirrors the `raw_data` sheet layout (key = tracking_number, not the first column).
// dropoff is the customer address and must never reach the payload.
const DATA = [
  ['date', 'tracking_number', 'partner', 'status', 'district', 'dropoff'],
  ['2026-11-10', 'GYEGFF9C', 'ghn', 'TRANSPORTING', 'Huyện Thanh Trì', 'Số 1 Ngõ A, Xã Tả Thanh Oai, Huyện Thanh Trì, Hà Nội'],
  ['2026-11-10', ' gyegffye ', 'ghn', 'ASSIGNING', 'Huyện Quốc Oai', 'Số 2 Ngõ B, Phường Mới, Xã Liệp Nghĩa, Huyện Quốc Oai, Hà Nội'],
  ['2026-11-10', 'AAAA1111', 'ghn', 'ACCEPTED', 'Huyện Ứng Hoà', ''], // old-style tone placement
  ['2026-11-10', 'BBBB2222', 'ghn', 'FAILED', '', ''],
  ['2026-11-10', 'CCCC3333', 'ghn', 'NEED_RETURN_TO_PARTNER_ASAP', 'Huyện Thanh Trì', ''],
  ['2026-11-10', 'DDDD4444', 'ghn', ' need_return_to_partner_asap ', 'Huyện Quốc Oai', ''],
  ['', '', '', '', '', ''],
];
const CONFIG = [
  ['ma_vi_tri', 'ten_vi_tri', 'khu_vuc'],
  ['NT1', 'Khu vực 1', 'Quận Hoàng Mai'],
  ['Nthanh1', 'Khu vực 2', 'Huyện Thanh Trì , Huyện Sóc Sơn'],
  ['Nthanh2', 'Khu vực 3', 'Huyện Ứng Hòa , Huyện Thường Tín'],
];

// Mirrors sheet back_log: the days-left column is located by its full header name.
const DAYS = 'Còn lại (ngày), âm là quá hạn';
const BACKLOG = [
  ['tracking_number', 'Ngày N (cột date)', 'Hạn final', DAYS, 'Nhóm hạn'],
  ['GYEGFF9C', '07/11/2026', '12/11/2026', '1', 'Còn hạn'],
  ['eeee5555', '01/11/2026', '09/11/2026', '-2', 'Quá hạn'],
  ['FFFF6666', '07/11/2026', '12/11/2026', '', ''],
  ['GYEGFF9C', '07/11/2026', '20/11/2026', '9', 'Còn hạn'], // duplicate: first row wins
];

function setup() {
  const server = loadServer({ raw_data: DATA, config: CONFIG, back_log: BACKLOG });
  const payload = server.getLookupData();
  const Lookup = loadLookup();
  return { payload, Lookup, index: Lookup.buildIndex(payload) };
}

test('server payload: tracking_number -> {district, status}, parsed config, no PII', () => {
  const { payload } = setup();
  assert.equal(payload.orderCount, 6);
  assert.deepEqual(Object.keys(payload.orders).sort(), ['AAAA1111', 'BBBB2222', 'CCCC3333', 'DDDD4444', 'GYEGFF9C', 'GYEGFFYE']);
  assert.equal(payload.orders.GYEGFFYE.district, 'Huyện Quốc Oai');
  assert.equal(payload.orders.CCCC3333.status, 'NEED_RETURN_TO_PARTNER_ASAP');
  assert.ok(!JSON.stringify(payload).includes('Ngõ'));
  assert.deepEqual([...payload.config[1].khu_vuc], ['Huyện Thanh Trì', 'Huyện Sóc Sơn']);
});

test('orders are read from raw_data, not the old data sheet', () => {
  assert.throws(() => loadServer({ data: DATA, config: CONFIG }).getLookupData(), /Không tìm thấy sheet "raw_data"/);
});

test('server reports missing columns and sheets', () => {
  assert.throws(() => loadServer({ raw_data: [['x']], config: CONFIG }).getLookupData(), /thiếu cột tracking_number/);
  assert.throws(() => loadServer({ raw_data: [['tracking_number', 'district']], config: CONFIG }).getLookupData(), /thiếu cột status/);
  assert.throws(() => loadServer({ config: CONFIG }).getLookupData(), /Không tìm thấy sheet "raw_data"/);
});

test('doGet ?action=data returns JSON payload, errors as {error}', () => {
  const ok = loadServer({ raw_data: DATA, config: CONFIG }).doGet({ parameter: { action: 'data' } });
  assert.equal(ok.mime, 'json');
  assert.equal(JSON.parse(ok.text).orderCount, 6);
  const bad = loadServer({ config: CONFIG }).doGet({ parameter: { action: 'data' } });
  assert.match(JSON.parse(bad.text).error, /Không tìm thấy sheet "raw_data"/);
});

test('mapped district speaks ten_vi_tri + district', () => {
  const { Lookup, index } = setup();
  const r = Lookup.resolveScan('GYEGFF9C', index);
  assert.equal(r.status, 'ok');
  assert.equal(r.speech, 'Khu vực 2, Huyện Thanh Trì');
});

test('scan is case/space insensitive', () => {
  const { Lookup, index } = setup();
  assert.equal(Lookup.resolveScan('  gyegff9c\n', index).status, 'ok');
});

test('cancelled status speaks "Đơn đã huỷ" and skips location lookup', () => {
  const { Lookup, index } = setup();
  const r = Lookup.resolveScan('CCCC3333', index); // district is mapped, but cancel wins
  assert.equal(r.status, 'cancelled');
  assert.equal(r.speech, 'Đơn đã huỷ');
  assert.equal(r.location, undefined);
});

test('cancelled status match ignores case and surrounding spaces', () => {
  const { Lookup, index } = setup();
  assert.equal(Lookup.resolveScan('DDDD4444', index).status, 'cancelled');
});

test('other statuses continue to normal lookup', () => {
  const { Lookup } = setup();
  for (const status of ['VERIFYING', '', 'RETURNED']) {
    const index = Lookup.buildIndex({ orders: { X1: { district: 'Quận Hoàng Mai', status } }, config: [{ ten_vi_tri: 'Khu vực 1', khu_vuc: ['Quận Hoàng Mai'] }] });
    assert.equal(Lookup.resolveScan('X1', index).speech, 'Khu vực 1, Quận Hoàng Mai');
  }
});

test('district in a multi-district config cell matches the second entry', () => {
  const { Lookup } = setup();
  const index = Lookup.buildIndex({ orders: { X1: { district: 'Huyện Sóc Sơn', status: 'VERIFYING' } }, config: [{ ten_vi_tri: 'Khu vực 2', khu_vuc: ['Huyện Thanh Trì', 'Huyện Sóc Sơn'] }] });
  assert.equal(Lookup.resolveScan('X1', index).speech, 'Khu vực 2, Huyện Sóc Sơn');
});

test('tone-placement variants (Hoà vs Hòa) still match', () => {
  const { Lookup, index } = setup();
  const r = Lookup.resolveScan('AAAA1111', index);
  assert.equal(r.status, 'ok');
  assert.equal(r.location, 'Khu vực 3');
});

test('unmapped district speaks "Chưa có vị trí, <district>"', () => {
  const { Lookup, index } = setup();
  const r = Lookup.resolveScan('GYEGFFYE', index);
  assert.equal(r.status, 'unmapped');
  assert.equal(r.speech, 'Chưa có vị trí, Huyện Quốc Oai');
});

test('order without district', () => {
  const { Lookup, index } = setup();
  assert.equal(Lookup.resolveScan('BBBB2222', index).status, 'no_district');
});

test('unknown code (e.g. Shopee order number) speaks not found', () => {
  const { Lookup, index } = setup();
  const r = Lookup.resolveScan('261106KCTVHNT9', index);
  assert.equal(r.status, 'not_found');
  assert.equal(r.speech, 'Không tìm thấy đơn');
});

test('code embedded in a QR payload (URL / JSON) is found', () => {
  const { Lookup, index } = setup();
  assert.equal(Lookup.resolveScan('https://ahamove.com/track?code=GYEGFF9C&x=1', index).code, 'GYEGFF9C');
  assert.equal(Lookup.resolveScan('{"tracking":"GYEGFF9C"}', index).status, 'ok');
});

test('empty scan is ignored', () => {
  const { Lookup, index } = setup();
  assert.equal(Lookup.resolveScan('   ', index).status, 'empty');
});

// ---------- Backlog mode: sheet back_log ----------

test('server payload carries back_log days only (first row wins)', () => {
  const { payload } = setup();
  assert.deepEqual({ ...payload.backlog }, { GYEGFF9C: '1', EEEE5555: '-2', FFFF6666: '' });
  assert.equal(payload.backlogError, '');
  assert.ok(!JSON.stringify(payload.backlog).includes('12/11/2026'));
});

test('missing back_log sheet or column does not break the sorting payload', () => {
  const noSheet = loadServer({ raw_data: DATA, config: CONFIG }).getLookupData();
  assert.equal(noSheet.backlog, null);
  assert.match(noSheet.backlogError, /Không tìm thấy sheet "back_log"/);
  assert.equal(noSheet.orderCount, 6);
  const noCol = loadServer({ raw_data: DATA, config: CONFIG, back_log: [['tracking_number', 'Còn lại']] }).getLookupData();
  assert.match(noCol.backlogError, /thiếu cột Còn lại \(ngày\), âm là quá hạn/);
});

test('backlog scan speaks days left + " ngày"', () => {
  const { Lookup, index } = setup();
  const r = Lookup.resolveBacklog(' gyegff9c ', index);
  assert.equal(r.status, 'ok');
  assert.equal(r.speech, '1 ngày');
});

test('negative days left is overdue and still spoken as the value', () => {
  const { Lookup, index } = setup();
  const r = Lookup.resolveBacklog('EEEE5555', index);
  assert.equal(r.status, 'overdue');
  assert.equal(r.speech, '-2 ngày');
});

test('backlog: not listed, empty days, QR payload, no back_log data', () => {
  const { Lookup, index } = setup();
  const nf = Lookup.resolveBacklog('AAAA1111', index); // in raw_data, not in back_log
  assert.equal(nf.status, 'not_found');
  assert.equal(nf.speech, 'Không có trong backlog');
  assert.equal(Lookup.resolveBacklog('FFFF6666', index).status, 'no_days');
  assert.equal(Lookup.resolveBacklog('https://x.vn/t?code=GYEGFF9C', index).speech, '1 ngày');
  assert.equal(Lookup.resolveBacklog('  ', index).status, 'empty');
  const noBacklog = Lookup.buildIndex({ orders: {}, config: [], backlog: null });
  assert.equal(Lookup.resolveBacklog('GYEGFF9C', noBacklog).status, 'unavailable');
});

// ---------- Route mode: sheet config_tuyen (wards grouped into routes) ----------

const ROUTES = [
  ['ten_tuyen', 'phuong_xa', 'quan_huyen', 'lat', 'lng', 'so_don'],
  ['Tuyến 1', 'Xã Tả Thanh Oai', 'Huyện Thanh Trì', '20.93', '105.80', '1'],
  ['Tuyến 2', 'Xã Liệp Nghĩa', 'Huyện Quốc Oai', '20.98', '105.62', '1'],
  ['', 'Xã Không Toạ Độ', 'Huyện Quốc Oai', '', '', '1'], // not yet routed by the user
];

function routeSetup(routes = ROUTES) {
  const payload = loadServer({ raw_data: DATA, config: CONFIG, config_tuyen: routes }).getLookupData();
  const Lookup = loadLookup();
  return { payload, Lookup, index: Lookup.buildIndex(payload) };
}

test('parseWard_ takes the last ward-level part of the address', () => {
  const server = loadServer({});
  assert.equal(server.parseWard_('Số 1 Ngõ A, Xã Đại Đồng, Huyện Thạch Thất, Hà Nội'), 'Xã Đại Đồng');
  assert.equal(server.parseWard_('12 Phường Mới, Phường  Ngọc Hà, Quận Ba Đình, Hà Nội'), 'Phường Ngọc Hà');
  assert.equal(server.parseWard_('Khu 3, Thị trấn Liên Quan, Huyện Thạch Thất, Hà Nội'), 'Thị trấn Liên Quan');
  assert.equal(server.parseWard_('Số 5, Thị xã Sơn Tây, Hà Nội'), ''); // town (district level) is not a ward
  assert.equal(server.parseWard_(''), '');
});

test('payload carries ward per order and config_tuyen routes, never the address', () => {
  const { payload } = routeSetup();
  assert.equal(payload.orders.GYEGFF9C.ward, 'Xã Tả Thanh Oai');
  assert.equal(payload.orders.GYEGFFYE.ward, 'Xã Liệp Nghĩa');
  assert.equal(payload.orders.AAAA1111.ward, '');
  assert.equal(payload.routes.length, 2); // rows without ten_tuyen are not routes
  assert.equal(payload.routesError, '');
  const json = JSON.stringify(payload);
  assert.ok(!json.includes('Ngõ') && !json.includes('Số 1'));
});

test('missing config_tuyen does not break the other modes', () => {
  const payload = loadServer({ raw_data: DATA, config: CONFIG }).getLookupData();
  assert.equal(payload.routes, null);
  assert.match(payload.routesError, /Không tìm thấy sheet "config_tuyen"/);
  assert.equal(payload.orderCount, 6);
  const Lookup = loadLookup();
  const index = Lookup.buildIndex(payload);
  assert.equal(Lookup.resolveRouteCheck('GYEGFF9C', index, ['Tuyến 1'], {}).status, 'unavailable');
  assert.equal(Lookup.routeSummary(index).length, 0);
});

// Orders for the route picker: Tuyến 1 = Tả Thanh Oai + Vĩnh Quỳnh (Thanh Trì), Tuyến 2 = Liệp Nghĩa,
// Tuyến 10 has no order today. One cancelled order sits in Tuyến 1 and must not count.
const PICK_DATA = [
  ['date', 'tracking_number', 'partner', 'status', 'district', 'dropoff'],
  ['d', 'T1A', 'ghn', 'ASSIGNING', 'Huyện Thanh Trì', 'Số 1, Xã Tả Thanh Oai, Huyện Thanh Trì, Hà Nội'],
  ['d', 'T1B', 'ghn', 'ASSIGNING', 'Huyện Thanh Trì', 'Số 2, xã tả thanh oai, Huyện Thanh Trì, Hà Nội'],
  ['d', 'T1C', 'ghn', 'ASSIGNING', 'Huyện Thanh Trì', 'Số 3, Xã Vĩnh Quỳnh, Huyện Thanh Trì, Hà Nội'],
  ['d', 'T1X', 'ghn', 'NEED_RETURN_TO_PARTNER_ASAP', 'Huyện Thanh Trì', 'Số 4, Xã Vĩnh Quỳnh, Huyện Thanh Trì, Hà Nội'],
  ['d', 'T2A', 'ghn', 'ASSIGNING', 'Huyện Quốc Oai', 'Số 5, Xã Liệp Nghĩa, Huyện Quốc Oai, Hà Nội'],
  ['d', 'NOR', 'ghn', 'ASSIGNING', 'Huyện Ba Vì', 'Số 6, Xã Ba Trại, Huyện Ba Vì, Hà Nội'],
];
const PICK_ROUTES = [
  ['ten_tuyen', 'phuong_xa', 'quan_huyen', 'lat', 'lng', 'so_don'],
  ['Tuyến 10', 'Xã Ba Vì', 'Huyện Ba Vì', '21,1', '105,4', '0'],
  ['Tuyến 2', 'Xã Liệp Nghĩa', 'Huyện Quốc Oai', '20,98', '105,62', '1'],
  ['Tuyến 1', 'Xã Tả Thanh Oai', 'Huyện Thanh Trì', '20,93', '105,8', '2'],
  ['Tuyến 1', 'Xã Vĩnh Quỳnh', 'Huyện Thanh Trì', '20,95', '105,81', '2'],
  ['Tuyến 1', 'Phường Định Công', 'Quận Hoàng Mai', '20,98', '105,83', '0'],
];
function pickSetup() {
  const payload = loadServer({ raw_data: PICK_DATA, config: CONFIG, config_tuyen: PICK_ROUTES }).getLookupData();
  const Lookup = loadLookup();
  return { Lookup, index: Lookup.buildIndex(payload) };
}

test('routeSummary: routes in number order, districts with ward details, today\'s active orders', () => {
  const { Lookup, index } = pickSetup();
  const list = JSON.parse(JSON.stringify(Lookup.routeSummary(index)));
  assert.deepEqual(list.map((r) => [r.name, r.total]), [['Tuyến 1', 3], ['Tuyến 2', 1], ['Tuyến 10', 0]]);
  assert.deepEqual(list[0].districts, [
    { name: 'Huyện Thanh Trì', total: 3, wards: [{ name: 'Xã Tả Thanh Oai', total: 2 }, { name: 'Xã Vĩnh Quỳnh', total: 1 }] },
    { name: 'Quận Hoàng Mai', total: 0, wards: [{ name: 'Phường Định Công', total: 0 }] },
  ]);
});

test('routeOrderCodes: active orders of the selected routes only', () => {
  const { Lookup, index } = pickSetup();
  assert.deepEqual([...Lookup.routeOrderCodes(['Tuyến 1'], index)].sort(), ['T1A', 'T1B', 'T1C']);
  assert.deepEqual([...Lookup.routeOrderCodes(['Tuyến 1', 'Tuyến 2'], index)].sort(), ['T1A', 'T1B', 'T1C', 'T2A']);
  assert.equal(Lookup.routeOrderCodes([], index).length, 0);
});

test('resolveRouteCheck: "Có" for the selection, then "Đã quét"; other routes say which one', () => {
  const { Lookup, index } = pickSetup();
  const scanned = {};
  const ok = Lookup.resolveRouteCheck(' t1a ', index, ['Tuyến 1'], scanned);
  assert.deepEqual([ok.status, ok.speech, ok.route, ok.ward], ['ok', 'Có', 'Tuyến 1', 'Xã Tả Thanh Oai']);
  scanned.T1A = 1;
  assert.equal(Lookup.resolveRouteCheck('T1A', index, ['Tuyến 1'], scanned).speech, 'Đã quét');
  assert.equal(Lookup.resolveRouteCheck('https://x.vn/t?code=T2A', index, ['Tuyến 1'], scanned).speech, 'Không, Tuyến 2');
  assert.equal(Lookup.resolveRouteCheck('NOR', index, ['Tuyến 1'], scanned).speech, 'Không, đơn chưa có tuyến');
  assert.equal(Lookup.resolveRouteCheck('T1X', index, ['Tuyến 1'], scanned).speech, 'Đơn đã huỷ');
  assert.equal(Lookup.resolveRouteCheck('ZZZZ', index, ['Tuyến 1'], scanned).speech, 'Không tìm thấy đơn');
  assert.equal(Lookup.resolveRouteCheck('  ', index, ['Tuyến 1'], scanned).status, 'empty');
  assert.equal(Lookup.resolveRouteCheck('T2A', index, ['Tuyến 1', 'Tuyến 2'], scanned).status, 'ok');
});

test('route membership tolerates tone/case variants of ward and district', () => {
  const rows = ROUTES.map((r) => r.slice());
  rows[1][1] = 'xã tả thanh oai';
  rows[1][2] = 'HUYỆN THANH TRÌ';
  const { Lookup, index } = routeSetup(rows);
  assert.equal(Lookup.resolveRouteCheck('GYEGFF9C', index, ['Tuyến 1'], {}).status, 'ok');
});

// Points along a line of latitude (0.009 deg lat ~ 1 km).
const ward = (name, km, orders) => ({ key: name, phuong_xa: name, quan_huyen: 'H', lat: 21 + km * 0.009, lng: 105.8, so_don: orders });
const routesOf = (rows) => rows.reduce((m, r) => ({ ...m, [r.ten_tuyen]: [...(m[r.ten_tuyen] || []), r.phuong_xa] }), {});
const loadsOf = (rows) => rows.reduce((m, r) => ({ ...m, [r.ten_tuyen]: (m[r.ten_tuyen] || 0) + r.so_don }), {});
const TRUCK = { so_don_toi_thieu_moi_tuyen: 30, so_don_toi_da_moi_tuyen: 45 };

test('clusterWards_: every route has between min and max orders, wards stay contiguous', () => {
  const server = loadServer({});
  const wards = Array.from({ length: 10 }, (_, i) => ward('W' + i, i, 8)); // 80 orders on a line
  const rows = server.clusterWards_(wards, TRUCK, 1);
  assert.equal(rows.length, 10);
  Object.values(loadsOf(rows)).forEach((load) => assert.ok(load >= 30 && load <= 45, String(load)));
  Object.values(routesOf(rows)).forEach((names) => {
    const pos = names.map((n) => Number(n.slice(1))).sort((a, b) => a - b);
    assert.equal(pos[pos.length - 1] - pos[0], pos.length - 1, pos.join()); // no gaps: nearby wards together
  });
});

test('clusterWards_: no distance cap, a far small ward joins a route instead of staying tiny', () => {
  const server = loadServer({});
  const wards = [ward('A', 0, 10), ward('B', 1, 10), ward('C', 2, 10), ward('FAR', 40, 3)];
  const rows = server.clusterWards_(wards, TRUCK, 1);
  assert.deepEqual(Object.keys(routesOf(rows)), ['Tuyến 1']);
  assert.equal(loadsOf(rows)['Tuyến 1'], 33);
});

test('clusterWards_: an oversized ward stands alone; small routes stay when nothing has room', () => {
  const server = loadServer({});
  const big = server.clusterWards_([ward('A', 0, 10), ward('B', 1, 25), ward('D', 2, 60)], TRUCK, 1);
  assert.ok(Object.values(routesOf(big)).some((names) => names.length === 1 && names[0] === 'D'));
  Object.entries(loadsOf(big)).forEach(([name, load]) => assert.ok(load <= 45 || routesOf(big)[name].length === 1));
  const tight = server.clusterWards_([ward('A', 0, 20), ward('B', 1, 20)], { so_don_toi_thieu_moi_tuyen: 30, so_don_toi_da_moi_tuyen: 30 }, 1);
  assert.equal(Object.keys(routesOf(tight)).length, 2); // 20 + 20 > max 30: kept apart, reported as small
});

test('taoCauHinhTuyen builds config_tuyen and default settings from raw_data', () => {
  const tables = { raw_data: DATA, config: CONFIG };
  const server = loadServer(tables, {
    'Số 1 Ngõ A': { lat: 20.93, lng: 105.8, district: 'Thanh Trì', commune: 'Tả Thanh Oai' },
    'Số 2 Ngõ B': { lat: 21.5, lng: 106.1, district: 'Hiệp Hoà', commune: 'X' }, // wrong district: rejected
    'Liệp Nghĩa': { lat: 20.98, lng: 105.62, district: 'Quốc Oai', commune: 'Liệp Nghĩa' }, // bare-name fallback
  });
  const msg = server.taoCauHinhTuyen();
  assert.match(msg, /Tạo 2 xã vào 1 tuyến/); // 2 orders in total: one route, flagged as under the minimum
  assert.match(msg, /1 tuyến dưới 30 đơn.*Tuyến 1 \(2 đơn\)/);
  assert.deepEqual([...tables.config_tuyen[0]], ['ten_tuyen', 'phuong_xa', 'quan_huyen', 'lat', 'lng', 'so_don']);
  const body = tables.config_tuyen.slice(1);
  assert.deepEqual(body.map((r) => r[1]).sort(), ['Xã Liệp Nghĩa', 'Xã Tả Thanh Oai']);
  assert.ok(body.every((r) => r[0] === 'Tuyến 1'));
  assert.deepEqual([...body.find((r) => r[1] === 'Xã Liệp Nghĩa').slice(3, 5)], [20.98, 105.62]);
  assert.deepEqual([...server.geocoded].sort(), [
    'Liệp Nghĩa, Quốc Oai, Hà Nội', // only after its address landed in the wrong district
    'Số 1 Ngõ A, Xã Tả Thanh Oai, Huyện Thanh Trì, Hà Nội',
    'Số 2 Ngõ B, Phường Mới, Xã Liệp Nghĩa, Huyện Quốc Oai, Hà Nội',
  ]);
  assert.deepEqual(tables.toa_do_don.slice(1).map((r) => [...r]), [['GYEGFF9C', 20.93, 105.8, 'dia_chi']]); // map cache
  assert.deepEqual(tables.cai_dat_tuyen.slice(1).map((r) => [r[0], r[1]]), [['so_don_toi_thieu_moi_tuyen', 30], ['so_don_toi_da_moi_tuyen', 45]]);
  assert.throws(() => server.taoCauHinhTuyen(), /đã có 2 dòng/); // never overwrites
});

test('boSungTuyen adds only new wards, keeps existing rows, lists ungeocoded ones', () => {
  const data = DATA.concat([
    ['2026-11-11', 'NEW00001', 'ghn', 'ASSIGNING', 'Huyện Thanh Trì', 'Số 9, Xã Vĩnh Quỳnh, Huyện Thanh Trì, Hà Nội'],
    ['2026-11-11', 'NEW00002', 'ghn', 'ASSIGNING', 'Huyện Sóc Sơn', 'Thôn 1, Xã Xa Lạ, Huyện Sóc Sơn, Hà Nội'],
  ]);
  const routes = ROUTES.slice(0, 3).map((r) => r.slice());
  const settings = [['ten', 'gia_tri'], ['so_don_toi_thieu_moi_tuyen', '1'], ['so_don_toi_da_moi_tuyen', '45']];
  const tables = { raw_data: data, config: CONFIG, config_tuyen: routes, cai_dat_tuyen: settings };
  const server = loadServer(tables, { 'Số 9': { lat: 20.95, lng: 105.81, district: 'Thanh Trì', commune: 'Vĩnh Quỳnh' } }); // closest to Tuyến 1
  const msg = server.boSungTuyen();
  assert.match(msg, /^Bổ sung 1 xã vào 1 tuyến\. 1 xã không tìm được toạ độ.*Xã Xa Lạ/);
  assert.deepEqual(tables.config_tuyen.slice(0, 3), ROUTES.slice(0, 3));
  assert.deepEqual([...tables.config_tuyen[3].slice(0, 3)], ['Tuyến 1', 'Xã Vĩnh Quỳnh', 'Huyện Thanh Trì']);
  assert.deepEqual([...tables.config_tuyen[4].slice(0, 3)], ['', 'Xã Xa Lạ', 'Huyện Sóc Sơn']);
  assert.equal(server.boSungTuyen(), 'Bổ sung 0 xã vào 0 tuyến.'); // second run: nothing new
});

test('boSungTuyen opens a new route numbered after the highest one when every route is full', () => {
  const data = DATA.concat([['2026-11-11', 'NEW00003', 'ghn', 'ASSIGNING', 'Huyện Ba Vì', 'Xã Ba Trại, Huyện Ba Vì, Hà Nội']]);
  const full = ROUTES.slice(0, 3).map((r, i) => (i ? [...r.slice(0, 5), '45'] : r.slice()));
  const tables = { raw_data: data, config: CONFIG, config_tuyen: full };
  const server = loadServer(tables, { 'Xã Ba Trại': { lat: 21.1, lng: 105.35, district: 'Ba Vì', commune: 'Ba Trại' } });
  server.boSungTuyen();
  assert.deepEqual([...tables.config_tuyen[3].slice(0, 2)], ['Tuyến 3', 'Xã Ba Trại']);
});

test('route settings: missing keys are added with defaults; invalid values are rejected', () => {
  const old = [['ten', 'gia_tri', 'ghi_chu'], ['so_don_toi_da_moi_tuyen', '50', ''], ['khoang_cach_toi_da_km', '5', '']];
  const server = loadServer({ cai_dat_tuyen: old });
  const settings = server.readRouteSettings_(server.SpreadsheetApp.openById());
  assert.deepEqual({ ...settings }, { so_don_toi_thieu_moi_tuyen: 30, so_don_toi_da_moi_tuyen: 50 });
  assert.equal(old[3][0], 'so_don_toi_thieu_moi_tuyen'); // appended so the user sees and can edit it
  const bad = (rows) => () => loadServer({ raw_data: DATA, config: CONFIG, cai_dat_tuyen: [['ten', 'gia_tri'], ...rows] }).taoCauHinhTuyen();
  assert.throws(bad([['so_don_toi_thieu_moi_tuyen', 'abc']]), /so_don_toi_thieu_moi_tuyen phải là số > 0/);
  assert.throws(bad([['so_don_toi_thieu_moi_tuyen', '50'], ['so_don_toi_da_moi_tuyen', '40']]), /phải ≥ so_don_toi_thieu_moi_tuyen/);
});

test('ward point = median of its order points; bare-name fallback must match ward and district', () => {
  const wards = [
    { key: 'a', phuong_xa: 'Xã Vĩnh Quỳnh', quan_huyen: 'Huyện Thanh Trì', city: 'Hà Nội', so_don: 3,
      samples: [{ code: 'A1', address: 'A1, Xã Vĩnh Quỳnh' }, { code: 'A2', address: 'A2, Xã Vĩnh Quỳnh' }, { code: 'A3', address: 'A3, Xã Vĩnh Quỳnh' }] },
    { key: 'b', phuong_xa: 'Xã Tam Hiệp', quan_huyen: 'Huyện Thanh Trì', city: 'Hà Nội', so_don: 1, samples: [{ code: 'B1', address: 'B1, Xã Tam Hiệp' }] },
  ];
  const geo = {
    A1: { lat: 20.94, lng: 105.80, district: 'Thanh Trì' },
    A2: { lat: 20.96, lng: 105.82, district: 'Thanh Trì' },
    A3: { lat: 20.95, lng: 105.90, district: 'Thanh Trì' },
    'Tam Hiệp': { lat: 21.085, lng: 105.626, district: 'Phúc Thọ', commune: 'Tam Hiệp' }, // the other Tam Hiệp
  };
  const r = loadServer({}, geo).locateWards_(wards);
  assert.deepEqual([r.located[0].lat, r.located[0].lng], [20.95, 105.82]);
  assert.deepEqual([...r.unlocated.map((w) => w.phuong_xa)], ['Xã Tam Hiệp']); // left for manual entry
  assert.deepEqual([...r.orderPoints.map((p) => p.code)], ['A1', 'A2', 'A3']);
});

// ---------- Goong: order location for the map (GET ?action=locate) ----------

const ROUTES_WITH_POINTS = [
  ['ten_tuyen', 'phuong_xa', 'quan_huyen', 'lat', 'lng', 'so_don'],
  ['Tuyến 1', 'Xã Tả Thanh Oai', 'Huyện Thanh Trì', '20,93', '105,8', '1'],
  ['Tuyến 1', 'Xã Vĩnh Quỳnh', 'Huyện Thanh Trì', '20,95', '105,81', '1'],
  ['Tuyến 2', 'Xã Liệp Nghĩa', 'Huyện Quốc Oai', '20,98', '105,62', '1'],
];

test('payload route rows carry ward points; Lookup groups them per route', () => {
  const payload = loadServer({ raw_data: DATA, config: CONFIG, config_tuyen: ROUTES_WITH_POINTS }).getLookupData();
  assert.deepEqual({ ...payload.routes[0] }, { ten_tuyen: 'Tuyến 1', phuong_xa: 'Xã Tả Thanh Oai', quan_huyen: 'Huyện Thanh Trì', lat: 20.93, lng: 105.8 });
  const Lookup = loadLookup();
  const index = Lookup.buildIndex(payload);
  assert.deepEqual([...Lookup.routeWardPoints('Tuyến 1', index).map((w) => w.phuong_xa)], ['Xã Tả Thanh Oai', 'Xã Vĩnh Quỳnh']);
  assert.equal(Lookup.routeWardPoints('Tuyến 9', index).length, 0);
});

test('locateOrder geocodes the full address once, then serves it from toa_do_don', () => {
  const tables = { raw_data: DATA, config: CONFIG, config_tuyen: ROUTES_WITH_POINTS };
  const server = loadServer(tables, { 'Số 1 Ngõ A': { lat: 20.931, lng: 105.801, district: 'Thanh Trì' } });
  const r = server.locateOrder(' gyegff9c ');
  assert.deepEqual({ ...r }, { code: 'GYEGFF9C', lat: 20.931, lng: 105.801, nguon: 'dia_chi' });
  assert.deepEqual([...server.geocoded], ['Số 1 Ngõ A, Xã Tả Thanh Oai, Huyện Thanh Trì, Hà Nội']);
  assert.deepEqual([...tables.toa_do_don[0]], ['tracking_number', 'lat', 'lng', 'nguon']);
  assert.deepEqual([...tables.toa_do_don[1]], ['GYEGFF9C', 20.931, 105.801, 'dia_chi']);
  assert.deepEqual({ ...server.locateOrder('GYEGFF9C') }, { ...r });
  assert.equal(server.geocoded.length, 1); // cached: no second Goong call
  assert.equal(tables.toa_do_don.length, 2);
});

test('locateOrder falls back to the ward point when the address is not found or in another district', () => {
  const far = loadServer({ raw_data: DATA, config: CONFIG, config_tuyen: ROUTES_WITH_POINTS }, { 'Số 1 Ngõ A': { lat: 10.97, lng: 106.75, district: 'Tân Uyên' } });
  assert.deepEqual({ ...far.locateOrder('GYEGFF9C') }, { code: 'GYEGFF9C', lat: 20.93, lng: 105.8, nguon: 'phuong_xa' });
  const none = loadServer({ raw_data: DATA, config: CONFIG, config_tuyen: ROUTES_WITH_POINTS }, {});
  assert.equal(none.locateOrder('GYEGFF9C').nguon, 'phuong_xa');
  assert.throws(() => none.locateOrder('AAAA1111'), /Không định vị được đơn AAAA1111/); // no address, no ward
});

test('locate endpoint: errors come back as {error}', () => {
  const server = loadServer({ raw_data: DATA, config: CONFIG }, {});
  const call = (code) => JSON.parse(server.doGet({ parameter: { action: 'locate', code } }).text);
  assert.match(call('=1+1').error, /Mã không hợp lệ/);
  assert.match(call('ZZZZ9999').error, /Không tìm thấy đơn ZZZZ9999/);
});

test('Goong key problems stop the run instead of misplacing wards', () => {
  const tables = { raw_data: DATA, config: CONFIG };
  assert.throws(() => loadServer(tables, { httpStatus: 403 }).taoCauHinhTuyen(), /Goong từ chối API key \(HTTP 403\)/);
  assert.equal(tables.config_tuyen, undefined);
});

test('Goong 429: a short burst is retried; persistent "too fast" or an empty quota stops the run', () => {
  const geo = { tooFast: 2, 'Số 1 Ngõ A': { lat: 20.931, lng: 105.801, district: 'Thanh Trì' } };
  const server = loadServer({ raw_data: DATA, config: CONFIG, config_tuyen: ROUTES_WITH_POINTS }, geo);
  assert.equal(server.locateOrder('GYEGFF9C').nguon, 'dia_chi'); // succeeded after two 429s
  const tooFast = loadServer({ raw_data: DATA, config: CONFIG }, { tooFast: 99 });
  assert.throws(() => tooFast.locateOrder('GYEGFF9C'), /gọi quá nhanh \(HTTP 429\) kể cả sau 3 lần chờ/);
  const empty = loadServer({ raw_data: DATA, config: CONFIG }, { quota: 0 });
  assert.throws(() => empty.locateOrder('GYEGFF9C'), /đã dùng hết hạn mức 1000 lượt/);
});

test('a run stopped by the quota keeps its order points; the rerun reuses them', () => {
  const data = DATA.concat(Array.from({ length: 7 }, (_, i) =>
    ['2026-11-11', 'Q' + i, 'ghn', 'ASSIGNING', 'Huyện Thanh Trì', `Nhà ${i}, Xã Vĩnh Quỳnh, Huyện Thanh Trì, Hà Nội`]));
  const geo = { quota: 5, 'Số 1 Ngõ A': { lat: 20.93, lng: 105.8, district: 'Thanh Trì' } };
  for (let i = 0; i < 7; i++) geo['Nhà ' + i] = { lat: 20.95, lng: 105.81, district: 'Thanh Trì' };
  const tables = { raw_data: data, config: CONFIG };
  assert.throws(() => loadServer(tables, geo).taoCauHinhTuyen(), /hết hạn mức/);
  assert.equal(tables.config_tuyen, undefined); // nothing half-built
  const saved = tables.toa_do_don.length - 1;
  assert.equal(saved, 4); // 2 wards, up to 3 samples each: the first batch of 5 minus the miss (Số 2 Ngõ B)

  geo.quota = 100;
  const rerun = loadServer(tables, geo);
  rerun.taoCauHinhTuyen();
  assert.ok(rerun.geocoded.every((a) => !/^Nhà [0-2],|^Số 1 Ngõ A/.test(a)), 'cached orders are not geocoded again');
  assert.ok(tables.config_tuyen.length > 1);
});

test('Goong network failures are retried, and the final error never shows the API key', () => {
  const geo = { networkErrors: 2, 'Số 1 Ngõ A': { lat: 20.931, lng: 105.801, district: 'Thanh Trì' } };
  const server = loadServer({ raw_data: DATA, config: CONFIG, config_tuyen: ROUTES_WITH_POINTS }, geo);
  assert.equal(server.locateOrder('GYEGFF9C').nguon, 'dia_chi');
  const down = loadServer({ raw_data: DATA, config: CONFIG }, { networkErrors: 99 });
  assert.throws(() => down.locateOrder('GYEGFF9C'), (err) =>
    /Không kết nối được Goong \(Địa chỉ không khả dụng\) sau 3 lần/.test(err.message) && !err.message.includes('test-key'));
});

test('a long batch run stops itself before the 6-minute limit, keeping its progress', () => {
  const server = loadServer({}, { 'Số 1 Ngõ A': { lat: 20.93, lng: 105.8, district: 'Thanh Trì' } });
  vm.runInContext('GOONG_STARTED_AT = Date.now() - 10 * 60 * 1000', server); // pretend 10 minutes passed
  const queries = [1, 2, 3, 4, 5, 6].map((i) => ({ address: 'Số 1 Ngõ A, x' + i, district: 'Thanh Trì' }));
  let saved = 0;
  assert.throws(() => server.goongGeocodeMany_(queries, (r) => { saved += r.length; }), /bấm Run lần nữa để chạy tiếp/);
  assert.equal(saved, 5); // the first batch finished and was handed over before stopping
});

test('Chia tuyến: speaks the order\'s route, like Chia chọn speaks the area', () => {
  const { Lookup, index } = pickSetup();
  const r = Lookup.resolveRouteSort(' t1c ', index);
  assert.deepEqual([r.status, r.speech, r.ward, r.district], ['ok', 'Tuyến 1', 'Xã Vĩnh Quỳnh', 'Huyện Thanh Trì']);
  assert.equal(Lookup.resolveRouteSort('https://x.vn/t?code=T2A', index).speech, 'Tuyến 2');
  assert.equal(Lookup.resolveRouteSort('T1X', index).speech, 'Đơn đã huỷ');
  assert.equal(Lookup.resolveRouteSort('NOR', index).speech, 'Chưa có tuyến'); // ward not in config_tuyen
  assert.equal(Lookup.resolveRouteSort('ZZZZ', index).speech, 'Không tìm thấy đơn');
  assert.equal(Lookup.resolveRouteSort('  ', index).status, 'empty');
  const { Lookup: L2, index: noWard } = routeSetup();
  assert.equal(L2.resolveRouteSort('AAAA1111', noWard).speech, 'Chưa rõ phường xã'); // address without a ward
  const none = L2.buildIndex(loadServer({ raw_data: DATA, config: CONFIG }).getLookupData());
  assert.equal(L2.resolveRouteSort('GYEGFF9C', none).status, 'unavailable');
});

// ---------- Chuyến đi mode: sheet chuyen_di ----------

const TRIP_HEADER = ['ma_chuyen', 'bks', 'thoi_gian', 'tracking_number'];

function tripServer(rows) {
  const tables = { raw_data: DATA, config: CONFIG };
  if (rows) tables.chuyen_di = rows;
  return { server: loadServer(tables), tables };
}

test('createTrip creates chuyen_di, saves one text row per order and numbers trips per day', () => {
  const { server, tables } = tripServer();
  const now = server.tripNow_();
  const a = server.createTrip(' 29c-123.45 ', ['gyegff9c', 'AAAA1111', 'GYEGFF9C']);
  assert.equal(a.ok, true);
  assert.equal(a.ma_chuyen, `CD${now.stamp}-01`);
  assert.equal(a.bks, '29C-123.45');
  assert.match(a.thoi_gian, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
  assert.deepEqual([...a.codes], ['GYEGFF9C', 'AAAA1111']); // repeats dropped, scan order kept
  const b = server.createTrip('30A  12345', ['BBBB2222']);
  assert.equal(b.ma_chuyen, `CD${now.stamp}-02`);
  assert.equal(b.bks, '30A 12345');
  assert.deepEqual(tables.chuyen_di.map((r) => [...r]), [
    TRIP_HEADER,
    [a.ma_chuyen, '29C-123.45', a.thoi_gian, 'GYEGFF9C'],
    [a.ma_chuyen, '29C-123.45', a.thoi_gian, 'AAAA1111'],
    [b.ma_chuyen, '30A 12345', b.thoi_gian, 'BBBB2222'],
  ]);
});

test('createTrip refuses orders already in a trip today without writing; other days do not block', () => {
  const { server, tables } = tripServer();
  const first = server.createTrip('29C12345', ['GYEGFF9C']);
  const rowsBefore = tables.chuyen_di.length;
  const r = server.createTrip('30A12345', ['AAAA1111', 'gyegff9c']);
  assert.equal(r.ok, false);
  assert.deepEqual([...r.conflicts].map((c) => ({ ...c })), [{ code: 'GYEGFF9C', ma_chuyen: first.ma_chuyen, bks: '29C12345' }]);
  assert.equal(tables.chuyen_di.length, rowsBefore);

  const old = tripServer([TRIP_HEADER, ['CD000101-01', '29C12345', '01/01/2000 08:00:00', 'AAAA1111']]);
  const again = old.server.createTrip('30A12345', ['AAAA1111']);
  assert.equal(again.ok, true);
  assert.match(again.ma_chuyen, /-01$/); // numbering restarts each day
});

test('createTrip rejects bad plates, empty or formula-like codes', () => {
  const { server, tables } = tripServer();
  for (const plate of ['', 'AB', '=1+1', '@29C', '29C-123.45-67890']) {
    assert.throws(() => server.createTrip(plate, ['GYEGFF9C']), /Biển kiểm soát không hợp lệ/);
  }
  assert.throws(() => server.createTrip('29C12345', []), /Chuyến chưa có đơn/);
  assert.throws(() => server.createTrip('29C12345', 'GYEGFF9C'), /Chuyến chưa có đơn/);
  for (const code of ['', '=HYPERLINK("x")', '+1', 'https://x.y/z']) {
    assert.throws(() => server.createTrip('29C12345', ['GYEGFF9C', code]), /Mã không hợp lệ/);
  }
  assert.throws(() => server.createTrip('29C12345', Array.from({ length: 2001 }, (_, i) => `C${i}`)), /quá 2000 đơn/);
  assert.equal(tables.chuyen_di, undefined); // nothing created by refused trips
});

test('listTrips: trips of one day, newest first, with their codes; missing sheet is empty', () => {
  const rows = [
    TRIP_HEADER,
    ['CD261112-01', '29C1', '12/11/2026 07:00:00', 'OLD1'],
    ['CD261113-01', '29C1', '13/11/2026 08:00:00', 'A1'],
    ['CD261113-01', '29C1', '13/11/2026 08:00:00', 'a2'],
    ['', '', '', ''],
    ['CD261113-02', '30A2', '13/11/2026 09:15:00', 'B1'],
  ];
  const { server } = tripServer(rows);
  const r = server.listTrips('13/11/2026');
  assert.equal(r.day, '13/11/2026');
  assert.deepEqual(JSON.parse(JSON.stringify(r.trips)), [
    { ma_chuyen: 'CD261113-02', bks: '30A2', thoi_gian: '13/11/2026 09:15:00', codes: ['B1'] },
    { ma_chuyen: 'CD261113-01', bks: '29C1', thoi_gian: '13/11/2026 08:00:00', codes: ['A1', 'A2'] },
  ]);
  assert.equal(server.listTrips('01/01/2000').trips.length, 0);
  assert.throws(() => server.listTrips('2026-11-13'), /Ngày không hợp lệ/);
  const empty = tripServer().server.listTrips();
  assert.equal(empty.day, empty.day.match(/^\d{2}\/\d{2}\/\d{4}$/)[0]); // default = today
  assert.equal(empty.trips.length, 0);
});

test('trip endpoints: POST {action:trip} saves, GET ?action=trips lists, errors as {error}', () => {
  const { server } = tripServer();
  const post = (body) => JSON.parse(server.doPost({ postData: { contents: body } }).text);
  const saved = post(JSON.stringify({ action: 'trip', plate: '29C12345', codes: ['GYEGFF9C'] }));
  assert.equal(saved.ok, true);
  assert.match(post(JSON.stringify({ action: 'write', cell: 'C3', code: 'X1' })).error, /Thao tác không hợp lệ/);
  assert.match(post(JSON.stringify({ action: 'trip', plate: '', codes: ['X1'] })).error, /Biển kiểm soát/);
  assert.ok(post('not json').error);
  const get = (parameter) => JSON.parse(server.doGet({ parameter }).text);
  assert.deepEqual([...get({ action: 'trips' }).trips[0].codes], ['GYEGFF9C']);
  assert.match(get({ action: 'trips', day: 'x' }).error, /Ngày không hợp lệ/);
});

test('Chuyến đi scan: "Có" for a known order; refuses EOD returns, repeats, other trips, unknown codes', () => {
  const data = [...DATA.slice(0, -1), ['2026-11-10', 'EEEE5555', 'ghn', ' need_return_to_partner_eod ', 'Quận Hoàng Mai', '']];
  const Lookup = loadLookup();
  const index = Lookup.buildIndex(loadServer({ raw_data: data, config: CONFIG }).getLookupData());
  const none = new Map();
  const ok = Lookup.resolveTripScan(' gyegff9c ', index, {}, none);
  assert.deepEqual([ok.status, ok.code, ok.speech], ['ok', 'GYEGFF9C', 'Có']);
  assert.equal(Lookup.resolveTripScan('https://x.vn/t?code=GYEGFF9C', index, {}, none).code, 'GYEGFF9C');
  assert.equal(Lookup.resolveTripScan('CCCC3333', index, {}, none).speech, 'Có'); // only EOD returns are refused
  const refused = Lookup.resolveTripScan('eeee5555', index, {}, none);
  assert.deepEqual([refused.status, refused.speech], ['refused', 'Không, đơn trả đối tác']);
  assert.equal(Lookup.resolveTripScan('GYEGFF9C', index, { GYEGFF9C: true }, none).speech, 'Đã quét');
  const taken = new Map([['AAAA1111', { ma_chuyen: 'CD261113-01', bks: '29C12345' }]]);
  const other = Lookup.resolveTripScan('AAAA1111', index, {}, taken);
  assert.deepEqual([other.status, other.trip.ma_chuyen, other.speech], ['taken', 'CD261113-01', 'Đã ở chuyến xe 29C12345']);
  assert.equal(Lookup.resolveTripScan('ZZZZ9999', index, {}, none).speech, 'Không tìm thấy đơn');
  assert.equal(Lookup.resolveTripScan('   ', index, {}, none).status, 'empty');
});

test('client plate rule matches the server: normalizePlate', () => {
  const Lookup = loadLookup();
  assert.equal(Lookup.normalizePlate(' 29c-123.45 '), '29C-123.45');
  assert.equal(Lookup.normalizePlate('30a   12345'), '30A 12345');
  for (const bad of ['', 'AB', '=1+1', '29C-123.45-67890']) assert.equal(Lookup.normalizePlate(bad), '');
});

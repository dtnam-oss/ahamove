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
 * `geo` maps the first part of a geocoding query (ward or district name) to {lat, lng}.
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
  const Maps = {
    newGeocoder: () => ({
      setRegion() { return this; },
      setLanguage() { return this; },
      geocode: (query) => {
        const point = geo[query.split(',')[0].trim()];
        return point ? { status: 'OK', results: [{ geometry: { location: point } }] } : { status: 'ZERO_RESULTS', results: [] };
      },
    }),
  };
  const Utilities = { sleep() {} };
  const ContentService = {
    MimeType: { JSON: 'json' },
    createTextOutput: (text) => ({ text, setMimeType(m) { this.mime = m; return this; } }),
  };
  const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const ctx = vm.createContext({
    SpreadsheetApp: { openById: () => spreadsheet, flush() {} }, ContentService, LockService, Maps, Utilities, console,
  });
  vm.runInContext(read('gas/config.example.js'), ctx);
  vm.runInContext(read('gas/Code.js'), ctx);
  vm.runInContext(read('gas/routes.js'), ctx);
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

// ---------- Write mode: sheet data_don ----------

/** In-memory sheet: cells[row][col] (1-based), sized maxRows x maxCols, recording formats. */
function fakeScanSheet(filled = {}, maxRows = 1000, maxCols = 26) {
  const cells = {};
  const formats = {};
  for (const [a1, v] of Object.entries(filled)) {
    const m = /^([A-Z])(\d+)$/.exec(a1);
    (cells[Number(m[2])] ||= {})[m[1].charCodeAt(0) - 64] = v;
  }
  const get = (r, c) => (cells[r] && cells[r][c]) || '';
  const sheet = {
    cells,
    formats,
    getLastRow: () => Math.max(0, ...Object.keys(cells).map(Number).filter((r) => Object.values(cells[r]).some(Boolean))),
    getMaxRows: () => maxRows,
    getMaxColumns: () => maxCols,
    insertRowsAfter: (after, n) => { maxRows += n; },
    getRange: (row, col, numRows = 1) => {
      if (row + numRows - 1 > maxRows || col > maxCols) throw new Error('out of bounds');
      return {
        getDisplayValues: () => Array.from({ length: numRows }, (_, i) => [get(row + i, col)]),
        setNumberFormat(f) { formats[`${row},${col}`] = f; return this; },
        setValue(v) { (cells[row] ||= {})[col] = v; return this; },
      };
    },
  };
  return sheet;
}

function scanServer(sheet) {
  return loadServer({ raw_data: DATA, config: CONFIG, data_don: sheet });
}

test('writeScan writes the code as text at the chosen cell', () => {
  const sheet = fakeScanSheet();
  const r = scanServer(sheet).writeScan('c3', ' gyegff9c ');
  assert.deepEqual({ ...r }, { ok: true, cell: 'C3', code: 'GYEGFF9C' });
  assert.equal(sheet.cells[3][3], 'GYEGFF9C');
  assert.equal(sheet.formats['3,3'], '@');
});

test('writeScan skips taken cells and never overwrites', () => {
  const sheet = fakeScanSheet({ C3: 'AAA1', C4: 'AAA2', C6: 'AAA4', D5: 'other column' });
  const server = scanServer(sheet);
  assert.equal(server.writeScan('C3', 'NEW1').cell, 'C5');
  assert.equal(server.writeScan('C3', 'NEW2').cell, 'C7');
  assert.equal(sheet.cells[3][3], 'AAA1');
  assert.equal(sheet.cells[6][3], 'AAA4');
});

test('writeScan grows the sheet when the column is full to the last row', () => {
  const sheet = fakeScanSheet({ A1: 'X', A2: 'Y' }, 2);
  assert.equal(scanServer(sheet).writeScan('A1', 'Z1').cell, 'A3');
  assert.equal(sheet.cells[3][1], 'Z1');
});

test('writeScan handles multi-letter columns', () => {
  const sheet = fakeScanSheet({}, 1000, 30);
  assert.equal(scanServer(sheet).writeScan('AB10', 'X1').cell, 'AB10');
  assert.equal(sheet.cells[10][28], 'X1');
});

test('writeScan refuses a code already anywhere in the column, without writing', () => {
  const sheet = fakeScanSheet({ C1: 'gyegff9c', C3: 'AAA1', D4: 'BBB2' });
  const server = scanServer(sheet);
  const dup = server.writeScan('C3', 'GYEGFF9C'); // above the start cell, different case
  assert.deepEqual({ ...dup }, { ok: false, duplicate: true, cell: 'C1', code: 'GYEGFF9C' });
  assert.equal(sheet.cells[4][3], undefined); // nothing written in C
  assert.equal(server.writeScan('C3', 'BBB2').cell, 'C4'); // same value in another column is fine
  assert.equal(server.writeScan('C3', 'BBB2').duplicate, true); // re-scan of what was just written
  assert.equal(sheet.cells[5], undefined);
});

test('writeScan rejects bad cells, formula-like codes and a missing sheet', () => {
  const server = scanServer(fakeScanSheet());
  for (const cell of ['', 'C0', '3C', 'C3:C9', 'ABCD1']) assert.throws(() => server.writeScan(cell, 'X1'), /Ô không hợp lệ/);
  for (const code of ['', '=HYPERLINK("x")', '+1', '@A', 'https://x.y/z']) assert.throws(() => server.writeScan('C3', code), /Mã không hợp lệ/);
  assert.throws(() => scanServer(fakeScanSheet({}, 1000, 3)).writeScan('D1', 'X1'), /nằm ngoài sheet/);
  assert.throws(() => loadServer({ raw_data: DATA, config: CONFIG }).writeScan('C3', 'X1'), /Không tìm thấy sheet "data_don"/);
});

test('doPost {action:write} returns the written cell, errors as {error}', () => {
  const server = scanServer(fakeScanSheet({ C3: 'TAKEN' }));
  const post = (body) => JSON.parse(server.doPost({ postData: { contents: body } }).text);
  assert.equal(post(JSON.stringify({ action: 'write', cell: 'C3', code: 'GYEGFF9C' })).cell, 'C4');
  assert.match(post(JSON.stringify({ action: 'delete' })).error, /Thao tác không hợp lệ/);
  assert.ok(post('not json').error);
});

test('client cell helpers: normalizeCell / nextCell', () => {
  const Lookup = loadLookup();
  assert.equal(Lookup.normalizeCell(' c 3 '), 'C3');
  assert.equal(Lookup.normalizeCell('C0'), '');
  assert.equal(Lookup.normalizeCell('C3:C4'), '');
  assert.equal(Lookup.nextCell('C3'), 'C4');
  assert.equal(Lookup.nextCell('ab99'), 'AB100');
  assert.equal(Lookup.nextCell('bad'), '');
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
  assert.equal(Lookup.resolveRoute('GYEGFF9C', Lookup.buildIndex(payload)).status, 'unavailable');
});

test('route scan speaks "<tuyến>, <phường/xã>"', () => {
  const { Lookup, index } = routeSetup();
  const r = Lookup.resolveRoute(' gyegff9c ', index);
  assert.equal(r.status, 'ok');
  assert.equal(r.speech, 'Tuyến 1, Xã Tả Thanh Oai');
  assert.equal(Lookup.resolveRoute('https://x.vn/t?code=GYEGFFYE', index).speech, 'Tuyến 2, Xã Liệp Nghĩa');
});

test('route scan: tone/case variants of the ward still match', () => {
  const rows = ROUTES.map((r) => r.slice());
  rows[1][1] = 'xã tả thanh oai';
  rows[1][2] = 'HUYỆN THANH TRÌ';
  const { Lookup, index } = routeSetup(rows);
  assert.equal(Lookup.resolveRoute('GYEGFF9C', index).route, 'Tuyến 1');
});

test('route scan: not found, cancelled, no ward, ward without route', () => {
  const { Lookup, index } = routeSetup();
  assert.equal(Lookup.resolveRoute('ZZZZ9999', index).speech, 'Không tìm thấy đơn');
  assert.equal(Lookup.resolveRoute('CCCC3333', index).speech, 'Đơn đã huỷ');
  assert.equal(Lookup.resolveRoute('AAAA1111', index).status, 'no_ward');
  const { Lookup: L2, index: i2 } = routeSetup(ROUTES.slice(0, 2)); // only Tuyến 1 configured
  const r = L2.resolveRoute('GYEGFFYE', i2);
  assert.equal(r.status, 'unmapped');
  assert.equal(r.speech, 'Chưa có tuyến, Xã Liệp Nghĩa');
  assert.equal(Lookup.resolveRoute(' ', index).status, 'empty');
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
    'Xã Tả Thanh Oai': { lat: 20.93, lng: 105.8 },
    'Huyện Quốc Oai': { lat: 20.99, lng: 105.64 }, // ward not found -> district centre fallback
  });
  const msg = server.taoCauHinhTuyen();
  assert.match(msg, /Tạo 2 xã vào 1 tuyến/); // 2 orders in total: one route, flagged as under the minimum
  assert.match(msg, /1 tuyến dưới 30 đơn.*Tuyến 1 \(2 đơn\)/);
  assert.deepEqual([...tables.config_tuyen[0]], ['ten_tuyen', 'phuong_xa', 'quan_huyen', 'lat', 'lng', 'so_don']);
  const body = tables.config_tuyen.slice(1);
  assert.deepEqual(body.map((r) => r[1]).sort(), ['Xã Liệp Nghĩa', 'Xã Tả Thanh Oai']);
  assert.ok(body.every((r) => r[0] === 'Tuyến 1'));
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
  const server = loadServer(tables, { 'Xã Vĩnh Quỳnh': { lat: 20.95, lng: 105.81 } }); // closest to Tuyến 1
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
  const server = loadServer(tables, { 'Xã Ba Trại': { lat: 21.1, lng: 105.35 } });
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

test('a ward geocoded far from its own district falls back to the district centre', () => {
  const wards = [
    { key: 'a', phuong_xa: 'Xã Tam Hiệp', quan_huyen: 'Huyện Thanh Trì', city: 'Hà Nội', so_don: 1 },
    { key: 'b', phuong_xa: 'Xã Vĩnh Quỳnh', quan_huyen: 'Huyện Thanh Trì', city: 'Hà Nội', so_don: 1 },
  ];
  const geo = {
    'Huyện Thanh Trì': { lat: 20.94, lng: 105.84 },
    'Xã Tam Hiệp': { lat: 21.085, lng: 105.626 }, // the Tam Hiệp in Phúc Thọ, ~27 km away
    'Xã Vĩnh Quỳnh': { lat: 20.95, lng: 105.81 },
  };
  const located = loadServer({}, geo).locateWards_(wards).located;
  assert.deepEqual([located[0].lat, located[0].lng], [20.94, 105.84]);
  assert.deepEqual([located[1].lat, located[1].lng], [20.95, 105.81]);
});

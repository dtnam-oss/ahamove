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

/** Fake SpreadsheetApp returning given 2D display values per sheet name (or a fake sheet object). */
function loadServer(tables) {
  const spreadsheet = {
    getSheetByName: (name) => {
      const t = tables[name];
      if (!t) return null;
      return Array.isArray(t) ? { getDataRange: () => ({ getDisplayValues: () => t }) } : t;
    },
  };
  const ContentService = {
    MimeType: { JSON: 'json' },
    createTextOutput: (text) => ({ text, setMimeType(m) { this.mime = m; return this; } }),
  };
  const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const ctx = vm.createContext({ SpreadsheetApp: { openById: () => spreadsheet, flush() {} }, ContentService, LockService });
  vm.runInContext(read('gas/config.example.js'), ctx);
  vm.runInContext(read('gas/Code.js'), ctx);
  return ctx;
}

// Mirrors the current `data` sheet: key = tracking_number. The trailing partner_order_code
// column holds stale values from an older layout (not aligned with the row) and must be ignored.
const DATA = [
  ['tracking_number', 'status', 'district', 'mobile_seller', 'partner_order_code'],
  ['GYEGFF9C', 'VERIFYING', 'Huyện Thanh Trì', '0900000001', 'GYE7R6DF'],
  [' gyegffye ', 'VERIFYING', 'Huyện Quốc Oai', '0900000002', 'GYE7YM3A'],
  ['AAAA1111', 'VERIFYING', 'Huyện Ứng Hoà', '', ''], // old-style tone placement
  ['BBBB2222', 'VERIFYING', '', '', ''],
  ['CCCC3333', 'NEED_RETURN_TO_PARTNER_ASAP', 'Huyện Thanh Trì', '', ''],
  ['DDDD4444', ' need_return_to_partner_asap ', 'Huyện Quốc Oai', '', ''],
  ['', '', '', '', ''],
];
const CONFIG = [
  ['ma_vi_tri', 'ten_vi_tri', 'khu_vuc'],
  ['NT1', 'Khu vực 1', 'Quận Hoàng Mai'],
  ['Nthanh1', 'Khu vực 2', 'Huyện Thanh Trì , Huyện Sóc Sơn'],
  ['Nthanh2', 'Khu vực 3', 'Huyện Ứng Hòa , Huyện Thường Tín'],
];

function setup() {
  const server = loadServer({ data: DATA, config: CONFIG });
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
  assert.ok(!JSON.stringify(payload).includes('0900000002'));
  assert.deepEqual([...payload.config[1].khu_vuc], ['Huyện Thanh Trì', 'Huyện Sóc Sơn']);
});

test('stale partner_order_code values are not lookup keys', () => {
  const { Lookup, index } = setup();
  assert.equal(Lookup.resolveScan('GYE7R6DF', index).status, 'not_found');
});

test('server reports missing columns and sheets', () => {
  assert.throws(() => loadServer({ data: [['x']], config: CONFIG }).getLookupData(), /thiếu cột tracking_number/);
  assert.throws(() => loadServer({ data: [['tracking_number', 'district']], config: CONFIG }).getLookupData(), /thiếu cột status/);
  assert.throws(() => loadServer({ config: CONFIG }).getLookupData(), /Không tìm thấy sheet "data"/);
});

test('doGet ?action=data returns JSON payload, errors as {error}', () => {
  const ok = loadServer({ data: DATA, config: CONFIG }).doGet({ parameter: { action: 'data' } });
  assert.equal(ok.mime, 'json');
  assert.equal(JSON.parse(ok.text).orderCount, 6);
  const bad = loadServer({ config: CONFIG }).doGet({ parameter: { action: 'data' } });
  assert.match(JSON.parse(bad.text).error, /Không tìm thấy sheet "data"/);
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
  return loadServer({ data: DATA, config: CONFIG, data_don: sheet });
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
  assert.throws(() => loadServer({ data: DATA, config: CONFIG }).writeScan('C3', 'X1'), /Không tìm thấy sheet "data_don"/);
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

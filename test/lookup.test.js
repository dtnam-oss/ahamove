// Tests for the client lookup (gas/lookup.html) and server payload builder (gas/Code.js).
// Both GAS files are loaded into a Node VM so the deployed code is exactly what is tested.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(`../gas/${p}`, import.meta.url), 'utf8');

function loadLookup() {
  const src = read('lookup.html').replace(/<\/?script>/g, '');
  const ctx = vm.createContext({});
  vm.runInContext(`${src}\nthis.Lookup = Lookup;`, ctx);
  return ctx.Lookup;
}

/** Fake SpreadsheetApp returning given 2D display values per sheet name. */
function loadServer(tables) {
  const spreadsheet = {
    getSheetByName: (name) =>
      tables[name] ? { getDataRange: () => ({ getDisplayValues: () => tables[name] }) } : null,
  };
  const ctx = vm.createContext({ SpreadsheetApp: { openById: () => spreadsheet } });
  vm.runInContext(read('config.example.js'), ctx);
  vm.runInContext(read('Code.js'), ctx);
  return ctx;
}

const DATA = [
  ['order_id', 'partner_order_code', 'recipient_phone', 'district'],
  ['GHNBULKY_GYE7H4UB', 'GYE7H4UB', '0900000001', 'Huyện Thanh Trì'],
  ['GHNBULKY_GYE7Q9U3', ' gye7q9u3 ', '0900000002', 'Huyện Quốc Oai'],
  ['GHNBULKY_AAAA1111', 'AAAA1111', '', 'Huyện Ứng Hoà'], // old-style tone placement
  ['GHNBULKY_BBBB2222', 'BBBB2222', '', ''],
  ['', '', '', ''],
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

test('server payload has only code -> district and parsed config (no PII)', () => {
  const { payload } = setup();
  assert.equal(payload.orderCount, 4);
  assert.deepEqual(Object.keys(payload.orders).sort(), ['AAAA1111', 'BBBB2222', 'GYE7H4UB', 'GYE7Q9U3']);
  assert.equal(payload.orders.GYE7Q9U3, 'Huyện Quốc Oai');
  assert.ok(!JSON.stringify(payload).includes('0900000002'));
  assert.deepEqual([...payload.config[1].khu_vuc], ['Huyện Thanh Trì', 'Huyện Sóc Sơn']);
});

test('server reports missing columns and sheets', () => {
  assert.throws(() => loadServer({ data: [['x']], config: CONFIG }).getLookupData(), /thiếu cột partner_order_code/);
  assert.throws(() => loadServer({ config: CONFIG }).getLookupData(), /Không tìm thấy sheet "data"/);
});

test('mapped district speaks ten_vi_tri + district', () => {
  const { Lookup, index } = setup();
  const r = Lookup.resolveScan('GYE7H4UB', index);
  assert.equal(r.status, 'ok');
  assert.equal(r.speech, 'Khu vực 2, Huyện Thanh Trì');
});

test('scan is case/space insensitive', () => {
  const { Lookup, index } = setup();
  assert.equal(Lookup.resolveScan('  gye7h4ub\n', index).status, 'ok');
});

test('district in a multi-district config cell matches the second entry', () => {
  const { Lookup } = setup();
  const index = Lookup.buildIndex({ orders: { X1: 'Huyện Sóc Sơn' }, config: [{ ten_vi_tri: 'Khu vực 2', khu_vuc: ['Huyện Thanh Trì', 'Huyện Sóc Sơn'] }] });
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
  const r = Lookup.resolveScan('GYE7Q9U3', index);
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
  assert.equal(Lookup.resolveScan('https://ahamove.com/track?code=GYE7H4UB&x=1', index).code, 'GYE7H4UB');
  assert.equal(Lookup.resolveScan('{"tracking":"GYE7H4UB"}', index).status, 'ok');
});

test('empty scan is ignored', () => {
  const { Lookup, index } = setup();
  assert.equal(Lookup.resolveScan('   ', index).status, 'empty');
});

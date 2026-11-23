// Tests for the macOS pc-typer (pc-typer/mac/server.mjs): the HTTP protocol shared with the Windows version,
// the osascript call, the pairing key and the self-signed certificate (real openssl + TLS when available).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createHandler, cleanText, typerArgs, macTyper, loadKey, ensureCert, APP_ORIGIN,
} from '../pc-typer/mac/server.mjs';

const KEY = 'ABCD2345';

async function withServer(type, fn) {
  const typed = [];
  const handler = createHandler({ key: KEY, name: 'TEST-MAC', type: type || ((t) => { typed.push(t); return Promise.resolve(); }), log() {} });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, typed); } finally { server.close(); }
}

const post = (base, body, key = KEY) => fetch(base + '/type', {
  method: 'POST', headers: { 'X-Key': key, 'Content-Type': 'text/plain;charset=utf-8', Origin: APP_ORIGIN }, body,
});

test('mac pc-typer: preflight, key check, ping and root redirect', async () => {
  await withServer(null, async (base) => {
    let res = await fetch(base + '/type', { method: 'OPTIONS', headers: { Origin: APP_ORIGIN, 'Access-Control-Request-Method': 'POST' } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), APP_ORIGIN);
    assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type, X-Key');
    assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
    res = await fetch(base + '/type', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'other sites get no CORS');

    res = await fetch(base + '/ping', { headers: { 'X-Key': KEY } });
    assert.deepEqual(await res.json(), { ok: true, name: 'TEST-MAC' });
    for (const key of [undefined, 'ABCD2346', 'ABCD23456']) {
      res = await fetch(base + '/ping', { headers: key ? { 'X-Key': key } : {} });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'Sai mã kết nối' });
    }

    // fetch overrides Host, so the address the phone used is sent with http.request.
    const root = (key, host) => new Promise((resolve, reject) => {
      http.get(base + '/?key=' + key, { headers: { Host: host } }, (r) => { r.resume(); resolve(r); }).on('error', reject);
    });
    let r = await root(KEY, '192.168.1.10:8443');
    assert.equal(r.statusCode, 302);
    assert.equal(r.headers.location, 'https://dtnam-oss.github.io/ahamove/#pc=192.168.1.10%3A8443&key=ABCD2345');
    r = await root(KEY, 'evil.com/x:1');
    assert.equal(r.statusCode, 200, 'odd Host: no redirect');
    res = await fetch(base + '/?key=WRONG234', { redirect: 'manual' });
    assert.equal(res.status, 200, 'wrong key: info page, no key leaked');
    assert.ok(!(await res.text()).includes(KEY));
    res = await fetch(base + '/nope', { headers: { 'X-Key': KEY } });
    assert.equal(res.status, 404);
  });
});

test('mac pc-typer: types cleaned text in order, rejects empty/long/unkeyed, reports typing errors', async () => {
  await withServer(null, async (base, typed) => {
    assert.deepEqual(await (await post(base, 'GYE7WB4C')).json(), { ok: true });
    assert.equal((await post(base, '  Đơn\tA1\r\nB  ')).status, 200);
    assert.equal((await post(base, '   ')).status, 400);
    assert.equal((await post(base, 'X'.repeat(201))).status, 400);
    assert.equal((await post(base, 'X'.repeat(3000))).status, 400);
    assert.equal((await post(base, 'ZZZ', 'ABCD2346')).status, 401);
    const res = await post(base, 'GYEFAPQW');
    assert.equal(res.headers.get('access-control-allow-origin'), APP_ORIGIN);
    assert.deepEqual(typed, ['GYE7WB4C', 'ĐơnA1B', 'GYEFAPQW']);
  });
  await withServer(() => Promise.reject(new Error('Mac chưa cấp quyền Trợ năng (Accessibility) cho Terminal')), async (base) => {
    const res = await post(base, 'GYE7WB4C');
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'Mac chưa cấp quyền Trợ năng (Accessibility) cho Terminal' });
  });
});

test('cleanText keeps printable text up to 200 characters', () => {
  assert.equal(cleanText(' GYE7WB4C\n'), 'GYE7WB4C');
  assert.equal(cleanText('\u0007\u009f'), null);
  assert.equal(cleanText('Y'.repeat(200)), 'Y'.repeat(200));
  assert.equal(cleanText(null), null);
});

test('macTyper passes the text as an osascript argument, keeps order, maps the Accessibility error', async () => {
  assert.deepEqual(typerArgs('A"B\\C'), ['-e', 'on run argv', '-e', 'tell application "System Events"', '-e',
    'keystroke (item 1 of argv)', '-e', 'key code 36', '-e', 'end tell', '-e', 'end run', 'A"B\\C']);
  const calls = [];
  const fakeRun = (cmd, args, opts, cb) => {
    calls.push(args[args.length - 1]);
    const text = args[args.length - 1];
    // the first call finishes last: order must still follow the scans
    setTimeout(() => (text === 'BAD'
      ? cb(new Error('exit 1'), '', 'execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)')
      : cb(null, '', '')), text === 'ONE' ? 30 : 1);
  };
  const type = macTyper(fakeRun);
  const done = [];
  const jobs = ['ONE', 'BAD', 'TWO'].map((t) => type(t).then(() => done.push(t), (e) => done.push(t + ': ' + e.message)));
  await Promise.all(jobs);
  assert.deepEqual(calls, ['ONE', 'BAD', 'TWO']);
  assert.deepEqual(done, ['ONE', 'BAD: Mac chưa cấp quyền Trợ năng (Accessibility) cho Terminal', 'TWO']);
});

test('loadKey makes an 8-character key once and reuses it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-typer-'));
  try {
    const key = loadKey(dir);
    assert.match(key, /^[A-Z2-9]{8}$/);
    assert.equal(loadKey(dir), key);
    fs.writeFileSync(path.join(dir, 'key.txt'), 'bad');
    assert.notEqual(loadKey(dir), 'bad');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const OPENSSL = ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe'].find((bin) => {
  try { execFileSync(bin, ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
});

test('ensureCert makes an iPhone-acceptable certificate once, renews it for a new IP, serves real TLS', { skip: !OPENSSL && 'openssl not found' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-typer-'));
  const run = (cmd, args, opts) => execFileSync(OPENSSL, args, opts);
  try {
    const tls = ensureCert(dir, ['192.168.1.48'], run);
    const x509 = new crypto.X509Certificate(tls.cert);
    // iOS 13+ needs a Subject Alternative Name and the serverAuth usage, or "visit this website" does nothing.
    assert.equal(x509.subjectAltName, 'DNS:pc-typer, IP Address:192.168.1.48');
    assert.equal(x509.ca, false);
    assert.ok(new Date(x509.validTo) - Date.now() <= 398 * 864e5);
    const text = execFileSync(OPENSSL, ['x509', '-noout', '-text', '-in', path.join(dir, 'cert.pem')], { encoding: 'utf8' });
    assert.match(text, /TLS Web Server Authentication/);
    let reran = false;
    assert.deepEqual(ensureCert(dir, ['192.168.1.48'], () => { reran = true; }), tls, 'valid certificate is reused');
    assert.equal(reran, false);
    const moved = ensureCert(dir, ['192.168.1.48', '10.0.0.5'], run);
    assert.equal(new crypto.X509Certificate(moved.cert).subjectAltName, 'DNS:pc-typer, IP Address:192.168.1.48, IP Address:10.0.0.5',
      'a new LAN address gets a new certificate');
    const server = https.createServer(tls, createHandler({ key: KEY, name: 'TLS-MAC', type: () => Promise.resolve(), log() {} }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const body = await new Promise((resolve, reject) => {
        https.get({ host: '127.0.0.1', port: server.address().port, path: '/ping', headers: { 'X-Key': KEY }, rejectUnauthorized: false }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });
      assert.deepEqual(JSON.parse(body), { ok: true, name: 'TLS-MAC' });
    } finally { server.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

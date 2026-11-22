// pc-typer cho macOS: nhận mã quét ở tab "Quét QR" trên điện thoại (cùng Wi-Fi) và gõ mã đó vào chỗ con trỏ
// trên máy Mac này, rồi bấm Return để xuống dòng — giống súng barcode (Excel, Numbers, Google Sheet…).
// Cần Node.js (nodejs.org) và quyền Trợ năng (Accessibility) cho Terminal. Không dùng thư viện ngoài.
//
// Cùng giao thức với bản Windows (../windows/pc-typer.ps1), nên tab Quét QR dùng chung cho cả hai:
//   GET  /?key=<mã>   trang mở trên điện thoại: chấp nhận chứng chỉ rồi chuyển về app kèm địa chỉ + mã kết nối
//   GET  /ping        header X-Key → {"ok":true,"name":"<tên máy>"}
//   POST /type        header X-Key, thân text/plain = mã cần gõ → {"ok":true}
// Mã kết nối (8 ký tự) chỉ hiện trong cửa sổ Terminal: máy khác trong mạng không có mã thì không gõ được gì.
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PORT = 8443;
export const APP_ORIGIN = 'https://dtnam-oss.github.io';
export const APP_URL = 'https://dtnam-oss.github.io/ahamove/';
const MAX_TEXT = 200;
const MAX_BODY = 2048;
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bỏ I, O, 0, 1 cho dễ đọc
const HOST_RE = /^[A-Za-z0-9.-]+:\d{1,5}$/;
const PAGE = '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width">'
  + '<p style="font:18px sans-serif;padding:16px">pc-typer đang chạy. Mở đúng địa chỉ hiện trong cửa sổ pc-typer trên máy tính.</p>';

/** Printable text only (no control characters such as Return or Tab), 1..200 characters; null otherwise. */
export function cleanText(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return text && text.length <= MAX_TEXT ? text : null;
}

export function sameKey(given, key) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Request handler. type(text) types one line and resolves when done (rejects with a message for the phone).
 * Only the app origin gets CORS headers, so other web pages cannot call the PC from a browser.
 */
export function createHandler({ key, name, type, origin = APP_ORIGIN, appUrl = APP_URL, log = console.log }) {
  return (req, res) => {
    const cors = req.headers.origin === origin;
    const send = (code, body, headers = {}) => {
      const h = { 'Cache-Control': 'no-store', ...headers };
      if (cors) Object.assign(h, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
      res.writeHead(code, h);
      res.end(body);
    };
    const json = (code, obj) => send(code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
    const url = new URL(req.url, 'https://pc-typer');

    if (req.method === 'OPTIONS') {
      return send(204, '', cors ? {
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type, X-Key',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      } : {});
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const host = req.headers.host || '';
      if (sameKey(url.searchParams.get('key'), key) && HOST_RE.test(host)) {
        return send(302, '', { Location: appUrl + '#pc=' + encodeURIComponent(host) + '&key=' + key });
      }
      return send(200, PAGE, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (!sameKey(req.headers['x-key'], key)) return json(401, { error: 'Sai mã kết nối' });
    if (req.method === 'GET' && url.pathname === '/ping') return json(200, { ok: true, name });
    if (req.method === 'POST' && url.pathname === '/type') {
      const len = Number(req.headers['content-length']);
      if (!Number.isInteger(len) || len < 0 || len > MAX_BODY) { req.resume(); return json(400, { error: 'Mã quá dài' }); }
      const chunks = [];
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
      req.on('end', () => {
        const text = size <= MAX_BODY ? cleanText(Buffer.concat(chunks).toString('utf8')) : null;
        if (!text) return json(400, { error: 'Mã trống hoặc quá dài' });
        type(text).then(() => {
          log(new Date().toTimeString().slice(0, 8) + '  ' + text);
          json(200, { ok: true });
        }, (err) => json(500, { error: err.message }));
      });
      return undefined;
    }
    return json(404, { error: 'Không có' });
  };
}

/** osascript arguments: the text is passed as a run argument (no quoting into the script), then Return. */
export function typerArgs(text) {
  return ['-e', 'on run argv', '-e', 'tell application "System Events"', '-e', 'keystroke (item 1 of argv)',
    '-e', 'key code 36', '-e', 'end tell', '-e', 'end run', text];
}

/** Types through System Events, one line at a time so the codes keep their scan order. */
export function macTyper(run = execFile) {
  let chain = Promise.resolve();
  return (text) => {
    const job = chain.then(() => new Promise((resolve, reject) => {
      run('osascript', typerArgs(text), { timeout: 10000 }, (err, stdout, stderr) => {
        if (!err) return resolve();
        const why = String(stderr || err.message).trim();
        reject(new Error(/not allowed|1002|assistive/i.test(why)
          ? 'Mac chưa cấp quyền Trợ năng (Accessibility) cho Terminal'
          : 'Không gõ được: ' + why));
      });
    }));
    chain = job.catch(() => {});
    return job;
  };
}

export function stateDir() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'pc-typer');
}

/** The pairing key, made once and kept in the state folder. */
export function loadKey(dir) {
  const file = path.join(dir, 'key.txt');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (/^[A-Z2-9]{8}$/.test(saved)) return saved;
  } catch { /* first run */ }
  const key = Array.from(crypto.randomBytes(8), (b) => KEY_ALPHABET[b % 32]).join('');
  fs.writeFileSync(file, key + '\n', { mode: 0o600 });
  return key;
}

/** Self-signed HTTPS certificate (openssl ships with macOS), renewed when it ends within 7 days. */
export function ensureCert(dir, run = execFileSync) {
  const certFile = path.join(dir, 'cert.pem');
  const keyFile = path.join(dir, 'key.pem');
  try {
    const pem = fs.readFileSync(certFile);
    if (new Date(new crypto.X509Certificate(pem).validTo) - Date.now() > 7 * 864e5) {
      return { cert: pem, key: fs.readFileSync(keyFile) };
    }
  } catch { /* missing or unreadable: make a new one */ }
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '397', '-subj', '/CN=pc-typer',
    '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  fs.chmodSync(keyFile, 0o600);
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

/** IPv4 addresses the phone can reach (no loopback, no link-local). */
export function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => a.address);
}

function main() {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const key = loadKey(dir);
  const tls = ensureCert(dir);
  const name = os.hostname().replace(/\.local$/, '');
  const server = https.createServer(tls, createHandler({ key, name, type: macTyper() }));
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE'
      ? ` Cổng ${PORT} đang được dùng — có thể pc-typer đã chạy ở một cửa sổ khác.`
      : ' Lỗi: ' + err.message);
    process.exit(1);
  });
  server.listen(PORT, () => {
    console.log(`\n pc-typer đang chạy trên máy ${name}\n`);
    console.log(' 1. Trên điện thoại (cùng Wi-Fi với máy này), mở địa chỉ:');
    for (const ip of lanAddresses()) console.log(`      https://${ip}:${PORT}/?key=${key}`);
    console.log('    Lần đầu trình duyệt báo "Kết nối không riêng tư": bấm Nâng cao → Tiếp tục truy cập.');
    console.log('    Trang sẽ tự chuyển về app, tab "Quét QR".');
    console.log(' 2. Trên máy Mac, bấm vào ô Excel / Numbers / Google Sheet cần ghi.');
    console.log(' 3. Quét mã trên điện thoại: mã được gõ vào ô đó rồi xuống dòng.');
    console.log('\n Lần quét đầu macOS hỏi quyền điều khiển máy: cấp quyền Trợ năng (Accessibility) cho Terminal.');
    console.log(' Giữ cửa sổ này mở trong lúc quét. Đóng cửa sổ để dừng.\n');
  });
}

// Run only when started directly (node server.mjs), not when imported by the tests.
const self = fileURLToPath(import.meta.url);
let started = '';
try { started = fs.realpathSync(process.argv[1] || ''); } catch { /* not a file */ }
if (started && started === fs.realpathSync(self)) main();

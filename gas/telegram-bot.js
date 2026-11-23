// Telegram group bot (same bot + group as the Đồng kiểm notice, see telegram.js):
// - 13:00 and 19:00: backlog alert = orders of sheet back_log whose "Nhóm hạn" is "Đến hạn hôm nay" or "Quá hạn".
// - 23:00: reminder to update the picked-up orders, mentioning the two people in charge.
// - Commands in the group: /menu shows the Backlog | Kiểm kho buttons, /backlog and /kiemkho answer directly.
//   Kiểm kho = orders of raw_data grouped by trang_thai (orders without a state are left out).
//
// Setup (once, by the script owner, in the Apps Script editor): run caiDatTelegram. It grants the trigger
// permission, schedules the messages and points the bot's webhook at this web app.
//
// Exact times: each time-based trigger fires once (.at), and every run plans the next ones again, so the
// messages go out on the minute instead of somewhere in Google's daily hour window. A daily trigger
// (lapLichTelegram, 03:00) rebuilds the plan if a run ever failed to.

// The web app /exec URL (same as apiUrl in web/config.js): Telegram posts the group's updates here.
const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzLymx4Xid60ooLJUYW5C3dyUZi_uo1V6PsTXVEAC8vqk2Khd9a_B1yoATmVMRUgcY7/exec';

const BACKLOG_GROUP_COLUMN = 'Nhóm hạn';
const BACKLOG_STATUS_COLUMN = 'Status đơn';
const BACKLOG_ALERT_GROUPS = ['Đến hạn hôm nay', 'Quá hạn']; // message order
const UPDATE_REMINDER = 'Bố Kiên | Bố Quân cập nhật đơn hàng lấy @VanKien0902 @Quanle0605';

const TELEGRAM_SCHEDULE = [
  { handler: 'guiCanhBaoBacklog', hour: 13 },
  { handler: 'guiCanhBaoBacklog', hour: 19 },
  { handler: 'guiNhacCapNhatDon', hour: 23 },
];
const TELEGRAM_REPLAN_HOUR = 3;
const VN_OFFSET_MS = 7 * 3600e3; // Asia/Ho_Chi_Minh, no daylight saving

const TELEGRAM_COMMANDS = [
  { command: 'menu', description: 'Hiện nút Backlog | Kiểm kho' },
  { command: 'backlog', description: 'Đơn đến hạn hôm nay và quá hạn (back_log)' },
  { command: 'kiemkho', description: 'Đơn theo trạng thái (raw_data)' },
];
const TELEGRAM_MENU = {
  inline_keyboard: [[{ text: 'Backlog', callback_data: 'backlog' }, { text: 'Kiểm kho', callback_data: 'kiemkho' }]],
};

// ---------- Messages ----------

/**
 * "Title:" then its lines, per section; an empty section says "(không có)". Long lists are split under
 * Telegram's limit and a split section goes on with "Title (tiếp):". Lines are never cut.
 */
function sectionMessages_(sections) {
  const messages = [];
  let current = '';
  function add(line, title) {
    const next = current ? current + '\n' + line : line;
    if (next.length <= TELEGRAM_MAX_TEXT || !current) { current = next; return; }
    messages.push(current);
    current = (title ? title + ' (tiếp):\n' : '') + line;
  }
  sections.forEach(function (s) {
    add(s.title + ':', '');
    (s.lines.length ? s.lines : ['(không có)']).forEach(function (line) { add(line, s.title); });
  });
  if (current) messages.push(current);
  return messages;
}

/**
 * back_log orders per alert group ("Đến hạn hôm nay", "Quá hạn"), one line each:
 * "<code> - <days left, negative = overdue> - <Status đơn>" (an empty part is left out). A code is listed once.
 */
function backlogAlertMessages_() {
  const table = readTable_(SpreadsheetApp.openById(SHEET_ID), BACKLOG_SHEET,
    ['tracking_number', BACKLOG_GROUP_COLUMN, BACKLOG_DAYS_COLUMN, BACKLOG_STATUS_COLUMN]); // Code.js
  const lines = {};
  BACKLOG_ALERT_GROUPS.forEach(function (g) { lines[g] = []; });
  const seen = {};
  table.rows.forEach(function (r) {
    const code = String(r[table.col.tracking_number]).trim().toUpperCase();
    const group = String(r[table.col[BACKLOG_GROUP_COLUMN]]).trim();
    if (!code || seen[code] || !lines[group]) return;
    seen[code] = true;
    const days = String(r[table.col[BACKLOG_DAYS_COLUMN]]).trim();
    const status = String(r[table.col[BACKLOG_STATUS_COLUMN]]).trim();
    lines[group].push([code, days, status].filter(String).join(' - '));
  });
  return sectionMessages_(BACKLOG_ALERT_GROUPS.map(function (g) { return { title: g, lines: lines[g] }; }));
}

/** Codes of raw_data grouped by trang_thai (first row of a code wins), in the order the states appear. */
function kiemKhoStateMessages_() {
  const table = readTable_(SpreadsheetApp.openById(SHEET_ID), DATA_SHEET, ['tracking_number', 'trang_thai']); // Code.js
  const groups = [];
  const byState = {};
  const seen = {};
  table.rows.forEach(function (r) {
    const code = String(r[table.col.tracking_number]).trim().toUpperCase();
    if (!code || seen[code]) return;
    seen[code] = true;
    const state = String(r[table.col.trang_thai]).trim();
    if (!state) return;
    if (!byState[state]) { byState[state] = []; groups.push(state); }
    byState[state].push(code);
  });
  if (!groups.length) return ['Không có đơn nào có trạng thái trong raw_data.'];
  return sectionMessages_(groups.map(function (s) { return { title: s + ' (' + byState[s].length + ' đơn)', lines: byState[s] }; }));
}

/** Build the messages, sending an error notice instead when the sheet cannot be read. */
function sendBuilt_(build) {
  let messages;
  try {
    messages = build();
  } catch (err) {
    messages = ['Không đọc được dữ liệu: ' + String((err && err.message) || err)];
  }
  return sendTelegramAll_(messages); // telegram.js
}

// ---------- Scheduled messages (trigger handlers) ----------

function guiCanhBaoBacklog() {
  try { sendBuilt_(backlogAlertMessages_); } finally { lapLichTelegram(); }
}

function guiNhacCapNhatDon() {
  try { sendTelegram_(UPDATE_REMINDER); } finally { lapLichTelegram(); }
}

/** The next time `hour`:00 Vietnam time comes, at least a minute after `now` (Date). */
function nextVnTime_(hour, now) {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  let at = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), hour) - VN_OFFSET_MS;
  if (at <= now.getTime() + 60e3) at += 864e5;
  return new Date(at);
}

/** Replace the one-time triggers of the scheduled messages with the next run of each. */
function lapLichTelegram() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const handlers = {};
    TELEGRAM_SCHEDULE.forEach(function (s) { handlers[s.handler] = true; });
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (handlers[t.getHandlerFunction()]) ScriptApp.deleteTrigger(t);
    });
    const now = new Date();
    return TELEGRAM_SCHEDULE.map(function (s) {
      const at = nextVnTime_(s.hour, now);
      ScriptApp.newTrigger(s.handler).timeBased().at(at).create();
      return s.handler + ' ' + Utilities.formatDate(at, 'Asia/Ho_Chi_Minh', 'dd/MM/yyyy HH:mm');
    });
  } finally {
    lock.releaseLock();
  }
}

// ---------- Group commands and buttons (webhook) ----------

/** Secret part of the webhook URL, derived from the bot token: only Telegram knows it. */
function telegramWebhookSecret_() {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'webhook:' + telegramConfig_().token);
  return digest.slice(0, 16).map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

/** True when this POST is a Telegram update (its URL carries the webhook secret). */
function isTelegramUpdate_(e) {
  const conf = telegramConfig_();
  return Boolean(conf.token && e && e.parameter && e.parameter.tg && e.parameter.tg === telegramWebhookSecret_());
}

/**
 * Answer one update from the group. Only the configured group is served. Telegram re-sends an update it
 * thinks failed, so each update_id is handled once.
 */
function handleTelegramUpdate_(update) {
  const cache = CacheService.getScriptCache();
  const seenKey = 'tg-update-' + update.update_id;
  if (cache.get(seenKey)) return;
  cache.put(seenKey, '1', 21600);

  const chat = telegramConfig_().chat;
  const cb = update.callback_query;
  if (cb) {
    if (!cb.message || String(cb.message.chat.id) !== chat) return;
    telegramApi_('answerCallbackQuery', { callback_query_id: cb.id });
    runTelegramAction_(cb.data);
    return;
  }
  const msg = update.message;
  if (!msg || String(msg.chat.id) !== chat || typeof msg.text !== 'string') return;
  const m = msg.text.trim().match(/^\/(menu|backlog|kiemkho)(@\w+)?(\s|$)/i);
  if (m) runTelegramAction_(m[1].toLowerCase());
}

function runTelegramAction_(action) {
  if (action === 'menu') sendTelegram_('Chọn danh sách cần xem:', { reply_markup: TELEGRAM_MENU });
  else if (action === 'backlog') sendBuilt_(backlogAlertMessages_);
  else if (action === 'kiemkho') sendBuilt_(kiemKhoStateMessages_);
}

// ---------- Setup ----------

/**
 * Run once in the Apps Script editor (as the script owner): schedules the messages, adds the daily re-plan,
 * points the bot's webhook at this web app and lists the commands in the group. Safe to run again.
 */
function caiDatTelegram() {
  const conf = telegramConfig_();
  if (!conf.token || !conf.chat) throw new Error('Chưa đặt TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID trong config.js');

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'lapLichTelegram') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('lapLichTelegram').timeBased().atHour(TELEGRAM_REPLAN_HOUR).everyDays(1)
    .inTimezone('Asia/Ho_Chi_Minh').create();
  const plan = lapLichTelegram();

  const webhook = telegramApi_('setWebhook', {
    url: WEB_APP_URL + '?tg=' + telegramWebhookSecret_(),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  }).status;
  const commands = telegramApi_('setMyCommands', {
    commands: TELEGRAM_COMMANDS,
    scope: { type: 'chat', chat_id: conf.chat },
  }).status;

  const report = { lich: plan, webhook: webhook, lenh: commands };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

/** Run in the editor to see whether Telegram reaches the web app (last error, waiting updates). */
function kiemTraTelegram() {
  const info = telegramApi_('getWebhookInfo', {});
  const r = info.result || {};
  const report = {
    status: info.status,
    webhookDung: Boolean(r.url && r.url.indexOf(WEB_APP_URL + '?tg=') === 0),
    dangCho: r.pending_update_count,
    loiGanNhat: r.last_error_message || '',
    lich: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }),
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

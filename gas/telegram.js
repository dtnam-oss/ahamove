// Telegram notices sent by the bot in config.js (TELEGRAM_BOT_TOKEN) to one group (TELEGRAM_CHAT_ID).
// A notice never decides whether a save succeeded: callers report its status next to the saved result.

const TELEGRAM_MAX_TEXT = 4000; // Telegram rejects messages over 4096 characters

/** {token, chat} from config.js; empty strings when not set. */
function telegramConfig_() {
  return {
    token: typeof TELEGRAM_BOT_TOKEN === 'undefined' ? '' : String(TELEGRAM_BOT_TOKEN).trim(),
    chat: typeof TELEGRAM_CHAT_ID === 'undefined' ? '' : String(TELEGRAM_CHAT_ID).trim(),
  };
}

/**
 * Call one Bot API method. Returns {status, result}: status 'ok', 'off' when the bot is not configured, or
 * 'lỗi: <reason>'. The token is part of the request URL, so it is scrubbed from any error.
 */
function telegramApi_(method, payload) {
  const conf = telegramConfig_();
  if (!conf.token || !conf.chat) return { status: 'off' };
  try {
    const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + conf.token + '/' + method, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    let body = {};
    try { body = JSON.parse(res.getContentText()); } catch (e) { /* not JSON: reported by the HTTP code */ }
    if (res.getResponseCode() === 200 && body.ok) return { status: 'ok', result: body.result };
    return { status: 'lỗi: ' + (body.description || 'HTTP ' + res.getResponseCode()) };
  } catch (err) {
    return { status: 'lỗi: ' + String((err && err.message) || err).split(conf.token).join('***') };
  }
}

/**
 * Send plain text to the group (no Markdown, so order codes need no escaping; @username mentions still work).
 * `extra` adds sendMessage fields such as reply_markup. Returns 'ok', 'off' or 'lỗi: <reason>'.
 */
function sendTelegram_(text, extra) {
  const payload = { chat_id: telegramConfig_().chat, text: text, disable_web_page_preview: true };
  Object.keys(extra || {}).forEach(function (k) { payload[k] = extra[k]; });
  return telegramApi_('sendMessage', payload).status;
}

/**
 * Split a header + lines into messages under Telegram's size limit; later parts repeat the header with
 * "(tiếp)". Lines are never cut.
 */
function telegramMessages_(header, lines) {
  const messages = [];
  let current = header;
  lines.forEach(function (line) {
    if ((current + '\n' + line).length > TELEGRAM_MAX_TEXT) {
      messages.push(current);
      current = header + ' (tiếp)';
    }
    current += '\n' + line;
  });
  messages.push(current);
  return messages;
}

/** Send every message in order; returns 'ok', 'off' or the first error. */
function sendTelegramAll_(messages) {
  for (let i = 0; i < messages.length; i++) {
    const status = sendTelegram_(messages[i]);
    if (status !== 'ok') return status;
  }
  return 'ok';
}

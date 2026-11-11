// Client-side lookup logic. Plain script (global `Lookup`) so Node tests can load it in a VM (test/lookup.test.js).
// Lookup runs in the browser so each scan answers instantly, without a server round-trip.
var Lookup = (function () {
  /** Strip diacritics, lowercase, collapse spaces. Also absorbs tone-placement variants ("Hòa" vs "Hoà"). */
  function normalizeText(value) {
    return String(value == null ? '' : value)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeCode(value) {
    return String(value == null ? '' : value).trim().toUpperCase();
  }

  /** Order statuses (sheet `raw_data`, column `status`) that mean the order was cancelled. */
  var CANCELLED_STATUSES = ['NEED_RETURN_TO_PARTNER_ASAP'];

  function isCancelled(status) {
    return CANCELLED_STATUSES.indexOf(normalizeCode(status)) >= 0;
  }

  /** Build Maps from the server payload: code -> {district, status}, normalized district -> ten_vi_tri. */
  function buildIndex(payload) {
    var orders = new Map();
    Object.keys(payload.orders || {}).forEach(function (code) {
      orders.set(normalizeCode(code), payload.orders[code]);
    });
    var areas = new Map();
    (payload.config || []).forEach(function (row) {
      (row.khu_vuc || []).forEach(function (district) {
        var key = normalizeText(district);
        if (key && !areas.has(key)) areas.set(key, row.ten_vi_tri); // first config row wins
      });
    });
    var backlog = null;
    if (payload.backlog) {
      backlog = new Map();
      Object.keys(payload.backlog).forEach(function (code) {
        backlog.set(normalizeCode(code), payload.backlog[code]);
      });
    }
    return { orders: orders, areas: areas, backlog: backlog };
  }

  /** Exact match first; otherwise any alphanumeric token of the scan (QR may hold a URL/long string). */
  function findCode(raw, orders) {
    var code = normalizeCode(raw);
    if (!code) return null;
    if (orders.has(code)) return code;
    var tokens = code.match(/[A-Z0-9]+/g) || [];
    for (var i = 0; i < tokens.length; i++) {
      if (orders.has(tokens[i])) return tokens[i];
    }
    return null;
  }

  /**
   * status: 'empty' | 'not_found' | 'cancelled' | 'no_district' | 'unmapped' | 'ok', plus the sentence to speak.
   * Cancelled orders stop here; otherwise district -> location lookup as usual.
   */
  function resolveScan(raw, index) {
    if (!normalizeCode(raw)) return { status: 'empty', speech: '' };
    var code = findCode(raw, index.orders);
    if (!code) return { status: 'not_found', input: normalizeCode(raw), speech: 'Không tìm thấy đơn' };

    var order = index.orders.get(code) || {};
    if (isCancelled(order.status)) return { status: 'cancelled', code: code, speech: 'Đơn đã huỷ' };

    var district = String(order.district || '').trim();
    if (!district) return { status: 'no_district', code: code, speech: 'Đơn chưa có quận huyện' };

    var location = index.areas.get(normalizeText(district));
    if (!location) {
      return { status: 'unmapped', code: code, district: district, speech: 'Chưa có vị trí, ' + district };
    }
    return { status: 'ok', code: code, district: district, location: location, speech: location + ', ' + district };
  }

  /**
   * Backlog check (sheet back_log): speak the "days left" value + " ngày", e.g. "1 ngày", "-2 ngày".
   * status: 'empty' | 'unavailable' | 'not_found' | 'no_days' | 'overdue' (negative) | 'ok'.
   */
  function resolveBacklog(raw, index) {
    if (!normalizeCode(raw)) return { status: 'empty', speech: '' };
    if (!index.backlog) return { status: 'unavailable', speech: 'Chưa có dữ liệu backlog' };
    var code = findCode(raw, index.backlog);
    if (!code) return { status: 'not_found', input: normalizeCode(raw), speech: 'Không có trong backlog' };
    var days = String(index.backlog.get(code) == null ? '' : index.backlog.get(code)).trim();
    if (!days) return { status: 'no_days', code: code, speech: 'Chưa có số ngày còn lại' };
    var overdue = Number(days.replace(',', '.')) < 0;
    return { status: overdue ? 'overdue' : 'ok', code: code, days: days, speech: days + ' ngày' };
  }

  /** " c3 " -> "C3"; anything that is not a single A1 cell -> "". */
  function normalizeCell(value) {
    var cell = String(value == null ? '' : value).replace(/\s+/g, '').toUpperCase();
    return /^[A-Z]{1,3}[1-9]\d{0,6}$/.test(cell) ? cell : '';
  }

  /** "C3" -> "C4": the cell right below. */
  function nextCell(cell) {
    var m = /^([A-Z]+)(\d+)$/.exec(normalizeCell(cell));
    return m ? m[1] + (Number(m[2]) + 1) : '';
  }

  return {
    normalizeText: normalizeText,
    normalizeCode: normalizeCode,
    isCancelled: isCancelled,
    buildIndex: buildIndex,
    findCode: findCode,
    resolveScan: resolveScan,
    resolveBacklog: resolveBacklog,
    normalizeCell: normalizeCell,
    nextCell: nextCell,
  };
})();

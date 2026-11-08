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

  /** Order statuses (sheet `data`, column `status`) that mean the order was cancelled. */
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
    return { orders: orders, areas: areas };
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

  return {
    normalizeText: normalizeText,
    normalizeCode: normalizeCode,
    isCancelled: isCancelled,
    buildIndex: buildIndex,
    findCode: findCode,
    resolveScan: resolveScan,
  };
})();

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
    var routes = null; // ward key -> ten_tuyen
    var routeRows = []; // config_tuyen rows actually used (first row per ward)
    var routePoints = new Map(); // ten_tuyen -> ward points of that route, for the map
    var orderRoute = new Map(); // order code -> ten_tuyen of its ward
    if (payload.routes) {
      routes = new Map();
      payload.routes.forEach(function (row) {
        var key = wardKey(row.phuong_xa, row.quan_huyen);
        if (routes.has(key)) return; // first config row wins
        routes.set(key, row.ten_tuyen);
        routeRows.push(row);
        if (isFinite(row.lat) && isFinite(row.lng) && row.lat !== null && row.lng !== null) {
          if (!routePoints.has(row.ten_tuyen)) routePoints.set(row.ten_tuyen, []);
          routePoints.get(row.ten_tuyen).push({ phuong_xa: row.phuong_xa, lat: Number(row.lat), lng: Number(row.lng) });
        }
      });
      orders.forEach(function (order, code) {
        var route = routes.get(wardKey(order.ward, order.district));
        if (route) orderRoute.set(code, route);
      });
    }
    return {
      orders: orders, areas: areas, backlog: backlog,
      routes: routes, routeRows: routeRows, routePoints: routePoints, orderRoute: orderRoute,
    };
  }

  /** Ward + district identify a ward (the same ward name exists in several districts). */
  function wardKey(ward, district) {
    return normalizeText(ward) + '|' + normalizeText(district);
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

  /** "Tuyến 2" before "Tuyến 10": compare by the trailing number, then by text. */
  function compareRouteNames(a, b) {
    var na = Number((/(\d+)\s*$/.exec(a) || [])[1]);
    var nb = Number((/(\d+)\s*$/.exec(b) || [])[1]);
    if (isFinite(na) && isFinite(nb) && na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /**
   * Routes for the picker: [{name, total, districts: [{name, total, wards: [{name, total}]}]}].
   * Totals count today's orders in raw_data (cancelled ones excluded); wards keep config order.
   */
  function routeSummary(index) {
    if (!index.routes) return [];
    var counts = new Map(); // ward key -> active orders
    index.orders.forEach(function (order, code) {
      if (isCancelled(order.status) || !index.orderRoute.has(code)) return;
      var key = wardKey(order.ward, order.district);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    var byName = new Map();
    index.routeRows.forEach(function (row) {
      if (!byName.has(row.ten_tuyen)) byName.set(row.ten_tuyen, { name: row.ten_tuyen, total: 0, districts: new Map() });
      var route = byName.get(row.ten_tuyen);
      if (!route.districts.has(row.quan_huyen)) route.districts.set(row.quan_huyen, { name: row.quan_huyen, total: 0, wards: [] });
      var district = route.districts.get(row.quan_huyen);
      var n = counts.get(wardKey(row.phuong_xa, row.quan_huyen)) || 0;
      district.wards.push({ name: row.phuong_xa, total: n });
      district.total += n;
      route.total += n;
    });
    return Array.from(byName.values())
      .sort(function (a, b) { return compareRouteNames(a.name, b.name); })
      .map(function (r) { return { name: r.name, total: r.total, districts: Array.from(r.districts.values()) }; });
  }

  /**
   * "Chia tuyến" mode: like resolveScan, but speaks the order's route (sheet config_tuyen) instead of
   * the district's sorting location. status: 'empty' | 'unavailable' | 'not_found' | 'cancelled' |
   * 'no_ward' | 'unmapped' | 'ok'.
   */
  function resolveRouteSort(raw, index) {
    if (!normalizeCode(raw)) return { status: 'empty', speech: '' };
    if (!index.routes) return { status: 'unavailable', speech: 'Chưa có cấu hình tuyến' };
    var code = findCode(raw, index.orders);
    if (!code) return { status: 'not_found', input: normalizeCode(raw), speech: 'Không tìm thấy đơn' };
    var order = index.orders.get(code) || {};
    if (isCancelled(order.status)) return { status: 'cancelled', code: code, speech: 'Đơn đã huỷ' };
    var ward = String(order.ward || '').trim();
    var district = String(order.district || '').trim();
    if (!ward) return { status: 'no_ward', code: code, district: district, speech: 'Chưa rõ phường xã' };
    var route = index.orderRoute.get(code);
    if (!route) return { status: 'unmapped', code: code, ward: ward, district: district, speech: 'Chưa có tuyến' };
    return { status: 'ok', code: code, ward: ward, district: district, route: route, speech: route };
  }

  /** Codes of today's active (not cancelled) orders that belong to the given routes. */
  function routeOrderCodes(routeNames, index) {
    var codes = [];
    index.orderRoute.forEach(function (route, code) {
      if (routeNames.indexOf(route) >= 0 && !isCancelled((index.orders.get(code) || {}).status)) codes.push(code);
    });
    return codes;
  }

  /**
   * Loading check for the selected routes (scanned = {code: truthy} of orders already counted).
   * status: 'empty' | 'unavailable' | 'not_found' | 'cancelled' | 'other_route' | 'duplicate' | 'ok'.
   */
  function resolveRouteCheck(raw, index, selected, scanned) {
    if (!normalizeCode(raw)) return { status: 'empty', speech: '' };
    if (!index.routes) return { status: 'unavailable', speech: 'Chưa có cấu hình tuyến' };
    var code = findCode(raw, index.orders);
    if (!code) return { status: 'not_found', input: normalizeCode(raw), speech: 'Không tìm thấy đơn' };
    var order = index.orders.get(code) || {};
    if (isCancelled(order.status)) return { status: 'cancelled', code: code, speech: 'Đơn đã huỷ' };
    var route = index.orderRoute.get(code) || '';
    if (selected.indexOf(route) < 0) {
      return { status: 'other_route', code: code, route: route, speech: route ? 'Không, ' + route : 'Không, đơn chưa có tuyến' };
    }
    if (scanned[code]) return { status: 'duplicate', code: code, route: route, speech: 'Đã quét' };
    return { status: 'ok', code: code, route: route, ward: order.ward || '', district: order.district || '', speech: 'Có' };
  }

  /** "Chuyến đi" mode: orders in these statuses (raw_data, column status) cannot be loaded onto a trip. */
  var TRIP_REFUSED_STATUSES = ['NEED_RETURN_TO_PARTNER_EOD'];

  /** " 29c-123.45 " -> "29C-123.45"; "" when it is not a plausible plate (same rule as the server). */
  function normalizePlate(value) {
    var plate = String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toUpperCase();
    return /^[A-Z0-9][A-Z0-9 .-]{3,14}$/.test(plate) ? plate : '';
  }

  /**
   * "Chuyến đi" mode: may this scan join the trip being loaded? Decided on the device (no network call).
   * inTrip: {code: true} for this trip's orders; taken: Map code -> {ma_chuyen, bks} of trips saved today.
   * status: 'empty' | 'not_found' | 'refused' | 'duplicate' | 'taken' | 'ok'.
   */
  function resolveTripScan(raw, index, inTrip, taken) {
    if (!normalizeCode(raw)) return { status: 'empty', speech: '' };
    var code = findCode(raw, index.orders);
    if (!code) return { status: 'not_found', input: normalizeCode(raw), speech: 'Không tìm thấy đơn' };
    var orderStatus = String((index.orders.get(code) || {}).status || '').trim();
    if (TRIP_REFUSED_STATUSES.indexOf(normalizeCode(orderStatus)) >= 0) {
      return { status: 'refused', code: code, orderStatus: orderStatus, speech: 'Không, đơn trả đối tác' };
    }
    if (inTrip[code]) return { status: 'duplicate', code: code, speech: 'Đã quét' };
    var other = taken && taken.get(code);
    if (other) return { status: 'taken', code: code, trip: other, speech: 'Đã ở chuyến xe ' + other.bks };
    return { status: 'ok', code: code, speech: 'Có' };
  }

  /** Ward points of a route (for the map); [] when unknown. */
  function routeWardPoints(routeName, index) {
    return (index.routePoints && index.routePoints.get(routeName)) || [];
  }

  return {
    normalizeText: normalizeText,
    normalizeCode: normalizeCode,
    isCancelled: isCancelled,
    buildIndex: buildIndex,
    findCode: findCode,
    resolveScan: resolveScan,
    resolveBacklog: resolveBacklog,
    routeSummary: routeSummary,
    routeOrderCodes: routeOrderCodes,
    resolveRouteCheck: resolveRouteCheck,
    resolveRouteSort: resolveRouteSort,
    routeWardPoints: routeWardPoints,
    normalizePlate: normalizePlate,
    resolveTripScan: resolveTripScan,
  };
})();

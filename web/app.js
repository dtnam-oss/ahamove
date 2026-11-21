// Browser controller: data loading, barcode-gun input, camera scanning, spoken results,
// "Chuyến đi" mode (enter a truck plate, check each order loaded on the device, save the trip to sheet
// chuyen_di once it is finished, list/copy the trips of a day, end a trip after scanning back its FAILED orders)
// "Đồng kiểm" mode (receiving day + warehouse, scan the received orders, save them to sheet data_dong_kiem)
// "Backlog" mode (speak the days left to the deadline from sheet back_log)
// "Hàng hoàn" mode (speak the warehouse and the state of a returned order from sheet return)
// "Chia tuyến" mode (speak the order's route from sheet config_tuyen, like "Chia chọn" does for areas)
// and "Tuyến" mode (pick routes from sheet config_tuyen, then check each order loaded onto the truck).
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    gate: $('start-gate'),
    startBtn: $('start-btn'),
    reloadBtn: $('reload-btn'),
    status: $('data-status'),
    voiceWarning: $('voice-warning'),
    form: $('scan-form'),
    input: $('scan-input'),
    cameraBtn: $('camera-btn'),
    cameraBox: $('camera-box'),
    cameraClose: $('camera-close'),
    photoLabel: $('photo-label'),
    photoInput: $('photo-input'),
    result: $('result'),
    location: $('result-location'),
    district: $('result-district'),
    code: $('result-code'),
    modeBtns: document.querySelectorAll('.mode-btn'),
    tripHome: $('trip-home'),
    tripNew: $('trip-new'),
    tripPlateForm: $('trip-plate-form'),
    tripPlate: $('trip-plate'),
    tripPlateHint: $('trip-plate-hint'),
    tripPlateCancel: $('trip-plate-cancel'),
    tripDay: $('trip-day'),
    tripNote: $('trip-note'),
    tripFilter: $('trip-filter'),
    tripList: $('trip-list'),
    tripProgress: $('trip-progress'),
    tripPlateLabel: $('trip-plate-label'),
    tripCount: $('trip-count'),
    tripFinish: $('trip-finish'),
    tripCancel: $('trip-cancel'),
    checkProgress: $('check-progress'),
    checkLabel: $('check-label'),
    checkCount: $('check-count'),
    checkFinish: $('check-finish'),
    checkBack: $('check-back'),
    checkLists: $('check-lists'),
    checkMissingTitle: $('check-missing-title'),
    checkMissing: $('check-missing'),
    checkScannedTitle: $('check-scanned-title'),
    checkScanned: $('check-scanned'),
    dkSetup: $('dk-setup'),
    dkDay: $('dk-day'),
    dkDayLabel: $('dk-day-label'),
    dkSource: $('dk-source'),
    dkKhoLegend: $('dk-kho-legend'),
    dkHint: $('dk-hint'),
    dkProgress: $('dk-progress'),
    dkLabel: $('dk-label'),
    dkCount: $('dk-count'),
    dkFinish: $('dk-finish'),
    dkCancel: $('dk-cancel'),
    routePicker: $('route-picker'),
    routeList: $('route-list'),
    routeStart: $('route-start'),
    routeProgress: $('route-progress'),
    routeNames: $('route-names'),
    routeCount: $('route-count'),
    routeChange: $('route-change'),
    routeReset: $('route-reset'),
    mapBox: $('map-box'),
    mapNote: $('map-note'),
    map: $('order-map'),
  };

  var index = null;
  var scanner = null;
  var lastCamera = { text: '', at: 0 };
  var CAMERA_REPEAT_MS = 2500; // ignore the same code re-read by the live camera within this window

  // 'sort' = sorting location | 'routesort' = route | 'trip' = load/end a trip | 'dongkiem' = received orders
  // | 'trahang' = returned orders
  // | 'backlog' = days left | 'route' = route check | 'return' = returned order warehouse + state
  // | 'kiemkho' = stock-check session: order state + deadline result from raw_data, saved to sheet kiem_kho
  var mode = 'sort';
  var orderPoints = {}; // code -> located point, so re-scanning an order needs no server call

  // ---------- Speech ----------
  var viVoice = null;

  function pickVoice() {
    var voices = speechSynthesis.getVoices();
    viVoice = voices.find(function (v) { return (v.lang || '').toLowerCase().indexOf('vi') === 0; }) || null;
    els.voiceWarning.hidden = voices.length === 0 || Boolean(viVoice);
  }

  function speak(text) {
    if (!text) return;
    if (!('speechSynthesis' in window)) { beep(); return; }
    speechSynthesis.cancel(); // fast scanning: newest result interrupts the previous one
    var utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'vi-VN';
    if (viVoice) utter.voice = viVoice;
    utter.rate = 1.05;
    speechSynthesis.speak(utter);
  }

  function beep() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      osc.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch (e) { /* audio unavailable */ }
  }

  // ---------- Backend calls ----------
  function readJson(res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json().then(function (body) {
      if (body.error) throw new Error(body.error);
      return body;
    });
  }

  /** Simple GET (no custom headers) so the Apps Script redirect to googleusercontent passes CORS. */
  function apiGet(query) {
    return fetch(window.APP_CONFIG.apiUrl + query).then(readJson);
  }

  /** text/plain keeps the POST a CORS simple request (no preflight, which Apps Script cannot answer). */
  function apiPost(body) {
    return fetch(window.APP_CONFIG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    }).then(readJson);
  }

  function errorText(err) {
    return (err && err.message) || String(err);
  }

  // ---------- Data ----------
  /** Load raw_data and the configs; done(ok) runs afterwards. */
  function loadData(done) {
    var ok = false;
    els.status.textContent = 'Đang tải dữ liệu…';
    els.reloadBtn.disabled = true;
    apiGet('?action=data&t=' + Date.now())
      .then(function (body) {
        index = Lookup.buildIndex(body);
        ok = true;
        var time = new Date(body.updatedAt).toLocaleTimeString('vi-VN');
        var backlogInfo = body.backlog ? Object.keys(body.backlog).length + ' backlog' : 'backlog lỗi: ' + body.backlogError;
        var routeInfo = body.routes ? countRoutes(body.routes) + ' tuyến' : 'tuyến lỗi: ' + body.routesError;
        var returnInfo = body.returns ? Object.keys(body.returns).length + ' hàng hoàn' : 'hàng hoàn lỗi: ' + body.returnsError;
        var stockInfo = body.stockError ? ' · kiểm kho lỗi: ' + body.stockError : '';
        els.status.textContent = body.orderCount + ' đơn · ' + backlogInfo + ' · ' + routeInfo + ' · ' + returnInfo + stockInfo + ' · cập nhật ' + time;
        if (mode === 'route') showRouteScreen(); // totals follow the reloaded raw_data
        if (mode === 'trip' && !els.tripHome.hidden) loadTripList();
      })
      .catch(function (err) {
        var msg = errorText(err);
        els.status.textContent = 'Lỗi tải dữ liệu: ' + msg;
        showResult('error', 'Lỗi tải dữ liệu', msg);
        speak('Lỗi tải dữ liệu');
      })
      .then(function () {
        els.reloadBtn.disabled = false;
        if (done) done(ok);
      });
  }

  // ---------- Scan handling ----------
  function showResult(status, title, subtitle, code) {
    els.result.className = 'result result-' + status;
    els.location.textContent = title;
    els.district.textContent = subtitle || '';
    els.code.textContent = code || '';
  }

  function handleScan(raw) {
    if (isRoundMode(mode)) { handleDkScan(raw); return; } // checks the code format only, no data needed
    if (!index) { speak('Chưa tải dữ liệu'); return; }
    if (mode === 'trip') { if (check && !els.checkProgress.hidden) handleCheckScan(raw); else handleTripScan(raw); return; }
    if (mode === 'backlog') { handleBacklog(raw); return; }
    if (mode === 'return') { handleReturn(raw); return; }
    if (mode === 'route') { handleRouteScan(raw); return; }
    if (mode === 'routesort') { handleRouteSort(raw); return; }
    var r = Lookup.resolveScan(raw, index);
    if (r.status === 'empty') return;
    if (r.status === 'ok') showResult(r.status, r.location, r.district, r.code);
    else if (r.status === 'unmapped') showResult(r.status, 'Chưa có vị trí', r.district, r.code);
    else if (r.status === 'cancelled') showResult(r.status, 'Đơn đã huỷ', 'Không chia chọn — tách riêng', r.code);
    else if (r.status === 'no_district') showResult(r.status, 'Chưa có quận huyện', '', r.code);
    else showResult(r.status, 'Không tìm thấy đơn', '', r.input);
    speak(r.speech);
  }

  function setMode(next) {
    mode = next;
    Array.prototype.forEach.call(els.modeBtns, function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === mode));
    });
    leaveRouteScreens();
    leaveTripScreens();
    leaveDkScreens();
    if (mode === 'route') { if (index) showRouteScreen(); else showResult('idle', 'Chưa tải dữ liệu', ''); return; }
    if (mode === 'trip') { showTripScreen(); return; }
    if (isRoundMode(mode)) { showDkScreen(mode); return; }
    var hints = { backlog: 'Chế độ kiểm tra backlog', routesort: 'Chế độ chia đơn theo tuyến', 'return': 'Chế độ kiểm tra hàng hoàn' };
    showResult('idle', 'Sẵn sàng quét', hints[mode] || '');
    focusInput();
  }

  Array.prototype.forEach.call(els.modeBtns, function (b) {
    b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
  });

  function handleBacklog(raw) {
    var r = Lookup.resolveBacklog(raw, index);
    if (r.status === 'empty') return;
    if (r.status === 'ok') showResult(r.status, r.days + ' ngày', 'Còn hạn', r.code);
    else if (r.status === 'overdue') showResult(r.status, r.days + ' ngày', 'Quá hạn', r.code);
    else if (r.status === 'no_days') showResult(r.status, 'Chưa có số ngày', 'Cột "Còn lại (ngày)" đang trống', r.code);
    else if (r.status === 'unavailable') showResult(r.status, 'Chưa có dữ liệu backlog', els.status.textContent);
    else showResult(r.status, 'Không có trong backlog', '', r.input);
    speak(r.speech);
  }

  /** Hàng hoàn: the warehouse large, the state (trang_thai) under it. */
  function handleReturn(raw) {
    var r = Lookup.resolveReturn(raw, index);
    if (r.status === 'empty') return;
    if (r.status === 'ok') showResult(r.status, r.kho || 'Chưa có kho', r.trangThai || 'Chưa có trạng thái', r.code);
    else if (r.status === 'no_info') showResult('unmapped', 'Chưa có kho và trạng thái', 'Cột kho / trang_thai đang trống', r.code);
    else if (r.status === 'unavailable') showResult(r.status, 'Chưa có dữ liệu hàng hoàn', els.status.textContent);
    else showResult(r.status, 'Không có trong hàng hoàn', '', r.input);
    speak(r.speech);
  }

  function countRoutes(rows) {
    var names = {};
    rows.forEach(function (r) { names[r.ten_tuyen] = true; });
    return Object.keys(names).length;
  }

  function handleRouteSort(raw) {
    var r = Lookup.resolveRouteSort(raw, index);
    if (r.status === 'empty') return;
    if (r.status === 'ok') showResult(r.status, r.route, r.ward + ' · ' + r.district, r.code);
    else if (r.status === 'unmapped') showResult(r.status, 'Chưa có tuyến', r.ward + ' · ' + r.district, r.code);
    else if (r.status === 'no_ward') showResult(r.status, 'Chưa rõ phường/xã', r.district, r.code);
    else if (r.status === 'cancelled') showResult(r.status, 'Đơn đã huỷ', 'Không chia tuyến — tách riêng', r.code);
    else if (r.status === 'unavailable') showResult(r.status, 'Chưa có cấu hình tuyến', els.status.textContent);
    else showResult(r.status, 'Không tìm thấy đơn', '', r.input);
    speak(r.speech);
  }

  // ---------- Tuyến mode: pick routes, then check each order loaded onto the truck ----------
  // Progress lives in this browser only (one scanner per truck); it is dropped on a new day.
  var ROUTE_STATE_KEY = 'routeScan.v1';
  var routeState = loadRouteState();

  function today() {
    return new Date().toLocaleDateString('vi-VN');
  }

  function loadRouteState() {
    try {
      var saved = JSON.parse(localStorage.getItem(ROUTE_STATE_KEY) || 'null');
      if (saved && saved.day === today() && Array.isArray(saved.selected) && saved.scanned) return saved;
    } catch (e) { /* storage blocked or corrupt: start fresh */ }
    return { day: today(), selected: [], scanned: {}, active: false };
  }

  function saveRouteState() {
    try { localStorage.setItem(ROUTE_STATE_KEY, JSON.stringify(routeState)); } catch (e) { /* not persisted */ }
  }

  function showRouteScreen() {
    if (!index) return;
    if (routeState.active && routeState.selected.length) enterRouteScan(); else showRoutePicker();
  }

  function leaveRouteScreens() {
    els.routePicker.hidden = true;
    els.routeProgress.hidden = true;
    els.form.hidden = false;
    els.result.hidden = false;
    els.mapBox.hidden = true;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text; // sheet values are text, never HTML
    return node;
  }

  function showRoutePicker() {
    els.routePicker.hidden = false;
    els.routeProgress.hidden = true;
    els.form.hidden = true;
    els.result.hidden = true;
    els.mapBox.hidden = true;
    var summary = Lookup.routeSummary(index);
    els.routeList.textContent = '';
    if (!summary.length) els.routeList.appendChild(el('div', 'muted', 'Chưa có cấu hình tuyến (sheet config_tuyen).'));
    summary.forEach(function (route) {
      var item = el('div', 'route-item');
      var head = el('label', 'route-head');
      var box = el('input');
      box.type = 'checkbox';
      box.value = route.name;
      box.checked = routeState.selected.indexOf(route.name) >= 0;
      head.appendChild(box);
      head.appendChild(el('b', '', route.name));
      head.appendChild(el('span', 'muted', route.total + ' đơn'));
      item.appendChild(head);
      route.districts.forEach(function (d) {
        var details = el('details');
        details.appendChild(el('summary', '', d.name + ' · ' + d.total + ' đơn'));
        var list = el('ul');
        d.wards.forEach(function (w) { list.appendChild(el('li', '', w.name + ' · ' + w.total + ' đơn')); });
        details.appendChild(list);
        item.appendChild(details);
      });
      els.routeList.appendChild(item);
    });
    updateRouteStart();
  }

  function pickedRoutes() {
    return Array.prototype.filter.call(els.routeList.querySelectorAll('input[type=checkbox]'), function (b) { return b.checked; })
      .map(function (b) { return b.value; });
  }

  function updateRouteStart() {
    var picked = pickedRoutes();
    Array.prototype.forEach.call(els.routeList.querySelectorAll('input[type=checkbox]'), function (b) {
      b.closest('.route-item').classList.toggle('is-selected', b.checked);
    });
    var total = picked.length ? Lookup.routeOrderCodes(picked, index).length : 0;
    els.routeStart.disabled = !picked.length;
    els.routeStart.textContent = picked.length
      ? 'Bắt đầu quét · ' + picked.length + ' tuyến · ' + total + ' đơn'
      : 'Chọn tuyến để bắt đầu';
  }

  els.routeList.addEventListener('change', updateRouteStart);

  els.routeStart.addEventListener('click', function () {
    routeState.selected = pickedRoutes();
    routeState.active = true;
    saveRouteState();
    enterRouteScan();
  });

  els.routeChange.addEventListener('click', function () {
    routeState.active = false;
    saveRouteState();
    showRoutePicker();
  });

  els.routeReset.addEventListener('click', function () {
    if (!window.confirm('Xoá tiến độ quét của các tuyến đang chọn?')) return;
    Lookup.routeOrderCodes(routeState.selected, index).forEach(function (code) { delete routeState.scanned[code]; });
    saveRouteState();
    enterRouteScan();
  });

  function enterRouteScan() {
    els.routePicker.hidden = true;
    els.routeProgress.hidden = false;
    els.form.hidden = false;
    els.result.hidden = false;
    els.routeNames.textContent = routeState.selected.join(', ');
    updateRouteCount();
    showResult('idle', 'Sẵn sàng quét', 'Quét đơn để kiểm tra có thuộc tuyến không');
    drawRouteMap();
    focusInput();
  }

  /** Counter "done/total" of the selected routes; returns {done, total}. */
  function updateRouteCount() {
    var codes = Lookup.routeOrderCodes(routeState.selected, index);
    var done = codes.filter(function (c) { return routeState.scanned[c]; }).length;
    els.routeCount.textContent = done + '/' + codes.length;
    els.routeCount.classList.toggle('is-done', codes.length > 0 && done === codes.length);
    return { done: done, total: codes.length };
  }

  function scannedPins() {
    return Lookup.routeOrderCodes(routeState.selected, index)
      .map(function (code) { var p = routeState.scanned[code]; return p && p.lat != null ? { code: code, lat: p.lat, lng: p.lng } : null; })
      .filter(Boolean);
  }

  function drawRouteMap() {
    var key = window.APP_CONFIG.goongMaptilesKey;
    if (!key) { els.mapBox.hidden = true; return; }
    var wards = [];
    routeState.selected.forEach(function (name) { wards = wards.concat(Lookup.routeWardPoints(name, index)); });
    els.mapBox.hidden = false;
    els.mapNote.textContent = '🔵 ' + wards.length + ' phường/xã của tuyến · 🟢 đơn đã quét';
    OrderMap.show(els.map, key, { wards: wards, pins: scannedPins() }).catch(function (err) {
      els.mapNote.textContent = 'Không hiển thị được bản đồ: ' + ((err && err.message) || err);
    });
  }

  function handleRouteScan(raw) {
    if (els.routeProgress.hidden) return; // still on the route list
    var r = Lookup.resolveRouteCheck(raw, index, routeState.selected, routeState.scanned);
    if (r.status === 'empty') return;
    if (r.status === 'ok') {
      routeState.scanned[r.code] = true;
      saveRouteState();
      var c = updateRouteCount();
      var complete = c.done === c.total;
      showResult('ok', 'Có', c.done + '/' + c.total + ' · ' + r.route + ' · ' + r.ward, r.code);
      speak(complete ? 'Có, đủ đơn' : 'Có');
      pinOrder(r.code);
      return;
    }
    if (r.status === 'duplicate') showResult('unmapped', 'Đã quét', r.route, r.code);
    else if (r.status === 'other_route') showResult('not_found', 'Không', r.route ? 'Thuộc ' + r.route : 'Đơn chưa có tuyến', r.code);
    else if (r.status === 'cancelled') showResult('cancelled', 'Đơn đã huỷ', 'Không xuất — tách riêng', r.code);
    else if (r.status === 'unavailable') showResult('unavailable', 'Chưa có cấu hình tuyến', els.status.textContent);
    else showResult('not_found', 'Không tìm thấy đơn', '', r.input);
    speak(r.speech);
  }

  /** Put a scanned order on the map (its point is kept with the progress, so reloads need no call). */
  function pinOrder(code) {
    if (!window.APP_CONFIG.goongMaptilesKey) return;
    locate(code)
      .then(function (p) {
        if (!routeState.scanned[code]) return; // progress was reset meanwhile
        routeState.scanned[code] = { lat: p.lat, lng: p.lng };
        saveRouteState();
        OrderMap.addPin({ code: code, lat: p.lat, lng: p.lng });
      })
      .catch(function (err) {
        els.mapNote.textContent = 'Không định vị được đơn ' + code + ': ' + errorText(err);
      });
  }

  function locate(code) {
    if (orderPoints[code]) return Promise.resolve(orderPoints[code]);
    return apiGet('?action=locate&code=' + encodeURIComponent(code)).then(function (body) {
      orderPoints[code] = body;
      return body;
    });
  }

  // ---------- Chuyến đi mode: plate -> scan orders (checked on this device) -> save the trip once ----------
  // Scans never wait for the network: each order is checked against the loaded raw_data and today's trips.
  // The trip being loaded stays in this browser until it is saved, so a reload or a failed save loses nothing.
  var TRIP_DRAFT_KEY = 'tripDraft.v1';
  var tripDraft = null; // {plate, codes: [...]} of the trip being loaded, or null
  var tripIn = {}; // code -> true for tripDraft.codes (constant-time repeat check)
  var takenToday = new Map(); // code -> {ma_chuyen, bks} of trips not ended yet (any day, any device)
  var tripSaving = false;
  var tripListSeq = 0; // only the latest list request may render

  function setTripDraft(draft) {
    tripDraft = draft;
    tripIn = {};
    if (draft) draft.codes.forEach(function (c) { tripIn[c] = true; });
    try {
      if (draft) localStorage.setItem(TRIP_DRAFT_KEY, JSON.stringify(draft));
      else localStorage.removeItem(TRIP_DRAFT_KEY);
    } catch (e) { /* storage blocked: the trip still works until the page is closed */ }
  }

  function restoreTripDraft() {
    try {
      var saved = JSON.parse(localStorage.getItem(TRIP_DRAFT_KEY) || 'null');
      if (saved && saved.plate && Array.isArray(saved.codes)) setTripDraft(saved);
    } catch (e) { /* corrupt or blocked: start without a draft */ }
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** Value of <input type=date> for today on this device: "yyyy-mm-dd". */
  function todayInput() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** "2026-11-13" -> "13/11/2026" (the day format of sheet chuyen_di). */
  function inputToDay(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }

  /** Trips of a day (newest first); no day = today on the server. */
  function fetchTrips(day) {
    return apiGet('?action=trips' + (day ? '&day=' + encodeURIComponent(day) : '') + '&t=' + Date.now());
  }

  function setTaken(trips) {
    takenToday = new Map();
    trips.forEach(function (t) {
      t.codes.forEach(function (c) { takenToday.set(c, { ma_chuyen: t.ma_chuyen, bks: t.bks }); });
    });
  }

  function refreshTaken() {
    return apiGet('?action=opentrips&t=' + Date.now())
      .then(function (body) { setTaken(body.trips); }, function () { /* the server re-checks on save */ });
  }

  function leaveTripScreens() {
    els.tripHome.hidden = true;
    els.tripProgress.hidden = true;
    els.checkProgress.hidden = true;
    els.checkLists.hidden = true;
  }

  function showTripScreen() {
    if (tripDraft) enterTripScan();
    else if (check && check.active) enterCheck();
    else showTripHome();
  }

  function showTripHome(message) {
    els.tripHome.hidden = false;
    els.tripProgress.hidden = true;
    els.checkProgress.hidden = true;
    els.checkLists.hidden = true;
    els.form.hidden = true;
    els.result.hidden = true;
    els.tripPlateForm.hidden = true;
    els.tripNew.hidden = false;
    loadTripList(message);
  }

  function loadTripList(message) {
    if (!els.tripDay.value) els.tripDay.value = todayInput();
    var isToday = els.tripDay.value === todayInput();
    var seq = ++tripListSeq;
    els.tripNote.textContent = message || 'Đang tải danh sách chuyến…';
    fetchTrips(isToday ? '' : inputToDay(els.tripDay.value))
      .then(function (body) {
        if (seq !== tripListSeq) return;
        renderTrips(body.trips);
        var orders = body.trips.reduce(function (n, t) { return n + t.codes.length; }, 0);
        var failed = body.trips.reduce(function (n, t) { return n + tripFailed(t).length; }, 0);
        els.tripNote.textContent = message || body.trips.length + ' chuyến · ' + orders + ' đơn' +
          (failed ? ' · ' + failed + ' đơn FAILED cần xử lý' : '') + ' · ngày ' + body.day;
      })
      .catch(function (err) {
        if (seq === tripListSeq) els.tripNote.textContent = 'Lỗi tải danh sách chuyến: ' + errorText(err);
      });
  }

  /** "Đã kết thúc 17:20" (with the day when the trip ended on a later day) and the missing FAILED orders. */
  function tripState(trip) {
    if (!trip.ket_thuc) return 'Đang chạy';
    var sameDay = trip.ket_thuc.slice(0, 10) === trip.thoi_gian.slice(0, 10);
    var when = sameDay ? trip.ket_thuc.slice(11, 16) : trip.ket_thuc.slice(0, 5) + ' ' + trip.ket_thuc.slice(11, 16);
    return 'Đã kết thúc ' + when + (trip.missing.length ? ' · thiếu ' + trip.missing.length : '');
  }

  // Status tabs over the loaded day's trips: filtering is local, the chosen tab survives list reloads.
  var tripFilter = 'all';
  var dayTrips = [];
  var filterButtons = Array.prototype.slice.call(els.tripFilter.querySelectorAll('button'));
  filterButtons.forEach(function (button) {
    button.dataset.label = button.textContent;
    button.addEventListener('click', function () {
      tripFilter = button.dataset.filter;
      renderTrips(dayTrips);
    });
  });

  /** The tab counts and the trips of the chosen tab. */
  function renderTrips(trips) {
    dayTrips = trips;
    els.tripFilter.hidden = false;
    filterButtons.forEach(function (button) {
      var n = trips.filter(function (t) { return Lookup.tripMatchesFilter(t, button.dataset.filter); }).length;
      button.textContent = '';
      button.appendChild(document.createTextNode(button.dataset.label));
      button.appendChild(el('b', '', String(n)));
      button.setAttribute('aria-pressed', String(button.dataset.filter === tripFilter));
    });
    var shown = trips.filter(function (t) { return Lookup.tripMatchesFilter(t, tripFilter); });
    els.tripList.textContent = '';
    if (!trips.length) { els.tripList.appendChild(el('div', 'muted', 'Chưa có chuyến nào trong ngày này.')); return; }
    if (!shown.length) { els.tripList.appendChild(el('div', 'muted', 'Không có chuyến nào ở mục này.')); return; }
    var head = el('div', 'trip-row trip-head');
    ['Mã chuyến', 'BKS', 'Giờ tạo', 'Số đơn', 'Trạng thái', ''].forEach(function (t) { head.appendChild(el('span', '', t)); });
    els.tripList.appendChild(head);
    shown.forEach(function (trip) { els.tripList.appendChild(tripItem(trip)); });
  }

  /** FAILED orders of a running trip from the loaded raw_data ("Tải lại" refreshes them); none once ended. */
  function tripFailed(trip) {
    return !trip.ket_thuc && index ? Lookup.tripFailedCodes(trip.codes, index) : [];
  }

  /** One row per trip: a card on phones, a table row on wider screens (CSS); "Xem đơn" opens the codes. */
  function tripItem(trip) {
    var failed = tripFailed(trip);
    var item = el('div', 'trip-item' + (failed.length ? ' has-failed' : ''));
    var row = el('div', 'trip-row');
    row.appendChild(el('b', 'trip-id', trip.ma_chuyen));
    row.appendChild(el('span', 'trip-plate', trip.bks));
    row.appendChild(el('span', 'trip-time muted', trip.thoi_gian.slice(11, 16)));
    row.appendChild(el('span', 'trip-total', trip.codes.length + ' đơn'));
    var state = el('span', 'trip-state' + (trip.ket_thuc ? ' is-ended' : ''), tripState(trip));
    if (trip.missing.length) state.classList.add('has-missing');
    if (failed.length) state.appendChild(el('span', 'trip-failed', failed.length + ' FAILED'));
    row.appendChild(state);
    var actions = el('div', 'trip-actions');
    var toggle = el('button', 'btn trip-toggle', 'Xem đơn');
    toggle.type = 'button';
    actions.appendChild(toggle);
    if (!trip.ket_thuc) {
      var mine = check && check.ma_chuyen === trip.ma_chuyen;
      var end = el('button', 'btn btn-primary trip-end', mine ? 'Tiếp tục kiểm ' + checkProgressText() : 'Kết thúc');
      end.type = 'button';
      end.addEventListener('click', function () { startCheck(trip); });
      actions.appendChild(end);
    }
    row.appendChild(actions);
    item.appendChild(row);

    var detail = el('div', 'trip-detail');
    detail.hidden = true;
    if (failed.length) detail.appendChild(el('div', 'trip-failed-codes', 'Đơn FAILED: ' + failed.join(', ')));
    if (trip.missing.length) detail.appendChild(el('div', 'trip-missing', 'Thiếu khi bắn kiểm: ' + trip.missing.join(', ')));
    var codes = el('textarea', 'trip-codes');
    codes.readOnly = true;
    codes.value = trip.codes.join('\n'); // one order per line, ready to paste elsewhere
    codes.rows = Math.min(trip.codes.length, 10);
    codes.setAttribute('aria-label', 'Đơn của chuyến ' + trip.ma_chuyen);
    var copy = el('button', 'btn btn-primary', 'Copy ' + trip.codes.length + ' đơn');
    copy.type = 'button';
    copy.addEventListener('click', function () { copyCodes(codes, copy); });
    detail.appendChild(codes);
    detail.appendChild(copy);
    item.appendChild(detail);

    toggle.addEventListener('click', function () {
      detail.hidden = !detail.hidden;
      toggle.textContent = detail.hidden ? 'Xem đơn' : 'Ẩn đơn';
      item.classList.toggle('is-open', !detail.hidden);
    });
    return item;
  }

  function copyCodes(textarea, button) {
    var label = button.textContent;
    var flash = function (text) {
      button.textContent = text;
      setTimeout(function () { button.textContent = label; }, 2000);
    };
    var fallback = function () {
      textarea.focus();
      textarea.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* unsupported */ }
      flash(ok ? 'Đã copy' : 'Đã chọn, bấm giữ để copy');
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(textarea.value).then(function () { flash('Đã copy'); }, fallback);
    } else {
      fallback();
    }
  }

  els.tripDay.addEventListener('change', function () { loadTripList(); });

  els.tripNew.addEventListener('click', function () {
    els.tripNew.hidden = true;
    els.tripPlateForm.hidden = false;
    els.tripPlate.value = '';
    els.tripPlateHint.textContent = '';
    els.tripPlate.focus();
  });

  els.tripPlateCancel.addEventListener('click', function () {
    els.tripPlateForm.hidden = true;
    els.tripNew.hidden = false;
  });

  els.tripPlateForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var plate = Lookup.normalizePlate(els.tripPlate.value);
    if (!plate) {
      els.tripPlateHint.textContent = 'Biển kiểm soát không hợp lệ (4–15 ký tự: chữ, số, dấu - . và khoảng trắng)';
      els.tripPlate.focus();
      return;
    }
    setTripDraft({ plate: plate, codes: [] });
    enterTripScan();
  });

  function enterTripScan() {
    els.tripHome.hidden = true;
    els.tripProgress.hidden = false;
    els.form.hidden = false;
    els.result.hidden = false;
    els.tripPlateLabel.textContent = 'Chuyến xe ' + tripDraft.plate;
    updateTripCount();
    showResult('idle', 'Sẵn sàng quét', 'Quét đơn xếp lên xe ' + tripDraft.plate);
    refreshTaken();
    focusInput();
  }

  function updateTripCount() {
    els.tripCount.textContent = tripDraft.codes.length + ' đơn';
    els.tripFinish.disabled = tripSaving || !tripDraft.codes.length;
  }

  function handleTripScan(raw) {
    if (!tripDraft || els.tripProgress.hidden) return; // plate not entered yet
    var r = Lookup.resolveTripScan(raw, index, tripIn, takenToday);
    if (r.status === 'empty') return;
    if (r.status === 'ok') {
      tripDraft.codes.push(r.code);
      setTripDraft(tripDraft);
      updateTripCount();
      showResult('ok', 'Có', tripDraft.codes.length + ' đơn · xe ' + tripDraft.plate, r.code);
    } else if (r.status === 'duplicate') showResult('unmapped', 'Đã quét', 'Đơn đã có trong chuyến này', r.code);
    else if (r.status === 'refused') showResult('not_found', 'Không hợp lệ', 'Trạng thái ' + r.orderStatus, r.code);
    else if (r.status === 'taken') showResult('not_found', 'Đã ở chuyến khác', r.trip.ma_chuyen + ' · xe ' + r.trip.bks, r.code);
    else showResult('not_found', 'Không tìm thấy đơn', 'Không có trong raw_data', r.input);
    speak(r.speech);
  }

  els.tripFinish.addEventListener('click', function () {
    if (!tripDraft || !tripDraft.codes.length || tripSaving) return;
    if (!window.confirm('Kết thúc chuyến xe ' + tripDraft.plate + ' với ' + tripDraft.codes.length + ' đơn?')) return;
    var draft = tripDraft;
    tripSaving = true;
    updateTripCount();
    showResult('pending', 'Đang lưu chuyến…', draft.codes.length + ' đơn · xe ' + draft.plate);
    apiPost({ action: 'trip', plate: draft.plate, codes: draft.codes })
      .then(function (body) {
        if (body.conflicts) {
          // Another device saved some of these orders first: drop them and let the user finish again.
          body.conflicts.forEach(function (c) { takenToday.set(c.code, { ma_chuyen: c.ma_chuyen, bks: c.bks }); });
          draft.codes = draft.codes.filter(function (c) { return !takenToday.has(c); });
          setTripDraft(draft);
          var where = body.conflicts.map(function (c) { return c.code + ' (' + c.ma_chuyen + ')'; }).join(', ');
          showResult('unmapped', 'Đã bỏ ' + body.conflicts.length + ' đơn', 'Đã ở chuyến khác: ' + where + '. Bấm Kết thúc lại để lưu.');
          speak('Có đơn đã ở chuyến khác');
          return;
        }
        body.codes.forEach(function (c) { takenToday.set(c, { ma_chuyen: body.ma_chuyen, bks: body.bks }); });
        setTripDraft(null);
        els.tripDay.value = todayInput();
        showTripHome('Đã tạo chuyến ' + body.ma_chuyen + ' · xe ' + body.bks + ' · ' + body.codes.length + ' đơn');
        speak('Đã tạo chuyến');
      })
      .catch(function (err) {
        showResult('error', 'Lưu chuyến thất bại', errorText(err) + ' — chuyến vẫn giữ trên máy, bấm Kết thúc để thử lại');
        speak('Lưu chuyến thất bại');
      })
      .then(function () {
        tripSaving = false;
        if (tripDraft) updateTripCount();
      });
  });

  els.tripCancel.addEventListener('click', function () {
    if (tripSaving) return;
    if (!window.confirm('Huỷ chuyến xe ' + tripDraft.plate + '? ' + tripDraft.codes.length + ' đơn đã quét sẽ bị xoá khỏi máy.')) return;
    setTripDraft(null);
    showTripHome();
  });

  // ---------- Ending a trip: scan back its FAILED orders ("bắn kiểm"), then mark it ended ----------
  // FAILED orders are taken from raw_data reloaded when the check starts; progress stays on this device.
  var CHECK_KEY = 'tripCheck.v1';
  var check = null; // {ma_chuyen, bks, codes, failed: [...], checked: {code: true}, active} or null
  var checkSets = { failed: {}, inTrip: {} };
  var checkSaving = false;

  function toSet(list) {
    var set = {};
    list.forEach(function (c) { set[c] = true; });
    return set;
  }

  function setCheck(next) {
    check = next;
    checkSets = next ? { failed: toSet(next.failed), inTrip: toSet(next.codes) } : { failed: {}, inTrip: {} };
    try {
      if (next) localStorage.setItem(CHECK_KEY, JSON.stringify(next));
      else localStorage.removeItem(CHECK_KEY);
    } catch (e) { /* storage blocked: the check still works until the page is closed */ }
  }

  function restoreCheck() {
    try {
      var saved = JSON.parse(localStorage.getItem(CHECK_KEY) || 'null');
      if (saved && saved.ma_chuyen && Array.isArray(saved.failed) && Array.isArray(saved.codes) && saved.checked) setCheck(saved);
    } catch (e) { /* corrupt or blocked: no check in progress */ }
  }

  function checkCounts() {
    var done = check.failed.filter(function (c) { return check.checked[c]; }).length;
    return { done: done, total: check.failed.length };
  }

  /** The FAILED orders still missing and already scanned back, shown under the result while checking. */
  function renderCheckLists() {
    var lists = Lookup.tripCheckLists(check.failed, check.checked);
    els.checkLists.hidden = !check.failed.length || els.checkProgress.hidden; // only on the check screen
    var fill = function (box, title, label, codes, empty) {
      title.textContent = label + ' (' + codes.length + ')';
      box.textContent = '';
      if (!codes.length) { box.appendChild(el('span', 'muted', empty)); return; }
      codes.forEach(function (code) { box.appendChild(el('span', '', code)); });
    };
    fill(els.checkMissing, els.checkMissingTitle, 'Còn thiếu', lists.missing, 'Đã quét đủ');
    fill(els.checkScanned, els.checkScannedTitle, 'Đã quét', lists.scanned, 'Chưa quét đơn nào');
  }

  function checkProgressText() {
    var c = checkCounts();
    return c.done + '/' + c.total;
  }

  function startCheck(trip) {
    if (check && check.ma_chuyen === trip.ma_chuyen) {
      check.active = true;
      setCheck(check);
      enterCheck();
      return;
    }
    if (check && checkCounts().done && !window.confirm('Đang bắn kiểm dở chuyến ' + check.ma_chuyen + ' (' + checkProgressText() + '). Bỏ để kiểm chuyến ' + trip.ma_chuyen + '?')) return;
    els.tripNote.textContent = 'Đang lấy trạng thái mới nhất của đơn trong raw_data…';
    loadData(function (ok) {
      if (!ok) { els.tripNote.textContent = 'Không lấy được trạng thái đơn — thử lại'; return; }
      setCheck({
        ma_chuyen: trip.ma_chuyen,
        bks: trip.bks,
        codes: trip.codes.slice(),
        failed: Lookup.tripFailedCodes(trip.codes, index),
        checked: {},
        active: true,
      });
      enterCheck();
    });
  }

  function enterCheck() {
    els.tripHome.hidden = true;
    els.tripProgress.hidden = true;
    els.checkProgress.hidden = false;
    els.form.hidden = false;
    els.result.hidden = false;
    els.checkLabel.textContent = 'Bắn kiểm ' + check.ma_chuyen + ' · xe ' + check.bks;
    updateCheckCount();
    showResult('idle', check.failed.length ? 'Quét đơn FAILED' : 'Không có đơn FAILED',
      check.failed.length + ' đơn FAILED / ' + check.codes.length + ' đơn của chuyến' + (check.failed.length ? '' : ' — bấm Kết thúc chuyến'));
    focusInput();
  }

  function updateCheckCount() {
    var c = checkCounts();
    els.checkCount.textContent = c.done + '/' + c.total;
    els.checkCount.classList.toggle('is-done', c.done === c.total);
    els.checkFinish.disabled = checkSaving;
    renderCheckLists();
    return c;
  }

  function handleCheckScan(raw) {
    var r = Lookup.resolveTripCheck(raw, index, checkSets.failed, check.checked, checkSets.inTrip);
    if (r.status === 'empty') return;
    if (r.status === 'ok') {
      check.checked[r.code] = true;
      setCheck(check);
      var c = updateCheckCount();
      showResult('ok', 'Có', c.done + '/' + c.total + ' đơn FAILED · ' + check.ma_chuyen, r.code);
      speak(c.done === c.total ? 'Có, đủ đơn' : 'Có');
      return;
    }
    if (r.status === 'duplicate') showResult('unmapped', 'Đã quét', 'Đơn FAILED đã được kiểm', r.code);
    else if (r.status === 'not_failed') showResult('unmapped', 'Không cần kiểm', 'Đơn của chuyến, trạng thái ' + (r.orderStatus || 'không rõ'), r.code);
    else showResult('not_found', 'Không thuộc chuyến', check.ma_chuyen + ' · xe ' + check.bks, r.code);
    speak(r.speech);
  }

  els.checkBack.addEventListener('click', function () {
    check.active = false; // progress kept: the trip row offers "Tiếp tục kiểm"
    setCheck(check);
    showTripHome();
  });

  els.checkFinish.addEventListener('click', function () {
    if (!check || checkSaving) return;
    var c = checkCounts();
    var missing = c.total - c.done;
    var question = missing
      ? 'Còn thiếu ' + missing + ' đơn FAILED chưa quét. Vẫn kết thúc chuyến ' + check.ma_chuyen + '?'
      : 'Kết thúc chuyến ' + check.ma_chuyen + ' (xe ' + check.bks + ')?';
    if (!window.confirm(question)) return;
    var ending = check;
    checkSaving = true;
    updateCheckCount();
    showResult('pending', 'Đang kết thúc chuyến…', ending.ma_chuyen + ' · xe ' + ending.bks);
    apiPost({
      action: 'endTrip',
      ma_chuyen: ending.ma_chuyen,
      failed: ending.failed,
      checked: ending.failed.filter(function (code) { return ending.checked[code]; }),
    })
      .then(function (body) {
        // Its orders are off the truck now: they may join the next trips.
        ending.codes.forEach(function (code) {
          var t = takenToday.get(code);
          if (t && t.ma_chuyen === ending.ma_chuyen) takenToday.delete(code);
        });
        setCheck(null);
        showTripHome('Đã kết thúc chuyến ' + body.ma_chuyen + (body.missing.length ? ' · thiếu ' + body.missing.length + ' đơn FAILED' : ''));
        speak('Đã kết thúc chuyến');
      })
      .catch(function (err) {
        showResult('error', 'Kết thúc chuyến thất bại', errorText(err));
        speak('Kết thúc thất bại');
      })
      .then(function () {
        checkSaving = false;
        if (check) updateCheckCount();
      });
  });

  // ---------- Đồng kiểm / Trả hàng / Kiểm kho modes: day (+ warehouse), scan, save the round once ----------
  // The modes share one screen; each keeps its own round on the device. Kiểm kho has no warehouse.
  var ROUND_KINDS = {
    dongkiem: { title: 'Đồng kiểm', key: 'dongKiem.v1', sheet: 'data_dong_kiem', dayLabel: 'Ngày nhận đơn', khoLabel: 'Kho nhận', dayWord: 'nhận' },
    trahang: { title: 'Trả hàng', key: 'traHang.v1', sheet: 'tra_hang', dayLabel: 'Ngày trả', khoLabel: 'Kho trả', dayWord: 'trả' },
    kiemkho: { title: 'Kiểm kho', key: 'kiemKho.v1', sheet: 'kiem_kho', dayLabel: 'Ngày kiểm kho', khoLabel: '', dayWord: 'kiểm', noKho: true },
  };
  var rounds = { dongkiem: null, trahang: null, kiemkho: null }; // per mode: {ngay: 'dd/MM/yyyy', kho, codes: [...]} or null
  var dkKind = 'dongkiem'; // mode whose round the shared screen shows
  var dk = null; // rounds[dkKind]
  var dkIn = {};
  var dkSaving = false;
  // Đồng kiểm checks scans against the pending pick-up list (code -> warehouse), reloaded each time the tab opens.
  var pending = null;
  var pendingLoad = 0; // id of the latest load, so a slow older answer cannot overwrite a newer one

  function isRoundMode(m) { return Object.prototype.hasOwnProperty.call(ROUND_KINDS, m); }

  function useKind(kind) {
    dkKind = kind;
    dk = rounds[kind];
    dkIn = dk ? toSet(dk.codes) : {};
  }

  function setDk(next) {
    rounds[dkKind] = next;
    useKind(dkKind);
    try {
      if (next) localStorage.setItem(ROUND_KINDS[dkKind].key, JSON.stringify(next));
      else localStorage.removeItem(ROUND_KINDS[dkKind].key);
    } catch (e) { /* storage blocked: the round still works until the page is closed */ }
  }

  function restoreDk() {
    Object.keys(ROUND_KINDS).forEach(function (kind) {
      try {
        var saved = JSON.parse(localStorage.getItem(ROUND_KINDS[kind].key) || 'null');
        if (saved && saved.ngay && (saved.kho || ROUND_KINDS[kind].noKho) && Array.isArray(saved.codes)) rounds[kind] = saved;
      } catch (e) { /* corrupt or blocked: no round in progress */ }
    });
  }

  function leaveDkScreens() {
    els.dkSetup.hidden = true;
    els.dkProgress.hidden = true;
    els.dkSource.hidden = true;
  }

  function showDkScreen(kind) {
    useKind(kind);
    var k = ROUND_KINDS[kind];
    els.dkDayLabel.textContent = k.dayLabel;
    els.dkKhoLegend.textContent = k.khoLabel;
    els.dkKhoLegend.parentNode.hidden = Boolean(k.noKho); // the warehouse fieldset
    els.dkSource.hidden = kind !== 'dongkiem';
    if (kind === 'dongkiem') loadPending();
    if (dk) enterDkScan(); else showDkSetup();
  }

  /** Load sheet export_raw_pending_pu (only code + pick-up warehouse). */
  function loadPending() {
    var id = ++pendingLoad;
    els.dkSource.textContent = 'Đang tải danh sách chờ lấy (export_raw_pending_pu)…';
    apiGet('?action=pendingpu&t=' + Date.now())
      .then(function (body) {
        if (id !== pendingLoad) return;
        pending = body.orders || {};
        els.dkSource.textContent = 'Danh sách chờ lấy: ' + body.count + ' đơn · cập nhật ' +
          new Date(body.updatedAt).toLocaleTimeString('vi-VN');
      })
      .catch(function (err) {
        if (id !== pendingLoad) return;
        els.dkSource.textContent = 'Lỗi tải danh sách chờ lấy: ' + errorText(err) +
          (pending ? ' — đang dùng danh sách tải trước đó' : ' — mở lại tab Đồng kiểm để thử lại');
      })
      .then(function () {
        if (id === pendingLoad && dkKind === 'dongkiem' && dk && !els.dkProgress.hidden) updateDkCount();
      });
  }

  function showDkSetup(message) {
    els.dkSetup.hidden = false;
    els.dkProgress.hidden = true;
    els.form.hidden = true;
    els.result.hidden = true;
    if (!els.dkDay.value) els.dkDay.value = todayInput();
    els.dkHint.textContent = message || '';
  }

  els.dkSetup.addEventListener('change', function () { els.dkHint.textContent = ''; });

  els.dkSetup.addEventListener('submit', function (e) {
    e.preventDefault();
    var k = ROUND_KINDS[dkKind];
    var day = inputToDay(els.dkDay.value);
    var kho = els.dkSetup.querySelector('input[name=dk-kho]:checked');
    if (!day) { els.dkHint.textContent = 'Chọn ' + k.dayLabel.toLowerCase(); return; }
    if (!kho && !k.noKho) { els.dkHint.textContent = 'Chọn ' + k.khoLabel.toLowerCase(); return; }
    setDk({ ngay: day, kho: k.noKho ? '' : kho.value, codes: [] });
    enterDkScan();
  });

  function enterDkScan() {
    var k = ROUND_KINDS[dkKind];
    els.dkSetup.hidden = true;
    els.dkProgress.hidden = false;
    els.form.hidden = false;
    els.result.hidden = false;
    els.dkLabel.textContent = k.title + khoText(dk) + ' · ' + k.dayWord + ' ' + dk.ngay;
    updateDkCount();
    showResult('idle', 'Sẵn sàng quét', k.title + khoText(dk));
    focusInput();
  }

  /** " · kho X" for a round with a warehouse, '' for Kiểm kho. */
  function khoText(round) { return round.kho ? ' · kho ' + round.kho : ''; }

  /** "x/total đơn" for Đồng kiểm once the pending list is loaded, otherwise "x đơn". */
  function dkCountText() {
    if (dkKind === 'dongkiem' && pending) return dk.codes.length + '/' + Lookup.pendingTotal(pending, dk.kho, dk.codes) + ' đơn';
    return dk.codes.length + ' đơn';
  }

  function updateDkCount() {
    els.dkCount.textContent = dkCountText();
    els.dkFinish.disabled = dkSaving || !dk.codes.length;
  }

  function handleDkScan(raw) {
    if (!dk || els.dkProgress.hidden) return; // day and warehouse not chosen yet
    if (dkKind === 'kiemkho') { handleStockScan(raw); return; }
    var r;
    if (dkKind === 'dongkiem') {
      if (!pending) {
        if (!Lookup.normalizeCode(raw)) return;
        showResult('error', 'Chưa tải danh sách', els.dkSource.textContent);
        speak('Chưa tải danh sách');
        return;
      }
      r = Lookup.resolveDongKiemPending(raw, pending, dk.kho, dkIn);
    } else {
      r = Lookup.resolveDongKiemScan(raw, dkIn); // Trả hàng: code format only
    }
    if (r.status === 'empty') return;
    if (r.status === 'ok') {
      dk.codes.push(r.code);
      setDk(dk);
      updateDkCount();
      showResult('ok', 'Có', dkCountText() + ' · kho ' + dk.kho, r.code);
    } else if (r.status === 'duplicate') showResult('unmapped', 'Đã quét', 'Đơn đã có trong lượt này', r.code);
    else if (r.status === 'wrong_kho') showResult('not_found', 'Không', 'Đơn của kho ' + r.kho, r.code);
    else if (r.status === 'not_found') showResult('not_found', 'Không', 'Không có trong danh sách chờ lấy', r.input);
    else showResult('not_found', 'Không', 'Mã không hợp lệ (cần 8 ký tự chữ/số liền nhau)', r.input);
    speak(r.speech);
  }

  /**
   * Kiểm kho scan: the state (trang_thai) large, the deadline result (ket_qua) under it, "Quá hạn" in red.
   * Every real waybill code joins the session, also one missing from raw_data (the sheet records it as such).
   */
  function handleStockScan(raw) {
    if (!index) { if (Lookup.normalizeCode(raw)) speak('Chưa tải dữ liệu'); return; }
    var r = Lookup.resolveStockRound(raw, index, dkIn);
    if (r.status === 'empty') return;
    if (r.status === 'unavailable') { showResult(r.status, 'Chưa có dữ liệu kiểm kho', index.stockError); speak(r.speech); return; }
    if (r.status === 'invalid') { showResult('not_found', 'Mã không hợp lệ', 'Cần 8 ký tự chữ/số liền nhau — không thêm vào phiên', r.input); speak(r.speech); return; }
    if (r.status === 'duplicate') { showResult('unmapped', 'Đã quét', 'Đơn đã có trong phiên này', r.code); speak(r.speech); return; }
    dk.codes.push(r.code);
    setDk(dk);
    updateDkCount();
    var count = ' · ' + dkCountText();
    if (r.status === 'not_found') showResult('not_found', 'Không tìm thấy đơn', 'Không có trong raw_data' + count, r.code);
    else if (r.status === 'no_info') showResult('unmapped', 'Chưa có trạng thái và kết quả', 'Cột trang_thai / ket_qua đang trống' + count, r.code);
    else showResult(r.status, r.trangThai || 'Chưa có trạng thái', (r.ketQua || 'Chưa có kết quả') + count, r.code);
    speak(r.speech);
  }

  els.dkFinish.addEventListener('click', function () {
    if (!dk || !dk.codes.length || dkSaving) return;
    var kind = dkKind;
    var k = ROUND_KINDS[kind];
    if (!window.confirm('Kết thúc ' + k.title.toLowerCase() + ': ' + dk.codes.length + ' đơn' + khoText(dk) + ' · ngày ' + k.dayWord + ' ' + dk.ngay + '?')) return;
    var round = dk;
    dkSaving = true;
    updateDkCount();
    showResult('pending', 'Đang ghi…', round.codes.length + ' đơn' + khoText(round));
    apiPost({ action: kind, ngay: round.ngay, kho: round.kho, codes: round.codes })
      .then(function (body) {
        var shown = dkKind === kind && isRoundMode(mode);
        var was = dkKind;
        useKind(kind);
        setDk(null);
        useKind(was);
        var text = 'Đã ghi ' + body.count + ' đơn vào ' + k.sheet + khoText(round) + ' · ngày ' + k.dayWord + ' ' + round.ngay;
        // Đồng kiểm: the server also posts the list to the Telegram group ('ok' | 'off' | 'lỗi: …').
        if (body.telegram === 'ok') text += ' · đã gửi Telegram';
        else if (body.telegram && body.telegram !== 'off') text += ' · Telegram ' + body.telegram;
        if (shown) showDkSetup(text);
        speak('Đã ghi ' + body.count + ' đơn');
      })
      .catch(function (err) {
        if (dkKind === kind && isRoundMode(mode)) {
          showResult('error', 'Ghi thất bại', errorText(err) + ' — lượt quét vẫn giữ trên máy, bấm Kết thúc để thử lại');
        }
        speak('Ghi thất bại');
      })
      .then(function () {
        dkSaving = false;
        if (dk) updateDkCount();
      });
  });

  els.dkCancel.addEventListener('click', function () {
    if (dkSaving || !dk) return;
    var k = ROUND_KINDS[dkKind];
    if (!window.confirm('Huỷ lượt ' + k.title.toLowerCase() + '? ' + dk.codes.length + ' đơn đã quét sẽ bị xoá khỏi máy.')) return;
    setDk(null);
    showDkSetup();
  });

  restoreTripDraft();
  restoreCheck();
  restoreDk();

  function focusInput() {
    // Keep focus for the barcode gun, but not while the camera is open (avoids popping the mobile keyboard).
    if (els.cameraBox.hidden) els.input.focus();
  }

  // Barcode guns type the code then send Enter, which submits the form.
  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var value = els.input.value;
    els.input.value = '';
    handleScan(value);
    focusInput();
  });

  // ---------- Live camera ----------
  function supportedFormats() {
    var F = window.Html5QrcodeSupportedFormats;
    return [F.QR_CODE, F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.ITF, F.DATA_MATRIX];
  }

  function openCamera() {
    if (!window.Html5Qrcode) { showResult('error', 'Không tải được thư viện camera'); return; }
    els.cameraBox.hidden = false;
    els.input.blur();
    scanner = new Html5Qrcode('camera-view', { formatsToSupport: supportedFormats(), verbose: false });
    scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: function (w, h) { return { width: Math.floor(w * 0.85), height: Math.floor(h * 0.6) }; } },
      function (text) {
        var now = Date.now();
        if (text === lastCamera.text && now - lastCamera.at < CAMERA_REPEAT_MS) return;
        lastCamera = { text: text, at: now };
        if (navigator.vibrate) navigator.vibrate(80);
        handleScan(text);
      },
      function () { /* per-frame "not found" — ignore */ }
    ).catch(function (err) {
      closeCamera();
      // Permission denied or an in-app browser (Zalo/Facebook) without camera access: offer photo capture.
      els.photoLabel.hidden = false;
      showResult('error', 'Không mở được camera trực tiếp',
        'Cho phép quyền camera (biểu tượng ổ khoá trên thanh địa chỉ), mở bằng Chrome/Safari, hoặc dùng nút "Chụp ảnh mã vận đơn". '
        + (err && err.message ? err.message : err));
    });
  }

  function closeCamera() {
    var s = scanner;
    scanner = null;
    els.cameraBox.hidden = true;
    if (s) {
      var cleanup = function () { try { s.clear(); } catch (e) { /* noop */ } };
      if (s.isScanning) s.stop().then(cleanup, cleanup); else cleanup();
    }
    focusInput();
  }

  // ---------- Photo fallback ----------
  els.photoInput.addEventListener('change', function () {
    var file = els.photoInput.files && els.photoInput.files[0];
    els.photoInput.value = '';
    if (!file || !window.Html5Qrcode) return;
    var decoder = new Html5Qrcode('file-decoder', { formatsToSupport: supportedFormats(), verbose: false });
    decoder.scanFile(file, false)
      .then(function (text) { handleScan(text); })
      .catch(function () {
        showResult('not_found', 'Không đọc được mã trong ảnh', 'Chụp gần và rõ hơn');
        speak('Không đọc được mã');
      })
      .then(function () { try { decoder.clear(); } catch (e) { /* noop */ } });
  });

  els.cameraBtn.addEventListener('click', function () { if (scanner) closeCamera(); else openCamera(); });
  els.cameraClose.addEventListener('click', closeCamera);
  els.reloadBtn.addEventListener('click', function () { loadData(focusInput); });

  // ---------- Start gate ----------
  els.startBtn.addEventListener('click', function () {
    speak('Bắt đầu ca'); // speaking inside a user gesture unlocks speechSynthesis on iOS Safari
    els.gate.hidden = true;
    loadData(focusInput);
  });

  if ('speechSynthesis' in window) {
    pickVoice();
    if (speechSynthesis.addEventListener) speechSynthesis.addEventListener('voiceschanged', pickVoice);
  }
})();

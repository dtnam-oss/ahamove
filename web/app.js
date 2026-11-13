// Browser controller: data loading, barcode-gun input, camera scanning, spoken results,
// "Chuyến đi" mode (enter a truck plate, check each order loaded on the device, save the trip to sheet
// chuyen_di once it is finished, and list/copy the trips of a day)
// "Backlog" mode (speak the days left to the deadline from sheet back_log)
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
    tripList: $('trip-list'),
    tripProgress: $('trip-progress'),
    tripPlateLabel: $('trip-plate-label'),
    tripCount: $('trip-count'),
    tripFinish: $('trip-finish'),
    tripCancel: $('trip-cancel'),
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

  // 'sort' = sorting location | 'routesort' = route | 'trip' = load a trip | 'backlog' = days left | 'route' = route check
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
  function loadData(done) {
    els.status.textContent = 'Đang tải dữ liệu…';
    els.reloadBtn.disabled = true;
    apiGet('?action=data&t=' + Date.now())
      .then(function (body) {
        index = Lookup.buildIndex(body);
        var time = new Date(body.updatedAt).toLocaleTimeString('vi-VN');
        var backlogInfo = body.backlog ? Object.keys(body.backlog).length + ' backlog' : 'backlog lỗi: ' + body.backlogError;
        var routeInfo = body.routes ? countRoutes(body.routes) + ' tuyến' : 'tuyến lỗi: ' + body.routesError;
        els.status.textContent = body.orderCount + ' đơn · ' + backlogInfo + ' · ' + routeInfo + ' · cập nhật ' + time;
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
        if (done) done();
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
    if (!index) { speak('Chưa tải dữ liệu'); return; }
    if (mode === 'trip') { handleTripScan(raw); return; }
    if (mode === 'backlog') { handleBacklog(raw); return; }
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
    if (mode === 'route') { if (index) showRouteScreen(); else showResult('idle', 'Chưa tải dữ liệu', ''); return; }
    if (mode === 'trip') { showTripScreen(); return; }
    var hints = { backlog: 'Chế độ kiểm tra backlog', routesort: 'Chế độ chia đơn theo tuyến' };
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
  var takenToday = new Map(); // code -> {ma_chuyen, bks} of trips saved today, on any device
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
    return fetchTrips('').then(function (body) { setTaken(body.trips); }, function () { /* the server re-checks on save */ });
  }

  function leaveTripScreens() {
    els.tripHome.hidden = true;
    els.tripProgress.hidden = true;
  }

  function showTripScreen() {
    if (tripDraft) enterTripScan(); else showTripHome();
  }

  function showTripHome(message) {
    els.tripHome.hidden = false;
    els.tripProgress.hidden = true;
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
        if (isToday) setTaken(body.trips);
        if (seq !== tripListSeq) return;
        renderTrips(body.trips);
        var orders = body.trips.reduce(function (n, t) { return n + t.codes.length; }, 0);
        els.tripNote.textContent = message || body.trips.length + ' chuyến · ' + orders + ' đơn · ngày ' + body.day;
      })
      .catch(function (err) {
        if (seq === tripListSeq) els.tripNote.textContent = 'Lỗi tải danh sách chuyến: ' + errorText(err);
      });
  }

  /** One row per trip: a card on phones, a table row on wider screens (CSS); "Xem đơn" opens the codes. */
  function renderTrips(trips) {
    els.tripList.textContent = '';
    if (!trips.length) { els.tripList.appendChild(el('div', 'muted', 'Chưa có chuyến nào trong ngày này.')); return; }
    var head = el('div', 'trip-row trip-head');
    ['Mã chuyến', 'BKS', 'Giờ tạo', 'Số đơn', ''].forEach(function (t) { head.appendChild(el('span', '', t)); });
    els.tripList.appendChild(head);
    trips.forEach(function (trip) {
      var item = el('div', 'trip-item');
      var row = el('div', 'trip-row');
      row.appendChild(el('b', 'trip-id', trip.ma_chuyen));
      row.appendChild(el('span', 'trip-plate', trip.bks));
      row.appendChild(el('span', 'trip-time muted', trip.thoi_gian.slice(11, 16)));
      row.appendChild(el('span', 'trip-total', trip.codes.length + ' đơn'));
      var toggle = el('button', 'btn trip-toggle', 'Xem đơn');
      toggle.type = 'button';
      row.appendChild(toggle);
      item.appendChild(row);

      var detail = el('div', 'trip-detail');
      detail.hidden = true;
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
      els.tripList.appendChild(item);
    });
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

  restoreTripDraft();

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

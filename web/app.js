// Browser controller: data loading, barcode-gun input, camera scanning, spoken results,
// "Ghi sheet" mode (write each scanned code to sheet data_don, moving down one row per scan)
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
    writePanel: $('write-panel'),
    writeCol: $('write-col'),
    writeRow: $('write-row'),
    nextCell: $('next-cell'),
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

  var mode = 'sort'; // 'sort' = speak sorting location | 'write' = write code to data_don | 'backlog' = days left | 'route' = route
  var writeCell = ''; // cell the next scan is written to (server moves further down if it is taken)
  var writeQueue = Promise.resolve(); // writes run one at a time so cells fill in scan order
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

  // ---------- Data ----------
  function loadData(done) {
    els.status.textContent = 'Đang tải dữ liệu…';
    els.reloadBtn.disabled = true;
    // Simple GET (no custom headers) so the Apps Script redirect to googleusercontent passes CORS.
    fetch(window.APP_CONFIG.apiUrl + '?action=data&t=' + Date.now())
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (body) {
        if (body.error) throw new Error(body.error);
        index = Lookup.buildIndex(body);
        var time = new Date(body.updatedAt).toLocaleTimeString('vi-VN');
        var backlogInfo = body.backlog ? Object.keys(body.backlog).length + ' backlog' : 'backlog lỗi: ' + body.backlogError;
        var routeInfo = body.routes ? countRoutes(body.routes) + ' tuyến' : 'tuyến lỗi: ' + body.routesError;
        els.status.textContent = body.orderCount + ' đơn · ' + backlogInfo + ' · ' + routeInfo + ' · cập nhật ' + time;
        if (mode === 'route') showRouteScreen(); // totals follow the reloaded raw_data
      })
      .catch(function (err) {
        var msg = (err && err.message) || String(err);
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
    if (mode === 'write') { queueWrite(raw); return; }
    if (!index) { speak('Chưa tải dữ liệu'); return; }
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

  // ---------- Write mode (sheet data_don) ----------
  function setWriteCell(cell) {
    writeCell = cell;
    var col = (/^[A-Z]+/.exec(cell) || [''])[0];
    els.nextCell.textContent = cell
      ? 'Sheet data_don · lần quét tới ghi vào ô ' + cell + ' (ô đã có thì xuống ô trống kế tiếp) · kiểm tra trùng trên cả cột ' + col
      : 'Nhập cột của bạn (ví dụ C) trước khi quét';
  }

  /** Column (required) + start row (default 1) -> start cell, e.g. "C" + "" -> "C1". */
  function updateWriteCell() {
    var col = els.writeCol.value.replace(/\s+/g, '').toUpperCase();
    var row = els.writeRow.value.replace(/\s+/g, '') || '1';
    var hasCol = /^[A-Z]{1,3}$/.test(col);
    setWriteCell(hasCol ? Lookup.normalizeCell(col + row) : '');
    if (hasCol && !writeCell) els.nextCell.textContent = 'Dòng bắt đầu không hợp lệ';
  }

  function queueWrite(raw) {
    if (!Lookup.normalizeCode(raw)) return;
    // Prefer the known tracking number inside a QR payload (URL/JSON); otherwise write the scan as-is.
    var code = (index && Lookup.findCode(raw, index.orders)) || Lookup.normalizeCode(raw);
    writeQueue = writeQueue.then(function () { return writeCode(code); });
  }

  function writeCode(code) {
    if (!writeCell) {
      var noCol = !els.writeCol.value.trim();
      showResult('error', noCol ? 'Chưa nhập cột' : 'Cột/dòng không hợp lệ', els.nextCell.textContent, code);
      speak(noCol ? 'Chưa nhập cột' : 'Cột không hợp lệ');
      return;
    }
    showResult('pending', 'Đang ghi…', 'Ô ' + writeCell, code);
    // text/plain keeps this a CORS simple request (no preflight, which Apps Script cannot answer).
    return fetch(window.APP_CONFIG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'write', cell: writeCell, code: code }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (body) {
        if (body.error) throw new Error(body.error);
        // The server refuses codes already present in the column (also catches camera re-reads).
        if (body.duplicate) {
          showResult('unmapped', 'Trùng mã', 'Đã có ở ô ' + body.cell + ' — không ghi', body.code);
          speak('Trùng mã');
          return;
        }
        setWriteCell(Lookup.nextCell(body.cell));
        showResult('ok', 'Đã ghi ô ' + body.cell, 'Tiếp theo: ô ' + writeCell, body.code);
        speak('Đã ghi ô ' + body.cell);
      })
      .catch(function (err) {
        showResult('error', 'Ghi thất bại', (err && err.message) || String(err), code);
        speak('Ghi thất bại');
      });
  }

  function setMode(next) {
    mode = next;
    Array.prototype.forEach.call(els.modeBtns, function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === mode));
    });
    els.writePanel.hidden = mode !== 'write';
    leaveRouteScreens();
    if (mode === 'route') { if (index) showRouteScreen(); else showResult('idle', 'Chưa tải dữ liệu', ''); return; }
    var hints = { write: 'Chế độ ghi sheet data_don', backlog: 'Chế độ kiểm tra backlog', routesort: 'Chế độ chia đơn theo tuyến' };
    showResult('idle', 'Sẵn sàng quét', hints[mode] || '');
    if (mode === 'write' && !writeCell) els.writeCol.focus(); else focusInput();
  }

  Array.prototype.forEach.call(els.modeBtns, function (b) {
    b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
  });

  [els.writeCol, els.writeRow].forEach(function (input) {
    input.addEventListener('input', updateWriteCell);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); focusInput(); }
    });
  });
  updateWriteCell();

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
        els.mapNote.textContent = 'Không định vị được đơn ' + code + ': ' + ((err && err.message) || err);
      });
  }

  function locate(code) {
    if (orderPoints[code]) return Promise.resolve(orderPoints[code]);
    return fetch(window.APP_CONFIG.apiUrl + '?action=locate&code=' + encodeURIComponent(code))
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (body) {
        if (body.error) throw new Error(body.error);
        orderPoints[code] = body;
        return body;
      });
  }

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

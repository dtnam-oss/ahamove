// Goong map for "Tuyến" mode: the wards of the selected routes (blue dots) and the orders already
// loaded onto the truck (green pins), so the user can see the area covered and what is scanned.
// goong-js is loaded on first use only: every map load counts against the Goong Maptiles quota.
var OrderMap = (function () {
  var BASE = 'https://cdn.jsdelivr.net/npm/@goongmaps/goong-js@1.0.9/dist/';
  var STYLE_URL = 'https://tiles.goong.io/assets/goong_map_web.json';
  var loading = null;
  var map = null;
  var markers = [];

  function loadLibrary(key) {
    if (!loading) {
      loading = new Promise(function (resolve, reject) {
        var css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = BASE + 'goong-js.css';
        document.head.appendChild(css);
        var script = document.createElement('script');
        script.src = BASE + 'goong-js.js';
        script.onload = function () { window.goongjs.accessToken = key; resolve(); };
        script.onerror = function () { loading = null; reject(new Error('Không tải được thư viện bản đồ Goong')); };
        document.head.appendChild(script);
      });
    }
    return loading;
  }

  function dot(className, title) {
    var el = document.createElement('div');
    el.className = className;
    el.title = title;
    return el;
  }

  function addMarker(className, title, point) {
    markers.push(new window.goongjs.Marker(dot(className, title)).setLngLat([point.lng, point.lat]).addTo(map));
  }

  /**
   * Redraw everything and fit the view. data: {wards: [{phuong_xa, lat, lng}], pins: [{code, lat, lng}]}.
   * The container must be visible.
   */
  function show(container, key, data) {
    return loadLibrary(key).then(function () {
      var g = window.goongjs;
      var all = data.wards.concat(data.pins);
      if (!map) {
        var start = all[0] || { lat: 21.0285, lng: 105.8542 }; // Hà Nội centre when nothing to show
        map = new g.Map({ container: container, style: STYLE_URL, center: [start.lng, start.lat], zoom: 11 });
        map.addControl(new g.NavigationControl({ showCompass: false }));
      } else {
        map.resize(); // the box may have been hidden since the last draw
      }
      markers.forEach(function (m) { m.remove(); });
      markers = [];
      data.wards.forEach(function (w) { addMarker('ward-dot', w.phuong_xa, w); });
      data.pins.forEach(function (p) { addMarker('scan-pin', p.code, p); });
      if (all.length) {
        var bounds = new g.LngLatBounds([all[0].lng, all[0].lat], [all[0].lng, all[0].lat]);
        all.forEach(function (p) { bounds.extend([p.lng, p.lat]); });
        map.fitBounds(bounds, { padding: 30, maxZoom: 14, duration: 0 });
      }
    });
  }

  /** Add one scanned order without moving the view (no-op until the map exists). */
  function addPin(point) {
    if (map) addMarker('scan-pin', point.code, point);
  }

  return { show: show, addPin: addPin };
})();

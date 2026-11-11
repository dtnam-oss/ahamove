// Goong map for "Tuyến" mode: the scanned order (red pin) and the wards of its route (blue dots),
// so the user can see at a glance whether the order lies inside its route's area.
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

  /** data: {order: {lat, lng, code}, wards: [{phuong_xa, lat, lng}]}. Container must be visible. */
  function show(container, key, data) {
    return loadLibrary(key).then(function () {
      var g = window.goongjs;
      var orderLngLat = [data.order.lng, data.order.lat];
      if (!map) {
        map = new g.Map({ container: container, style: STYLE_URL, center: orderLngLat, zoom: 12 });
        map.addControl(new g.NavigationControl({ showCompass: false }));
      } else {
        map.resize(); // the box may have been hidden since the last scan
      }
      markers.forEach(function (m) { m.remove(); });
      markers = [];
      var bounds = new g.LngLatBounds(orderLngLat, orderLngLat);
      data.wards.forEach(function (w) {
        markers.push(new g.Marker(dot('ward-dot', w.phuong_xa)).setLngLat([w.lng, w.lat]).addTo(map));
        bounds.extend([w.lng, w.lat]);
      });
      markers.push(new g.Marker(dot('order-pin', data.order.code)).setLngLat(orderLngLat).addTo(map));
      map.fitBounds(bounds, { padding: 40, maxZoom: 15, duration: 0 });
    });
  }

  return { show: show };
})();

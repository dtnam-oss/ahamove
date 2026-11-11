// Goong (goong.io) forward geocoding, used for ward points (routes.js) and order points (locate.js).
// GOONG_API_KEY is the Goong REST API key, defined in config.js (git-ignored, pushed by clasp).
//
// Measured on real data: a full order address ("Số…, Ngõ…, Xã…, Huyện…, Hà Nội") geocodes to the
// right district almost always, while a bare ward/district name often matches an unrelated shop
// elsewhere in Vietnam. So every result is checked against the expected district (Goong returns it
// in `compound`) and rejected when it does not match.
//
// Limits seen on the key: a request quota (X-RateLimit-Limit / X-RateLimit-Remaining headers, not
// replenished within minutes) plus HTTP 429 when requests come too fast. So requests are paced, a
// 429 is retried after a pause, and callers save results batch by batch (nothing is lost on a stop).

const GOONG_GEOCODE_URL = 'https://rsapi.goong.io/geocode';
const GOONG_BATCH = 5; // parallel requests per UrlFetchApp.fetchAll call
const GOONG_PAUSE_MS = 1000; // between batches: about 5 requests per second
const GOONG_RETRIES = 3; // per batch, on HTTP 429, with a growing pause
const GOONG_RETRY_PAUSE_MS = 15000;

function goongKey_() {
  const key = typeof GOONG_API_KEY === 'string' ? GOONG_API_KEY.trim() : '';
  if (!key) throw new Error('Chưa cấu hình GOONG_API_KEY trong gas/config.js');
  return key;
}

/** Admin name without its level prefix, folded: "Huyện Mỹ Đức" -> "my duc", "Quận 3" -> "3". */
function adminName_(value) {
  return foldText_(value).replace(/^(xa|phuong|thi tran|huyen|quan|thi xa|thanh pho|tp\.?)\s+/, '');
}

/**
 * Geocode many {address, district} queries (district = expected district, may be '').
 * Returns one entry per query: {lat, lng, commune} or null when nothing matching is found.
 * onBatch(results, offset) runs after each batch so callers can save progress.
 * Key/quota errors are thrown so a run stops instead of silently mis-placing everything.
 */
function goongGeocodeMany_(queries, onBatch) {
  const key = goongKey_();
  const out = [];
  for (let start = 0; start < queries.length; start += GOONG_BATCH) {
    if (start > 0) Utilities.sleep(GOONG_PAUSE_MS);
    const chunk = queries.slice(start, start + GOONG_BATCH);
    const requests = chunk.map(function (q) {
      return {
        url: GOONG_GEOCODE_URL + '?address=' + encodeURIComponent(q.address) + '&api_key=' + encodeURIComponent(key),
        muteHttpExceptions: true,
      };
    });
    let responses;
    for (let attempt = 0; ; attempt++) {
      responses = UrlFetchApp.fetchAll(requests);
      const limited = responses.find(function (r) { return r.getResponseCode() === 429; });
      if (!limited) break;
      if (quotaLeft_(limited) === 0 || attempt >= GOONG_RETRIES) throw new Error(rateLimitMessage_(limited));
      Utilities.sleep(GOONG_RETRY_PAUSE_MS * (attempt + 1));
    }
    const results = responses.map(function (res, i) { return parseGoong_(res, chunk[i]); });
    Array.prototype.push.apply(out, results);
    if (onBatch) onBatch(results, start);
  }
  return out;
}

function goongGeocode_(address, district) {
  return goongGeocodeMany_([{ address: address, district: district || '' }])[0];
}

/** X-RateLimit-Remaining as a number, or NaN when the header is missing. */
function quotaLeft_(res) {
  const headers = res.getHeaders() || {};
  const key = Object.keys(headers).find(function (h) { return h.toLowerCase() === 'x-ratelimit-remaining'; });
  return key ? Number(headers[key]) : NaN;
}

function rateLimitMessage_(res) {
  const headers = res.getHeaders() || {};
  const limitKey = Object.keys(headers).find(function (h) { return h.toLowerCase() === 'x-ratelimit-limit'; });
  return quotaLeft_(res) === 0
    ? 'Goong: API key đã dùng hết hạn mức ' + (limitKey ? headers[limitKey] + ' ' : '') + 'lượt (HTTP 429). ' +
      'Kết quả đã có được lưu trong toa_do_don; chạy lại khi Goong cấp thêm lượt.'
    : 'Goong báo gọi quá nhanh (HTTP 429) kể cả sau ' + GOONG_RETRIES + ' lần chờ. Kết quả đã có được lưu; chạy lại sau ít phút.';
}

function parseGoong_(res, query) {
  const status = res.getResponseCode();
  if (status === 401 || status === 403) throw new Error('Goong từ chối API key (HTTP ' + status + ')');
  if (status === 429) throw new Error(rateLimitMessage_(res));
  if (status !== 200) {
    console.warn('Goong HTTP ' + status);
    return null;
  }
  const body = JSON.parse(res.getContentText() || '{}');
  const first = body.results && body.results[0];
  const loc = first && first.geometry && first.geometry.location;
  if (!loc || !isFinite(loc.lat) || !isFinite(loc.lng)) return null;
  const compound = first.compound || {};
  if (query.district && adminName_(compound.district) !== adminName_(query.district)) return null; // wrong place
  return { lat: Number(loc.lat), lng: Number(loc.lng), commune: String(compound.commune || '') };
}

// Goong (goong.io) forward geocoding, used for ward points (routes.js) and order points (locate.js).
// GOONG_API_KEY is the Goong REST API key, defined in config.js (git-ignored, pushed by clasp).
//
// Measured on real data: a full order address ("Số…, Ngõ…, Xã…, Huyện…, Hà Nội") geocodes to the
// right district almost always, while a bare ward/district name often matches an unrelated shop
// elsewhere in Vietnam. So every result is checked against the expected district (Goong returns it
// in `compound`) and rejected when it does not match.

const GOONG_GEOCODE_URL = 'https://rsapi.goong.io/geocode';
const GOONG_BATCH = 10; // parallel requests per UrlFetchApp.fetchAll call

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
 * Key/quota errors are thrown so a run stops instead of silently mis-placing everything.
 */
function goongGeocodeMany_(queries) {
  const key = goongKey_();
  const out = [];
  for (let start = 0; start < queries.length; start += GOONG_BATCH) {
    const chunk = queries.slice(start, start + GOONG_BATCH);
    const responses = UrlFetchApp.fetchAll(chunk.map(function (q) {
      return {
        url: GOONG_GEOCODE_URL + '?address=' + encodeURIComponent(q.address) + '&api_key=' + encodeURIComponent(key),
        muteHttpExceptions: true,
      };
    }));
    responses.forEach(function (res, i) { out.push(parseGoong_(res, chunk[i])); });
    if (start + GOONG_BATCH < queries.length) Utilities.sleep(200); // pace batches for Goong's rate limit
  }
  return out;
}

function goongGeocode_(address, district) {
  return goongGeocodeMany_([{ address: address, district: district || '' }])[0];
}

function parseGoong_(res, query) {
  const status = res.getResponseCode();
  if (status === 401 || status === 403) throw new Error('Goong từ chối API key (HTTP ' + status + ')');
  if (status === 429) throw new Error('Goong báo vượt hạn mức (HTTP 429), thử lại sau');
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

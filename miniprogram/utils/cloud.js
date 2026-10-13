const app = getApp()

function getCloud() {
  return new Promise(resolve => {
    app.getCloud(resolve)
  })
}

function getOpenid() {
  return new Promise(resolve => {
    app.getOpenid(resolve)
  })
}

async function db() {
  const cloud = await getCloud()
  return cloud.database()
}

async function callFunction(name, data) {
  var cloud = await getCloud()
  // One silent retry after 500ms: a transient network blip must not surface
  // as an error to the guest. Safe for mutations too — writes collapse
  // duplicates (deterministic ids / idempotent patches).
  var invoke = function () { return cloud.callFunction({ name, data }) }
  try {
    var res = await invoke().catch(function () {
      return new Promise(function (resolve, reject) {
        setTimeout(function () { invoke().then(resolve, reject) }, 500)
      })
    })
    return res.result
  } catch (err) {
    console.error('[cloud] ' + name + ' failed:', err)
    throw err
  }
}

async function getTempUrl(fileID) {
  const cloud = await getCloud()
  const res = await cloud.getTempFileURL({ fileList: [fileID] })
  return res.fileList[0].tempFileURL
}

async function getTempUrls(fileIDs) {
  if (!fileIDs || fileIDs.length === 0) return {}
  const cloud = await getCloud()
  var map = {}
  // getTempFileURL accepts at most 50 file IDs per call — batch them.
  for (var i = 0; i < fileIDs.length; i += 50) {
    var batch = fileIDs.slice(i, i + 50)
    var res = await cloud.getTempFileURL({ fileList: batch })
    res.fileList.forEach(f => { if (f.tempFileURL) map[f.fileID] = f.tempFileURL })
  }
  return map
}

// Fields on an `events` doc that may hold `cloud://` file IDs needing
// resolution to temp https URLs before they can be displayed.
var SINGLE_IMAGE_FIELDS = ['promoImage', 'coverImage']
var IMAGE_LIST_FIELDS = ['promoImages', 'promoMaterials']

function isCloudUrl(url) {
  return !!url && typeof url === 'string' && url.indexOf('cloud://') === 0
}

// ─── Resolved-URL cache ─────────────────────────────────────────────────────
// Temp file URLs stay valid for hours, so re-resolving the same event images
// on every feed/event visit is pure request waste. Cached as {fileID:
// {url, ts}} in local storage: entries younger than URL_TTL_MS are reused
// as-is, the rest are re-resolved and stored. A daily sweep (URL_MAX_AGE_MS)
// on every read keeps storage bounded — nothing survives for more than a day.
var URL_CACHE_KEY = 'yue_imgurl_cache_v1'
var URL_TTL_MS = 90 * 60 * 1000 // safely inside the ~2h temp-URL signature validity
var URL_MAX_AGE_MS = 24 * 60 * 60 * 1000

function readUrlCache() {
  var now = Date.now()
  var raw = {}
  try { raw = wx.getStorageSync(URL_CACHE_KEY) || {} } catch (e) { raw = {} }
  var out = {}
  Object.keys(raw).forEach(function(k) {
    var entry = raw[k]
    if (entry && entry.url && now - entry.ts < URL_MAX_AGE_MS) out[k] = entry
  })
  return out
}

function writeUrlCache(map) {
  try { wx.setStorageSync(URL_CACHE_KEY, map) } catch (e) { /* cache is optional */ }
}

// Resolves every cloud:// URL found on promoImage/coverImage (single fields)
// and promoImages/promoMaterials (array fields) across one or more event
// docs, batching them into a single clientAuth `resolveImages` call and
// mutating the events in place. Routes through the clientAuth cloud
// function (rather than calling cloud.getTempFileURL directly from the
// client, as getTempUrl/getTempUrls above do) because the guest app talks
// to the admin app's cloud env cross-account — resolving temp URLs
// server-side inside the cloud function (which runs natively in that env)
// is the pattern already proven in production by feed.js/event-detail.js.
async function resolveEventImages(events) {
  var list = Array.isArray(events) ? events : [events]
  var allCloudUrls = []

  list.forEach(function(event) {
    if (!event) return
    SINGLE_IMAGE_FIELDS.forEach(function(field) {
      if (isCloudUrl(event[field])) allCloudUrls.push(event[field])
    })
    IMAGE_LIST_FIELDS.forEach(function(field) {
      if (Array.isArray(event[field])) {
        event[field].forEach(function(url) {
          if (isCloudUrl(url)) allCloudUrls.push(url)
        })
      }
    })
  })

  if (allCloudUrls.length === 0) return events

  // Serve fresh cache entries without a single request; resolve only the rest.
  // A cached URL is usable only if BOTH its cache window is fresh AND the
  // URL's own signature (the t= param, epoch seconds) has more than 5
  // minutes to live — the render layer gets a URL that cannot die under it.
  var urlCache = readUrlCache()
  var now = Date.now()
  var nowSec = Math.floor(now / 1000)
  var urlAlive = function (u) {
    var m = /[?&]t=(\d+)/.exec(u || '')
    return !m || (Number(m[1]) - 300) > nowSec
  }
  var urlMap = {}
  var toResolve = []
  allCloudUrls.forEach(function(u) {
    var entry = urlCache[u]
    if (entry && entry.url && now - entry.ts < URL_TTL_MS && urlAlive(entry.url)) {
      urlMap[u] = entry.url
    } else {
      toResolve.push(u)
    }
  })

  if (toResolve.length > 0) {
    // Primary: cloud function resolves server-side (reliable cross-account).
    // Batch the calls at 50 to stay under getTempFileURL's per-call limit.
    try {
      for (var i = 0; i < toResolve.length; i += 50) {
        var batch = toResolve.slice(i, i + 50)
        var result = await callFunction('clientAuth', { action: 'resolveImages', fileList: batch })
        var batchMap = (result && result.urlMap) || {}
        Object.keys(batchMap).forEach(function(k) { urlMap[k] = batchMap[k] })
      }
    } catch (err) {
      console.error('[cloud] resolveEventImages CF error:', err)
    }

    // Fallback: direct client-side resolution if the CF didn't resolve everything.
    var unresolved = toResolve.filter(function(u) { return !urlMap[u] })
    if (unresolved.length > 0) {
      try {
        var directMap = await getTempUrls(unresolved)
        Object.keys(directMap).forEach(function(k) { if (directMap[k]) urlMap[k] = directMap[k] })
      } catch (err2) {
        console.error('[cloud] resolveEventImages direct error:', err2)
      }
    }

    // Persist the resolutions (this read's sweep already pruned day-old junk).
    allCloudUrls.forEach(function(u) {
      if (urlMap[u]) urlCache[u] = { url: urlMap[u], ts: Date.now() }
    })
    writeUrlCache(urlCache)
  }

  list.forEach(function(event) {
    if (!event) return
    SINGLE_IMAGE_FIELDS.forEach(function(field) {
      if (event[field]) event[field] = urlMap[event[field]] || event[field]
    })
    IMAGE_LIST_FIELDS.forEach(function(field) {
      if (Array.isArray(event[field])) {
        event[field] = event[field].map(function(url) { return urlMap[url] || url })
      }
    })
  })

  return events
}

module.exports = { getCloud, getOpenid, db, callFunction, getTempUrl, getTempUrls, resolveEventImages }
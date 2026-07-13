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
  const cloud = await getCloud()
  const res = await cloud.callFunction({ name, data })
  return res.result
}

async function getTempUrl(fileID) {
  const cloud = await getCloud()
  const res = await cloud.getTempFileURL({ fileList: [fileID] })
  return res.fileList[0].tempFileURL
}

async function getTempUrls(fileIDs) {
  if (!fileIDs || fileIDs.length === 0) return {}
  const cloud = await getCloud()
  const res = await cloud.getTempFileURL({ fileList: fileIDs })
  const map = {}
  res.fileList.forEach(f => { map[f.fileID] = f.tempFileURL })
  return map
}

// Fields on an `events` doc that may hold `cloud://` file IDs needing
// resolution to temp https URLs before they can be displayed.
var SINGLE_IMAGE_FIELDS = ['promoImage', 'coverImage']
var IMAGE_LIST_FIELDS = ['promoImages', 'promoMaterials']

function isCloudUrl(url) {
  return !!url && typeof url === 'string' && url.indexOf('cloud://') === 0
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

  try {
    var result = await callFunction('clientAuth', { action: 'resolveImages', fileList: allCloudUrls })
    var urlMap = (result && result.urlMap) || {}

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
  } catch (err) {
    console.error('[cloud] resolveEventImages error:', err)
  }

  return events
}

module.exports = { getCloud, getOpenid, db, callFunction, getTempUrl, getTempUrls, resolveEventImages }
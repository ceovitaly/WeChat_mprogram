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

module.exports = { getCloud, getOpenid, db, callFunction, getTempUrl, getTempUrls }
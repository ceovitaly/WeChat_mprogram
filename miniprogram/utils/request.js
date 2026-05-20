const callFunction = async (name, data = {}) => {
  try {
    const res = await wx.cloud.callFunction({ name, data })
    return res.result
  } catch (err) {
    console.error(`[Cloud] ${name} failed:`, err)
    throw err
  }
}

const db = () => wx.cloud.database()

const collection = (name) => wx.cloud.database().collection(name)

module.exports = {
  callFunction,
  db,
  collection
}
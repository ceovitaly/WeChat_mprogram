const callFunction = async (name, data = {}) => {
  // One silent retry after 500ms: a transient network blip must not surface
  // as "Load failed". Safe for mutations too — this app's writes collapse
  // duplicates (deterministic ids / idempotent patches).
  const invoke = () => wx.cloud.callFunction({ name, data })
  try {
    const res = await invoke().catch(() =>
      new Promise((resolve, reject) =>
        setTimeout(() => invoke().then(resolve, reject), 500)
      )
    )
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
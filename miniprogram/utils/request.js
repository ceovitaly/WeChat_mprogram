const callFunction = async (name, data = {}) => {
  const app = getApp()
  const session = app && app.globalData && app.globalData.counterSession
  const payload = session && (name === 'manageApplications' || name === 'checkInGuest' || name === 'manageStaff')
    ? { ...data, counterSession: session } : data
  // One silent retry after 500ms: a transient network blip must not surface
  // as "Load failed". Safe for mutations too — this app's writes collapse
  // duplicates (deterministic ids / idempotent patches).
  const invoke = () => wx.cloud.callFunction({ name, data: payload })
  try {
    const res = await invoke().catch(() =>
      new Promise((resolve, reject) =>
        setTimeout(() => invoke().then(resolve, reject), 500)
      )
    )
    if (res.result && ['COUNTER_SESSION_INVALID', 'COUNTER_PASSWORD_CHANGED'].includes(res.result.code) && session &&
        app.globalData.counterSession && app.globalData.counterSession.sessionId === session.sessionId) {
      app.endCounterSessionLocal(res.result.message, session)
    }
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
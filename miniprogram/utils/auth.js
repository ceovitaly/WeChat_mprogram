// utils/auth.js — single source of truth for "is the user signed in".
//
// Auth semantics (web-app style):
//   authorized = a `guests` record exists for this openid AND the user has
//                not explicitly logged out (`loggedOut` storage flag).
//   anonymous  = no guest record, or `loggedOut` is set.
//
// Pages must derive ALL personalized UI (badges, tickets, profile, header
// pill) from getAuth() — never read app.globalData.openid /
// app.globalData.userInfo / the `userInfo` storage key directly.
//
// The `loggedOut` flag is set only by logout() and cleared ONLY by
// completeSignIn() (i.e. only on a successful sign-in — never on read).

const app = getApp()

// Resolution state lives on app.globalData so it is per-app-session:
//   authState     — undefined: unresolved; null: anonymous; object: profile
//   authCallbacks — queue of waiters while one resolution is in flight
//   authGen       — generation counter; bumped by invalidateAuth() so a
//                   stale in-flight resolution can't overwrite a newer state

function isLoggedOut() {
  try {
    return wx.getStorageSync('loggedOut') === '1'
  } catch (e) {
    return false
  }
}

// Resolve the current auth state. callback(profile|null).
// Concurrent callers share one in-flight resolution (same queue pattern as
// openidReadyCallbacks in app.js). The result is memoized for the session;
// call invalidateAuth() after a sign-in/sign-out transition.
function getAuth(callback) {
  const gd = app.globalData

  // Explicit logout wins over everything and is NOT consumed by reading it.
  if (isLoggedOut()) {
    callback(null)
    return
  }

  if (gd.authState !== undefined) {
    callback(gd.authState)
    return
  }

  if (gd.userInfo) {
    gd.authState = gd.userInfo
    callback(gd.userInfo)
    return
  }

  if (gd.authCallbacks) {
    gd.authCallbacks.push(callback)
    return
  }
  gd.authCallbacks = [callback]
  const gen = gd.authGen || 0

  const finish = (profile, memoize) => {
    if (memoize && (gd.authGen || 0) === gen && gd.authState === undefined) {
      gd.authState = profile
    }
    const cbs = gd.authCallbacks || []
    gd.authCallbacks = null
    cbs.forEach(cb => cb(profile))
  }

  // Wait for login (openid) so we don't query mid-startup, then look for
  // this user's guest record. The query is auto-filtered by _openid
  // server-side, so no explicit openid is needed in the where clause.
  app.getOpenid(() => {
    app.getCloud((cloud) => {
      cloud.database().collection('guests').limit(1).get()
        .then(res => {
          const profile = (res.data && res.data.length > 0) ? res.data[0] : null
          if (profile && (gd.authGen || 0) === gen) {
            gd.userInfo = profile
            try { wx.setStorageSync('userInfo', profile) } catch (e) {}
          }
          finish(profile, true)
        })
        .catch(err => {
          // Transient failure: report anonymous but do NOT memoize, so the
          // next getAuth() retries instead of locking the session anonymous.
          console.error('[auth] guest lookup failed:', err)
          finish(null, false)
        })
    })
  })
}

// Forget the memoized auth state so the next getAuth() re-resolves.
// Must be called after any sign-in/sign-out transition.
function invalidateAuth() {
  const gd = app.globalData
  gd.authGen = (gd.authGen || 0) + 1
  gd.authState = undefined
}

// Explicit logout. Stays in force until completeSignIn().
function logout() {
  try { wx.removeStorageSync('userInfo') } catch (e) {}
  try { wx.removeStorageSync('pendingEventId') } catch (e) {}
  try { wx.setStorageSync('loggedOut', '1') } catch (e) {}
  app.globalData.userInfo = null
  invalidateAuth()
}

// Successful sign-in (or profile refresh for an already-signed-in user).
// `profile` must be the full guest doc from the DB (with _id/_openid).
// This is the ONLY place the loggedOut flag is cleared.
function completeSignIn(profile) {
  app.globalData.userInfo = profile
  try { wx.setStorageSync('userInfo', profile) } catch (e) {}
  try { wx.removeStorageSync('loggedOut') } catch (e) {}
  invalidateAuth()
}

module.exports = { getAuth, invalidateAuth, logout, completeSignIn }

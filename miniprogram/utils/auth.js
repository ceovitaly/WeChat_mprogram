const { STORAGE_KEYS, ROLES } = require('./constants')
const refCache = require('./refCache')

const getStoredUser = () => {
  return wx.getStorageSync(STORAGE_KEYS.STAFF_USER) || null
}

const saveUser = (userData) => {
  wx.setStorageSync(STORAGE_KEYS.STAFF_USER, userData)
}

// Also drops the cached reference lists: this is the single choke point for both
// an explicit logout (app.logout) and an expired session (handleAuthFailure), and
// one account's venues/promoters/staff must never survive into the next login.
const clearUser = () => {
  wx.removeStorageSync(STORAGE_KEYS.STAFF_USER)
  refCache.invalidateAll()
}

const isAdmin = (user) => {
  return user && user.role === ROLES.ADMIN
}

const isCounter = (user) => {
  return user && user.role === ROLES.COUNTER
}

const getStartPageByRole = (role) => {
  if (role === ROLES.ADMIN) return '/pages/admin/calendar/calendar'
  if (role === ROLES.COUNTER) return '/pages/counter/work/work'
  return '/pages/register/register'
}

// True when a cloud function answered with the standard auth-rejection payload
// (the caller's openid no longer maps to a staff doc — e.g. someone else logged
// into the same account, see loginStaff).
const isUnauthorized = (res) => !!res && res.success === false && res.message === 'Unauthorized'

// Shared handler for Unauthorized cloud-function responses: clears the stale
// session and returns to the login screen.
const handleAuthFailure = () => {
  clearUser()
  const app = getApp()
  if (app && app.globalData) {
    app.globalData.userInfo = null
    app.globalData.role = null
    app.globalData.isLogged = false
  }
  wx.showToast({ title: 'Session expired', icon: 'none' })
  wx.reLaunch({ url: '/pages/register/register' })
}

module.exports = {
  getStoredUser,
  saveUser,
  clearUser,
  isAdmin,
  isCounter,
  getStartPageByRole,
  isUnauthorized,
  handleAuthFailure
}
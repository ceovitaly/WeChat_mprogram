const { STORAGE_KEYS, ROLES } = require('./constants')

const getStoredUser = () => {
  return wx.getStorageSync(STORAGE_KEYS.STAFF_USER) || null
}

const saveUser = (userData) => {
  wx.setStorageSync(STORAGE_KEYS.STAFF_USER, userData)
}

const clearUser = () => {
  wx.removeStorageSync(STORAGE_KEYS.STAFF_USER)
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

module.exports = {
  getStoredUser,
  saveUser,
  clearUser,
  isAdmin,
  isCounter,
  getStartPageByRole
}
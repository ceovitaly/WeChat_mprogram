const { ENV_ID } = require('./utils/constants')
const { getStoredUser, getStartPageByRole } = require('./utils/auth')

App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('WeChat SDK 2.2.3+ required')
      return
    }
    wx.cloud.init({
      env: ENV_ID,
      traceUser: true
    })

    this.globalData = {
      userInfo: null,
      role: null,
      isLogged: false,
      currentVenueId: null,
      currentEventId: null
    }

    const cachedUser = getStoredUser()
    if (cachedUser) {
      this.globalData.userInfo = cachedUser
      this.globalData.role = cachedUser.role
      this.globalData.isLogged = true
    }
  },

  navigateByRole(role) {
    const url = getStartPageByRole(role)
    wx.reLaunch({ url })
  },

  logout() {
    const { clearUser } = require('./utils/auth')
    clearUser()
    this.globalData.userInfo = null
    this.globalData.role = null
    this.globalData.isLogged = false
    this.globalData.currentVenueId = null
    this.globalData.currentEventId = null
    wx.reLaunch({ url: '/pages/register/register' })
  }
})
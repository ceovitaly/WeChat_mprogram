const { ENV_ID } = require('./utils/constants')
const { getStoredUser, getStartPageByRole } = require('./utils/auth')

function getTheme() {
  try {
    return (wx.getAppBaseInfo && wx.getAppBaseInfo().theme) || 'light'
  } catch (e) {
    try { return wx.getSystemInfoSync().theme || 'light' } catch (_) { return 'light' }
  }
}

function applyNavBar(theme) {
  const dark = theme === 'dark'
  wx.setNavigationBarColor({
    frontColor: dark ? '#ffffff' : '#000000',
    backgroundColor: dark ? '#1C1C1E' : '#ffffff'
  })
}

// Inject nav bar theme update into every page's onShow automatically
const _Page = Page
Page = function(config) {
  const orig = config.onShow
  config.onShow = function(...args) {
    try { applyNavBar(getTheme()) } catch (_) {}
    if (orig) orig.apply(this, args)
  }
  return _Page(config)
}

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

    applyNavBar(getTheme())
    wx.onThemeChange(({ theme }) => applyNavBar(theme))

    this.globalData = {
      userInfo: null,
      role: null,
      isLogged: false,
      currentVenueId: null,
      currentEventId: null,
      counterSession: null
    }

    const cachedUser = getStoredUser()
    if (cachedUser) {
      this.globalData.userInfo = cachedUser
      this.globalData.role = cachedUser.role
      this.globalData.isLogged = true
      const saved = wx.getStorageSync('counterSession')
      if (cachedUser.role === 'counter' && saved && saved.staffId === cachedUser._id &&
          typeof saved.venueId === 'string' && typeof saved.sessionId === 'string') {
        this.globalData.counterSession = saved
      } else {
        wx.removeStorageSync('counterSession')
      }
    } else {
      wx.removeStorageSync('counterSession')
    }
  },

  navigateByRole(role) {
    const url = getStartPageByRole(role)
    wx.reLaunch({ url })
  },

  endCounterSessionLocal(message, expectedSession) {
    if (expectedSession && (!this.globalData.counterSession ||
        this.globalData.counterSession.sessionId !== expectedSession.sessionId)) return
    this.globalData.counterSession = null
    wx.removeStorageSync('counterSession')
    wx.removeStorageSync('currentVenueId')
    wx.removeStorageSync('currentVenueName')
    wx.removeStorageSync('currentEvent')
    const pages = getCurrentPages()
    const page = pages[pages.length - 1]
    if (page && page.route === 'pages/counter/work/work' && page.resetCounterWorkspace) {
      page.resetCounterWorkspace(message)
    }
  },

  async logout() {
    const session = this.globalData.counterSession
    if (session) {
      try {
        const reply = await wx.cloud.callFunction({ name: 'manageApplications',
          data: { action: 'endCounterSession', counterSession: session } })
        const res = reply && reply.result
        if (!res || (!res.success && res.code !== 'COUNTER_SESSION_INVALID')) throw new Error('Release failed')
      } catch (_) {
        wx.showToast({ title: 'Cannot log out while offline. Retry.', icon: 'none' })
        return
      }
      this.endCounterSessionLocal(null, session)
    }
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

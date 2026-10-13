const { callFunction } = require('../../../utils/request')
const { CLOUD_FUNCTIONS } = require('../../../utils/constants')
const { isUnauthorized, handleAuthFailure } = require('../../../utils/auth')

Page({
  data: {
    venueCount: 0,
    staffCount: 0,
    promoterCount: 0,
    pendingCount: 0,
    totalGuests: 0
  },

  onShow() {
    this._loadCounts()
  },

  async _loadCounts() {
    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, { action: 'getTeamCounts' })
      if (res && res.success) {
        this.setData({
          venueCount: res.venueCount || 0,
          staffCount: res.staffCount || 0,
          promoterCount: res.promoterCount || 0,
          pendingCount: res.pendingCount || 0,
          totalGuests: res.totalGuests || 0
        })
      } else if (isUnauthorized(res)) {
        handleAuthFailure()
      } else {
        wx.showToast({ title: 'Load failed', icon: 'none' })
      }
    } catch (err) {
      console.error('[Team] counts error:', err)
    }
  },

  goTo(e) {
    const { url } = e.currentTarget.dataset
    wx.navigateTo({ url })
  }
})

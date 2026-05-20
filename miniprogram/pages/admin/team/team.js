Page({
  data: {
    venueCount: 0,
    staffCount: 0,
    promoterCount: 0,
    pendingCount: 0
  },

  onShow() {
    this._syncTabBar()
    this._loadCounts()
  },

  _syncTabBar() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().updateTabs()
      this.getTabBar().setData({ selected: 1 })
    }
  },

  async _loadCounts() {
    try {
      const db = wx.cloud.database()
      const [vRes, sRes, pRes, pendRes] = await Promise.all([
        db.collection('venues').count(),
        db.collection('staff').where({ role: 'counter' }).count(),
        db.collection('promoters').where({ status: 'approved' }).count(),
        db.collection('promoters').where({ status: 'pending' }).count()
      ])
      this.setData({
        venueCount: vRes.total || 0,
        staffCount: sRes.total || 0,
        promoterCount: pRes.total || 0,
        pendingCount: pendRes.total || 0
      })
    } catch (err) {
      console.error('[Team] counts error:', err)
    }
  },

  goTo(e) {
    const { url } = e.currentTarget.dataset
    wx.navigateTo({ url })
  }
})
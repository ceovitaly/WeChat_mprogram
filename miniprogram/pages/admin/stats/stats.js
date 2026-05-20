const { callFunction } = require('../../../utils/request')

Page({
  data: {
    loading: false,
    totalEvents: 0,
    totalGuests: 0,
    totalStaff: 0,
    totalPromoters: 0,
    totalPending: 0,
    agentStats: []
  },

  onShow() {
    this._syncTabBar()
    this._refreshStats()
  },

  onPullDownRefresh() {
    this._refreshStats()
  },

  _syncTabBar() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().updateTabs()
      this.getTabBar().setData({ selected: 2 })
    }
  },

  async _refreshStats() {
    this.setData({ loading: true })
    wx.showNavigationBarLoading()

    try {
      const res = await callFunction('manageApplications', {
        action: 'getStats'
      })

      if (res && res.success) {
        const s = res.stats
        this.setData({
          totalEvents: s.events || 0,
          totalStaff: s.staff || 0,
          totalPromoters: s.promoters || 0,
          totalPending: s.pendingApplications || 0
        })
      }

      // Реальный счётчик гостей из коллекции registrations
      const countRes = await wx.cloud.database()
        .collection('registrations')
        .count()
      this.setData({ totalGuests: countRes.total || 0 })

      await this._loadAgentStats()

    } catch (err) {
      console.error('[Stats] error:', err)
      wx.showToast({ title: 'Load failed', icon: 'none' })
    } finally {
      this.setData({ loading: false })
      wx.hideNavigationBarLoading()
      wx.stopPullDownRefresh()
    }
  },

  async _loadAgentStats() {
    try {
      const db = wx.cloud.database()
      const $ = db.command.aggregate

      const res = await db.collection('registrations').aggregate()
        .match({ promoterId: db.command.exists(true) })
        .group({
          _id: '$promoterId',
          totalCount: $.sum(1),
          promoterName: $.first('$promoterName')
        })
        .sort({ totalCount: -1 })
        .limit(10)
        .end()

      const list = res.list || []
      const maxCount = list.length > 0
        ? Math.max(...list.map(a => a.totalCount)) : 1

      const agentStats = list.map(item => ({
        name: item.promoterName || 'Unknown',
        count: item.totalCount || 0,
        barPercent: Math.max(Math.round(((item.totalCount || 0) / maxCount) * 100), 5)
      }))

      this.setData({ agentStats })
    } catch (err) {
      console.error('[Stats] agent stats error:', err)
    }
  },

  goToCalendar() {
    wx.switchTab({ url: '/pages/admin/calendar/calendar' })
  },

  goToPromoters() {
    wx.navigateTo({ url: '/pages/admin/promoters/promoters' })
  },

  goToStaff() {
    wx.navigateTo({ url: '/pages/admin/staff/staff' })
  },

  goToGuests() {
    wx.navigateTo({ url: '/pages/admin/guests/guests' })
  },

  confirmLogout() {
    wx.showModal({
      title: 'Log out',
      content: 'Are you sure you want to log out?',
      confirmText: 'Log out',
      confirmColor: '#FF3B30',
      cancelText: 'Cancel',
      success: ({ confirm }) => {
        if (confirm) getApp().logout()
      }
    })
  }
})
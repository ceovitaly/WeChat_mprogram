const { callFunction } = require('../../../utils/request')
const { CLOUD_FUNCTIONS } = require('../../../utils/constants')
const { isUnauthorized, handleAuthFailure } = require('../../../utils/auth')

Page({
  data: {
    activeTab: 0,
    userName: '',

    loadingToday: false,
    todayEvents: [],

    loadingPast: false,
    pastEvents: [],

    refreshing: false
  },

  onShow() {
    this._syncTabBar()
    const userInfo = getApp().globalData.userInfo
    this.setData({ userName: userInfo ? (userInfo.name || 'Admin') : 'Admin' })
    this._loadTodayEvents()
    this._loadPastEvents()
  },

  async onRefresh() {
    this.setData({ refreshing: true })
    await this._loadTodayEvents()
    this.setData({ refreshing: false })
  },

  _syncTabBar() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().updateTabs()
      this.getTabBar().setData({ selected: 2 })
    }
  },

  switchTab(e) {
    this.setData({ activeTab: Number(e.currentTarget.dataset.index) })
  },

  async _loadTodayEvents() {
    this.setData({ loadingToday: true })
    try {
      const today = new Date()
      const y = today.getFullYear()
      const m = String(today.getMonth() + 1).padStart(2, '0')
      const d = String(today.getDate()).padStart(2, '0')
      const todayStr = y + '-' + m + '-' + d

      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'getEventsWithGuestCounts',
        dateFilter: todayStr,
        mode: 'active'
      })
      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: 'Load failed', icon: 'none' })
        return
      }
      const now = new Date()
      const events = (res.data || []).filter(ev => {
        if (ev.isClosed) return false
        if (ev.date && ev.endTime) {
          try {
            const parts = ev.date.split('-').map(Number)
            const timeParts = ev.endTime.split(':').map(Number)
            const endDt = new Date(parts[0], parts[1] - 1, parts[2], timeParts[0], timeParts[1], 0, 0)
            if (timeParts[0] < 12) endDt.setDate(endDt.getDate() + 1)
            if (!isNaN(endDt.getTime()) && now > endDt) return false
          } catch (_) {}
        }
        return true
      })
      this.setData({ todayEvents: events })
    } catch (err) {
      console.error('[Stats] today events error:', err)
    } finally {
      this.setData({ loadingToday: false })
    }
  },

  async _loadPastEvents() {
    this.setData({ loadingPast: true })
    try {
      const now = new Date()
      if (now.getHours() < 5) now.setDate(now.getDate() - 1)
      const todayStr = now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0')

      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'getEventsWithGuestCounts',
        dateFilter: todayStr,
        mode: 'past'
      })
      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: 'Load failed', icon: 'none' })
        return
      }
      const nowTs = new Date()
      const past = (res.data || []).filter(ev => {
        if (ev.isClosed) return true
        if (ev.date < todayStr) return true
        if (ev.date === todayStr && ev.endTime) {
          try {
            const parts = ev.date.split('-').map(Number)
            const timeParts = ev.endTime.split(':').map(Number)
            const endDt = new Date(parts[0], parts[1] - 1, parts[2], timeParts[0], timeParts[1], 0, 0)
            if (timeParts[0] < 12) endDt.setDate(endDt.getDate() + 1)
            return !isNaN(endDt.getTime()) && nowTs > endDt
          } catch (_) { return false }
        }
        return false
      })
      this.setData({ pastEvents: past })
    } catch (err) {
      console.error('[Stats] past events error:', err)
    } finally {
      this.setData({ loadingPast: false })
    }
  },

  openTodayEvent(e) {
    const id = e.currentTarget.dataset.id
    const event = this.data.todayEvents.find(ev => ev._id === id)
    if (!event) return
    wx.navigateTo({
      url: `/pages/admin/event-guests/event-guests?eventId=${id}&eventTitle=${encodeURIComponent(event.title || '')}&venueName=${encodeURIComponent(event.venueName || '')}`
    })
  },

  openPastEvent(e) {
    const id = e.currentTarget.dataset.id
    const event = this.data.pastEvents.find(ev => ev._id === id)
    if (!event) return
    wx.navigateTo({
      url: `/pages/admin/event-guests/event-guests?eventId=${id}&eventTitle=${encodeURIComponent(event.title || '')}&venueName=${encodeURIComponent(event.venueName || '')}`
    })
  },

  noop() {},

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

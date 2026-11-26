const { callFunction } = require('../../../../utils/request')
const { CLOUD_FUNCTIONS } = require('../../../../utils/constants')
function decode(value) { try { return decodeURIComponent(value || '') } catch (_) { return value || '' } }
Page({
  data: { venueId: '', venueName: '', events: [], offset: 0, hasMore: true, loading: false },
  onLoad(options) {
    if ((getApp().globalData.userInfo || {}).role !== 'admin') { wx.reLaunch({ url: '/pages/register/register' }); return }
    this.setData({ venueId: options.venueId || '', venueName: decode(options.venueName) })
    this.load(true)
  },
  async load(reset) {
    if (this.data.loading || (!reset && !this.data.hasMore)) return
    this.setData({ loading: true })
    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'historyEvents', venueId: this.data.venueId, offset: reset ? 0 : this.data.offset, limit: 20
      })
      if (!res || !res.success) throw new Error('History unavailable')
      this.setData({ events: reset ? res.data : this.data.events.concat(res.data), offset: res.nextOffset, hasMore: res.hasMore })
    } catch (_) { wx.showToast({ title: 'History unavailable', icon: 'none' }) }
    finally { this.setData({ loading: false }) }
  },
  loadMore() { this.load(false) },
  open(e) {
    wx.navigateTo({ url: '/packageAdmin/pages/admin/history-timeline/history-timeline?venueId=' + encodeURIComponent(this.data.venueId)
      + '&venueName=' + encodeURIComponent(this.data.venueName) + '&eventId=' + encodeURIComponent(e.currentTarget.dataset.id)
      + '&eventTitle=' + encodeURIComponent(e.currentTarget.dataset.title) })
  },
  openVenueHistory() {
    wx.navigateTo({ url: '/packageAdmin/pages/admin/history-timeline/history-timeline?venueId=' + encodeURIComponent(this.data.venueId)
      + '&venueName=' + encodeURIComponent(this.data.venueName) })
  },
  openSessions() {
    wx.navigateTo({ url: '/packageAdmin/pages/admin/history-sessions/history-sessions?venueId=' + encodeURIComponent(this.data.venueId) })
  }
})

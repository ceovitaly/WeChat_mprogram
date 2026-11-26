const { callFunction } = require('../../../../utils/request')
const { CLOUD_FUNCTIONS } = require('../../../../utils/constants')
function shanghai(v) {
  const value = v && v.$date !== undefined ? v.$date : v
  const d = new Date(value)
  return isNaN(d.getTime()) ? '—' : new Date(d.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19)
}
Page({
  data: { venueId: '', sessions: [], offset: 0, hasMore: true, loading: false },
  onLoad(options) {
    if ((getApp().globalData.userInfo || {}).role !== 'admin') { wx.reLaunch({ url: '/pages/register/register' }); return }
    this.setData({ venueId: options.venueId || '' })
    this.load(true)
  },
  async load(reset) {
    if (this.data.loading || (!reset && !this.data.hasMore)) return
    this.setData({ loading: true })
    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'historySessions', venueId: this.data.venueId, offset: reset ? 0 : this.data.offset, limit: 20
      })
      if (!res || !res.success) throw new Error('History unavailable')
      const data = (res.data || []).map(s => ({ ...s, startedLabel: shanghai(s.startedAt), endedLabel: shanghai(s.endedAt) }))
      this.setData({ sessions: reset ? data : this.data.sessions.concat(data), offset: res.nextOffset, hasMore: res.hasMore })
    } catch (_) { wx.showToast({ title: 'History unavailable', icon: 'none' }) }
    finally { this.setData({ loading: false }) }
  },
  loadMore() { this.load(false) }
})

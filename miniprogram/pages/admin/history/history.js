const { callFunction } = require('../../../utils/request')
const { CLOUD_FUNCTIONS } = require('../../../utils/constants')
Page({
  data: { venues: [], offset: 0, hasMore: true, loading: false, allowed: false },
  onShow() {
    const user = getApp().globalData.userInfo
    const allowed = !!user && user.role === 'admin'
    this.setData({ allowed })
    if (!allowed) { wx.reLaunch({ url: '/pages/register/register' }); return }
    if (this.getTabBar()) { this.getTabBar().updateTabs(); this.getTabBar().setData({ selected: 3 }) }
    this.load(true)
  },
  async load(reset) {
    if (this.data.loading || (!reset && !this.data.hasMore)) return
    this.setData({ loading: true })
    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'historyVenues', offset: reset ? 0 : this.data.offset, limit: 20
      })
      if (!res || !res.success) throw new Error('History unavailable')
      const venues = (res.data || []).map(v => ({ ...v, photoUrl: typeof v.photo === 'string' && !v.photo.startsWith('cloud://') ? v.photo : '' }))
      const cloudIds = (res.data || []).filter(v => typeof v.photo === 'string' && v.photo.startsWith('cloud://')).map(v => v.photo)
      if (cloudIds.length) {
        const urls = await wx.cloud.getTempFileURL({ fileList: cloudIds }).catch(() => null)
        const map = {}
        ;(urls && urls.fileList || []).forEach(f => { map[f.fileID] = f.tempFileURL })
        venues.forEach(v => { if (map[v.photo]) v.photoUrl = map[v.photo] })
      }
      this.setData({ venues: reset ? venues : this.data.venues.concat(venues), offset: res.nextOffset, hasMore: res.hasMore })
    } catch (_) { wx.showToast({ title: 'History unavailable', icon: 'none' }) }
    finally { this.setData({ loading: false }) }
  },
  loadMore() { this.load(false) },
  open(e) {
    const id = e.currentTarget.dataset.id
    if (id === '__global__') {
      wx.navigateTo({ url: '/packageAdmin/pages/admin/history-timeline/history-timeline?venueId=__global__&venueName=Organisation' })
    } else {
      wx.navigateTo({ url: '/packageAdmin/pages/admin/history-events/history-events?venueId=' + encodeURIComponent(id) + '&venueName=' + encodeURIComponent(e.currentTarget.dataset.name) })
    }
  },
  openSessions() { wx.navigateTo({ url: '/packageAdmin/pages/admin/history-sessions/history-sessions' }) }
})

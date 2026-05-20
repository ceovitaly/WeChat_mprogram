const { callFunction } = require('../../../utils/request')
const { CLOUD_FUNCTIONS } = require('../../../utils/constants')

const PAGE_SIZE = 50

Page({
  data: {
    isLoading: false,
    allGuests: [],
    filteredGuests: [],
    searchQuery: '',
    totalCount: 0,
    page: 0,
    hasMore: true
  },

  onLoad() {
    this._fetchGuests(true)
  },

  onPullDownRefresh() {
    this._fetchGuests(true)
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.isLoading || this.data.searchQuery) return
    this._fetchGuests(false)
  },

  async _fetchGuests(reset) {
    if (this.data.isLoading) return
    this.setData({ isLoading: true })

    const page = reset ? 0 : this.data.page
    const skip = page * PAGE_SIZE

    try {
      const res = await callFunction(
        CLOUD_FUNCTIONS.MANAGE_APPLICATIONS,
        { action: 'getAllGuests', skip, limit: PAGE_SIZE }
      )

      const newGuests = (res && res.data) ? res.data : []
      const total = (res && res.total) ? res.total : 0
      const allGuests = reset ? newGuests : [...this.data.allGuests, ...newGuests]

      this.setData({
        allGuests,
        filteredGuests: allGuests,
        totalCount: total,
        page: page + 1,
        hasMore: newGuests.length === PAGE_SIZE,
        isLoading: false
      })
    } catch (err) {
      console.error('[Guests] fetch error:', err)
      this.setData({ isLoading: false })
      wx.showToast({ title: 'Load failed', icon: 'none' })
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  onSearchInput(e) {
    const searchQuery = e.detail.value
    const q = searchQuery.toLowerCase().trim()
    const filtered = q
      ? this.data.allGuests.filter(g =>
          (g.guestName || '').toLowerCase().includes(q) ||
          (g.promoterName || '').toLowerCase().includes(q) ||
          (g.eventTitle || '').toLowerCase().includes(q)
        )
      : this.data.allGuests

    this.setData({
      searchQuery,
      filteredGuests: filtered,
      totalCount: q ? filtered.length : this.data.allGuests.length
    })
  }
})
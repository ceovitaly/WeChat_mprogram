const { callFunction, collection } = require('../../../utils/request')
const { CLOUD_FUNCTIONS, COLLECTIONS } = require('../../../utils/constants')

Page({
  data: {
    isLoading: false,
    allGuests: [],
    filteredGuests: [],
    searchQuery: '',
    totalCount: 0,

    promoters: [],
    selectedPromoter: '',

    showPromoterSheet: false,
    selectedGuest: null,
  },

  onLoad() {
    this._fetchGuests()
    this._fetchPromoters()
  },

  onPullDownRefresh() {
    this._fetchGuests()
    this._fetchPromoters()
  },

  async _fetchGuests() {
    if (this.data.isLoading) return
    this.setData({ isLoading: true })
    try {
      const res = await callFunction(
        CLOUD_FUNCTIONS.MANAGE_APPLICATIONS,
        { action: 'getAllGuests', skip: 0, limit: 1000 }
      )
      const allGuests = (res && res.data) ? res.data : []
      this.setData({
        allGuests,
        totalCount: allGuests.length,
        isLoading: false
      })
      this._applyFilters()
    } catch (err) {
      console.error('[Guests] fetch error:', err)
      this.setData({ isLoading: false })
      wx.showToast({ title: 'Load failed', icon: 'none' })
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  async _fetchPromoters() {
    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, { action: 'getPromoters' })
      this.setData({ promoters: res && res.data ? res.data : [] })
    } catch (err) {
      console.error('[Guests] promoters error:', err)
    }
  },

  _applyFilters() {
    const { allGuests, searchQuery, selectedPromoter } = this.data
    let result = allGuests
    if (selectedPromoter) {
      result = result.filter(g => g.promoterName === selectedPromoter)
    }
    const q = searchQuery.toLowerCase().trim()
    if (q) {
      result = result.filter(g => (g.nickName || '').toLowerCase().includes(q))
    }
    this.setData({ filteredGuests: result, totalCount: result.length })
  },

  onSearchInput(e) {
    this.setData({ searchQuery: e.detail.value }, () => this._applyFilters())
  },

  selectPromoterFilter(e) {
    const name = e.currentTarget.dataset.name || ''
    this.setData({ selectedPromoter: name }, () => this._applyFilters())
  },

  onGuestTap(e) {
    const id = e.currentTarget.dataset.id
    const guest = this.data.allGuests.find(g => g._id === id)
    if (!guest) return
    this.setData({ showPromoterSheet: true, selectedGuest: guest })
  },

  closePromoterSheet() {
    this.setData({ showPromoterSheet: false, selectedGuest: null })
  },

  async assignPromoter(e) {
    const promoterName = e.currentTarget.dataset.name
    const guest = this.data.selectedGuest
    if (!guest) return

    this.setData({ showPromoterSheet: false })
    wx.showLoading({ title: 'Saving...', mask: true })

    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'updateGuestPromoter',
        guestId: guest._id,
        promoterName
      })
      if (!res || !res.success) throw new Error(res && res.message || 'Failed')

      const allGuests = this.data.allGuests.map(g =>
        g._id === guest._id ? { ...g, promoterName } : g
      )
      this.setData({ allGuests, selectedGuest: null })
      this._applyFilters()
      wx.vibrateShort({ type: 'light' })
      wx.showToast({ title: 'Updated', icon: 'success' })
    } catch (err) {
      console.error('[Guests] assign promoter error:', err)
      wx.showToast({ title: 'Failed', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  noop() {}
})

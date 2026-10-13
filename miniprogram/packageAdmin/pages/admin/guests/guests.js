const { callFunction } = require('../../../../utils/request')
const { CLOUD_FUNCTIONS } = require('../../../../utils/constants')
const { isUnauthorized, handleAuthFailure } = require('../../../../utils/auth')
const { buildInternalRoleMap, annotateInternalRole } = require('../../../../utils/phoneMatch')
const refCache = require('../../../../utils/refCache')
const { openAsXls } = require('../../../../utils/xlsx')

// One page of the roster per request. The roster outgrew the ~1MB
// callFunction reply cap long ago (5000+ guests and growing), so the page
// loads ONE slice at a time (getGuestsPage); search and the promoter filter
// run server-side and therefore cover the WHOLE roster, not just the loaded
// slice. Export walks all pages in a loop — several small replies instead of
// one impossible one.
const PAGE_SIZE = 200

Page({
  data: {
    isLoading: false,
    filteredGuests: [],
    searchQuery: '',
    totalCount: 0,
    pageNum: 1,
    pageCount: 1,

    promoters: [],
    staffList: [],
    selectedPromoterId: '',

    showPromoterSheet: false,
    selectedGuest: null,
  },

  onLoad() {
    this._pageOffset = 0
    this._fetchGuests(true)
    this._fetchPromoters()
    this._fetchStaff()
  },

  // An explicit pull-to-refresh means "give me current data", so the two cached
  // rosters are dropped first and genuinely refetched. Ordinary page entry keeps
  // reading them from the cache.
  onPullDownRefresh() {
    refCache.invalidate(refCache.KEYS.PROMOTERS)
    refCache.invalidate(refCache.KEYS.STAFF)
    this._fetchGuests(true)
    this._fetchPromoters()
    this._fetchStaff()
  },

  // reset=true → back to the first page (fresh entry, new search, chip switch);
  // otherwise keeps the current offset (pager buttons, post-reassign refresh).
  async _fetchGuests(reset) {
    if (this.data.isLoading) return
    if (reset) this._pageOffset = 0
    this.setData({ isLoading: true })
    try {
      const params = {
        action: 'getGuestsPage',
        offset: this._pageOffset,
        limit: PAGE_SIZE,
        search: this.data.searchQuery.trim()
      }
      // '' is the "All" chip — no promoter filter.
      if (this.data.selectedPromoterId) params.promoterId = this.data.selectedPromoterId
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, params)
      if (!res || !res.success) {
        this.setData({ isLoading: false })
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: 'Load failed', icon: 'none' })
        return
      }
      const guests = res.data || []
      const total = res.total || 0
      const roleMap = buildInternalRoleMap(this.data.staffList, this.data.promoters)
      this.setData({
        filteredGuests: guests.map(g => annotateInternalRole(g, roleMap)),
        totalCount: total,
        pageNum: Math.floor(this._pageOffset / PAGE_SIZE) + 1,
        pageCount: Math.max(Math.ceil(total / PAGE_SIZE), 1),
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

  // The promoter roster feeds both the filter chips and the reassignment sheet; the
  // staff roster feeds the internal-role badges. Both are read through the shared
  // reference cache (utils/refCache) rather than refetched on every entry. Still
  // tolerant reads — a failure other than an expired session keeps the current list
  // and the badges just no-op.
  async _fetchPromoters() {
    try {
      const promoters = await refCache.getPromoters()
      this.setData({ promoters })
    } catch (err) {
      if (isUnauthorized(refCache.cloudResponseOf(err))) { handleAuthFailure(); return }
      if (!refCache.isFailedResponse(err)) console.error('[Guests] promoters error:', err)
    }
  },

  async _fetchStaff() {
    try {
      const staffList = await refCache.getStaff()
      this.setData({ staffList })
    } catch (err) {
      if (isUnauthorized(refCache.cloudResponseOf(err))) { handleAuthFailure(); return }
      if (!refCache.isFailedResponse(err)) console.error('[Guests] staff error:', err)
    }
  },

  // Search runs server-side (covers the whole roster), so the input only
  // debounces and refetches the first page of matches.
  onSearchInput(e) {
    this.setData({ searchQuery: e.detail.value })
    if (this._searchTimer) clearTimeout(this._searchTimer)
    this._searchTimer = setTimeout(() => this._fetchGuests(true), 350)
  },

  selectPromoterFilter(e) {
    const id = e.currentTarget.dataset.id || ''
    if (id === this.data.selectedPromoterId) return
    this.setData({ selectedPromoterId: id })
    this._fetchGuests(true)
  },

  prevPage() {
    if (this.data.pageNum <= 1 || this.data.isLoading) return
    this._pageOffset = Math.max(this._pageOffset - PAGE_SIZE, 0)
    this._fetchGuests(false)
  },

  nextPage() {
    if (this.data.pageNum >= this.data.pageCount || this.data.isLoading) return
    this._pageOffset += PAGE_SIZE
    this._fetchGuests(false)
  },

  // Full roster export, all fields, ignoring the current search/promoter
  // filter — "export the whole list" means the whole list, not whatever's on
  // screen. Fetched page by page (1000 per reply) so no single call ever
  // approaches the ~1MB cap, however large the roster grows.
  async exportCSV() {
    if (this._exporting) return
    this._exporting = true
    wx.showLoading({ title: 'Exporting...', mask: true })
    try {
      const roleMap = buildInternalRoleMap(this.data.staffList, this.data.promoters)
      const fmtDate = (d) => {
        if (!d) return ''
        const dt = new Date(d)
        return isNaN(dt) ? '' : dt.toISOString().slice(0, 10)
      }
      const rows = [['Name', 'Phone', 'Promoter', 'Role', 'Registered']]
      const CHUNK = 1000
      for (let offset = 0; offset < 1000000; offset += CHUNK) {
        const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
          action: 'getGuestsPage', offset, limit: CHUNK
        })
        if (!res || !res.success) throw new Error((res && res.message) || 'failed')
        const page = res.data || []
        page.forEach(g => {
          const a = annotateInternalRole(g, roleMap)
          rows.push([
            a.nickName || '',
            a.phone || '',
            a.promoterName || '',
            a.internalLabel || '',
            fmtDate(a.createdAt)
          ])
        })
        if (!res.hasMore) break
      }
      wx.hideLoading()
      openAsXls(rows, 'guests', 'Guests')
    } catch (err) {
      console.error('[Guests] export error:', err)
      wx.hideLoading()
      wx.showToast({ title: 'Export failed', icon: 'none' })
    } finally {
      this._exporting = false
    }
  },

  onGuestTap(e) {
    const id = e.currentTarget.dataset.id
    const guest = this.data.filteredGuests.find(g => g._id === id)
    if (!guest) return
    this.setData({ showPromoterSheet: true, selectedGuest: guest })
  },

  closePromoterSheet() {
    this.setData({ showPromoterSheet: false, selectedGuest: null })
  },

  async assignPromoter(e) {
    const promoterId = e.currentTarget.dataset.id
    const promoterName = e.currentTarget.dataset.name
    const guest = this.data.selectedGuest
    if (!guest) return

    this.setData({ showPromoterSheet: false })
    wx.showLoading({ title: 'Saving...', mask: true })

    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'updateGuestPromoter',
        guestId: guest._id,
        promoterId,
        promoterName
      })
      if (isUnauthorized(res)) { handleAuthFailure(); return }
      if (!res || !res.success) throw new Error(res && res.message || 'Failed')

      wx.vibrateShort({ type: 'light' })
      wx.showToast({ title: 'Updated', icon: 'success' })
      // Refetch the current page: under a promoter filter the row may now
      // belong to a different page, so a server refetch is the honest view.
      this._fetchGuests(false)
    } catch (err) {
      console.error('[Guests] assign promoter error:', err)
      wx.showToast({ title: 'Failed', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  noop() {}
})

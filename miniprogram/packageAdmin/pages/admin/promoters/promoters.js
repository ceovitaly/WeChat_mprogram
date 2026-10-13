const { callFunction } = require('../../../../utils/request')
const { formatDate } = require('../../../../utils/format')
const { isUnauthorized, handleAuthFailure } = require('../../../../utils/auth')
const refCache = require('../../../../utils/refCache')

Page({
  data: {
    promoters: [],
    loading: false,

    // Add modal
    showAddModal: false,
    newName: '',
    newPromoCode: '',
    newPhone: '',

    // Action sheet
    showActionSheet: false,
    selectedPromoter: null,
    editPromoCode: '',
    editName: '',
    editPhone: ''
  },

  onShow() {
    this._fetchPromoters()
  },

  onPullDownRefresh() {
    this._fetchPromoters()
  },

  // This is the promoter *management* screen, so it deliberately bypasses the
  // reference cache and always reads fresh — an admin who just opened it expects
  // current data, and every mutation below is applied locally rather than
  // refetched. The fresh result is pushed into the cache so the read-only
  // consumers (event-guests, guests, counter/work) get the benefit.
  async _fetchPromoters() {
    this.setData({ loading: true })
    try {
      const [promoRes, countsRes] = await Promise.all([
        callFunction('manageApplications', { action: 'getPromoters' }),
        // Per-promoter guest totals without shipping the roster (it outgrew
        // the ~1MB reply cap): a tiny aggregated count from the server.
        // counts keys on promoterId; codeCounts on the UPPER-cased promoCode
        // for legacy rows written before promoterId was stored.
        callFunction('manageApplications', { action: 'getPromoterGuestCounts' }).catch(() => null)
      ])
      if (!promoRes || !promoRes.success) {
        if (isUnauthorized(promoRes)) { handleAuthFailure(); return }
        wx.showToast({ title: 'Load failed', icon: 'none' })
        return
      }
      // Share the fresh roster (raw server shape, not the display-decorated one).
      refCache.set(refCache.KEYS.PROMOTERS, promoRes.data || [])
      const counts = (countsRes && countsRes.counts) || {}
      const codeCounts = (countsRes && countsRes.codeCounts) || {}
      const countGuests = (p) => counts[p._id] ||
        (p.promoCode && codeCounts[p.promoCode.toUpperCase()]) || 0
      const promoters = (promoRes.data || []).map(p => ({
        ...p,
        joinDate: p.createdAt ? formatDate(new Date(p.createdAt)) : '—',
        status: p.status || 'approved',
        avatarLetter: p.name ? p.name[0].toUpperCase() : '?',
        guestCount: countGuests(p)
      }))
      this.setData({ promoters })
    } catch (err) {
      console.error('[Promoters] fetch error:', err)
      wx.showToast({ title: 'Load failed', icon: 'none' })
    } finally {
      this.setData({ loading: false })
      wx.stopPullDownRefresh()
    }
  },

  // ─── Add modal ───────────────────────────────────────────

  openAddModal() {
    this.setData({ showAddModal: true, newName: '', newPromoCode: '', newPhone: '' })
  },

  closeAddModal() {
    this.setData({ showAddModal: false })
  },

  stopPropagation() {},

  onNameInput(e) { this.setData({ newName: e.detail.value }) },

  onPromoCodeInput(e) {
    this.setData({ newPromoCode: e.detail.value.toUpperCase() })
  },

  onPhoneInput(e) { this.setData({ newPhone: e.detail.value }) },

  async createPromoter() {
    const { newName, newPromoCode, newPhone } = this.data

    if (!newName.trim()) {
      wx.showToast({ title: 'Enter name', icon: 'none' })
      return
    }
    if (!newPromoCode.trim()) {
      wx.showToast({ title: 'Enter promo code', icon: 'none' })
      return
    }

    wx.showLoading({ title: 'Creating...', mask: true })
    try {
      const res = await callFunction('manageApplications', {
        action: 'createPromoter',
        name: newName.trim(),
        promoCode: newPromoCode.trim(),
        phone: newPhone.trim()
      })

      if (res.success) {
        refCache.invalidate(refCache.KEYS.PROMOTERS)
        wx.vibrateShort({ type: 'medium' })
        wx.showToast({ title: 'Created!', icon: 'success' })
        this.closeAddModal()
        const newPromoter = {
          _id: res.promoterId,
          name: newName.trim(),
          promoCode: newPromoCode.trim(),
          phone: newPhone.trim(),
          status: 'approved',
          joinDate: formatDate(new Date()),
          avatarLetter: newName.trim()[0].toUpperCase()
        }
        this.setData({ promoters: [newPromoter, ...this.data.promoters] })
      } else if (isUnauthorized(res)) {
        handleAuthFailure()
      } else {
        wx.showToast({ title: (res && res.message) || 'Error', icon: 'none' })
      }
    } catch (err) {
      wx.showToast({ title: 'Error', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  // ─── Action sheet ────────────────────────────────────────

  openActions(e) {
    const id = e.currentTarget.dataset.id
    const promoter = this.data.promoters.find(p => p._id === id)
    if (!promoter) return
    this.setData({
      selectedPromoter: promoter,
      showActionSheet: true,
      editPromoCode: promoter.promoCode || '',
      editName: promoter.name || '',
      editPhone: promoter.phone || ''
    })
  },

  closeActions() {
    this.setData({ showActionSheet: false, selectedPromoter: null, editName: '', editPhone: '' })
  },

  onEditPromoCodeInput(e) {
    this.setData({ editPromoCode: e.detail.value.toUpperCase() })
  },

  onEditNameInput(e) {
    this.setData({ editName: e.detail.value })
  },

  onEditPhoneInput(e) {
    this.setData({ editPhone: e.detail.value })
  },

  async savePromoterInfo() {
    const { selectedPromoter, editName, editPromoCode, editPhone } = this.data

    if (!editName.trim()) {
      wx.showToast({ title: 'Enter name', icon: 'none' })
      return
    }
    if (!editPromoCode.trim()) {
      wx.showToast({ title: 'Enter promo code', icon: 'none' })
      return
    }

    wx.showLoading({ title: 'Saving...', mask: true })
    try {
      const res = await callFunction('manageApplications', {
        action: 'updatePromoter',
        id: selectedPromoter._id,
        name: editName.trim(),
        promoCode: editPromoCode.trim(),
        phone: editPhone.trim()
      })
      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: (res && res.message) || 'Error', icon: 'none' })
        return
      }
      refCache.invalidate(refCache.KEYS.PROMOTERS)
      wx.vibrateShort({ type: 'medium' })
      wx.showToast({ title: 'Saved!', icon: 'success' })
      this.closeActions()
      const updated = this.data.promoters.map(p =>
        p._id === selectedPromoter._id
          ? { ...p, name: editName.trim(), promoCode: editPromoCode.trim(), phone: editPhone.trim(), avatarLetter: editName.trim()[0].toUpperCase() }
          : p
      )
      this.setData({ promoters: updated })
    } catch (err) {
      wx.showToast({ title: 'Error', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  confirmDelete() {
    const { selectedPromoter } = this.data
    if (!selectedPromoter) return

    wx.showModal({
      title: 'Delete promoter?',
      content: `This will permanently delete ${selectedPromoter.name}. This cannot be undone.`,
      confirmColor: '#FF3B30',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      success: ({ confirm }) => {
        if (!confirm) return
        this._deletePromoter(selectedPromoter)
      }
    })
  },

  // Deletes `promoter`. First attempt omits reassignToPromoterId; if the
  // server refuses with requiresReassignment (the promoter still has
  // guests), we confirm UNASSIGNING those guests and retry with '' — the
  // guests stay in the system, just without a promoter.
  async _deletePromoter(promoter, reassignToPromoterId) {
    wx.showLoading({ title: 'Deleting...', mask: true })
    try {
      const payload = { action: 'deletePromoter', id: promoter._id }
      if (reassignToPromoterId !== undefined) payload.reassignToPromoterId = reassignToPromoterId
      const res = await callFunction('manageApplications', payload)

      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        if (res && res.requiresReassignment) {
          this._confirmReassign(promoter, res.affectedCount)
          return
        }
        wx.showToast({ title: (res && res.message) || 'Error', icon: 'none' })
        return
      }
      refCache.invalidate(refCache.KEYS.PROMOTERS)
      wx.vibrateShort({ type: 'medium' })
      const moved = res.reassignedCount || 0
      wx.showToast({
        title: moved > 0 ? `Deleted (${moved} guest${moved === 1 ? '' : 's'} moved)` : 'Deleted',
        icon: moved > 0 ? 'none' : 'success'
      })
      this.closeActions()
      this.setData({
        promoters: this.data.promoters.filter(p => p._id !== promoter._id)
      })
    } catch (err) {
      wx.showToast({ title: 'Error', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  // The promoter has guests. The old flow showed an action-sheet picker, but
  // wx.showActionSheet holds at most 6 items — with 40+ promoters it failed
  // SILENTLY and the delete button appeared to do nothing. Policy instead:
  // guests move to the system promoter THELIST (fallback: unassign, if the
  // system promoter is missing or is itself being deleted).
  _confirmReassign(promoter, affectedCount) {
    wx.hideLoading()
    const theList = this.data.promoters.find(p =>
      (p.promoCode === 'THELIST' || p.name === 'THELIST') && p._id !== promoter._id
    )
    if (theList) {
      wx.showModal({
        title: 'Promoter has guests',
        content: `${affectedCount} guest${affectedCount === 1 ? '' : 's'} registered under ${promoter.name} will be moved to the system promoter THELIST.`,
        confirmColor: '#FF3B30',
        confirmText: 'Delete',
        cancelText: 'Cancel',
        success: ({ confirm }) => {
          if (confirm) this._deletePromoter(promoter, theList._id)
        }
      })
      return
    }
    wx.showModal({
      title: 'Promoter has guests',
      content: `${affectedCount} guest${affectedCount === 1 ? '' : 's'} registered under ${promoter.name}. The system promoter THELIST was not found — delete the promoter and leave them without a promoter?`,
      confirmColor: '#FF3B30',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      success: ({ confirm }) => {
        if (confirm) this._deletePromoter(promoter, '')
      }
    })
  }
})
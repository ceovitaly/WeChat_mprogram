const { callFunction } = require('../../../utils/request')
const { formatDate } = require('../../../utils/format')
const { isUnauthorized, handleAuthFailure } = require('../../../utils/auth')

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

  async _fetchPromoters() {
    this.setData({ loading: true })
    try {
      const res = await callFunction('manageApplications', {
        action: 'getPromoters'
      })
      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: 'Load failed', icon: 'none' })
        return
      }
      const promoters = (res.data || []).map(p => ({
        ...p,
        joinDate: p.createdAt ? formatDate(new Date(p.createdAt)) : '—',
        status: p.status || 'approved',
        avatarLetter: p.name ? p.name[0].toUpperCase() : '?'
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

  async setStatus(e) {
    const { status } = e.currentTarget.dataset
    const { selectedPromoter } = this.data
    if (!selectedPromoter) return

    wx.showLoading({ title: 'Updating...' })
    try {
      const res = await callFunction('manageApplications', {
        action: 'updatePromoterStatus',
        id: selectedPromoter._id,
        status
      })
      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: (res && res.message) || 'Update failed', icon: 'none' })
        return
      }
      wx.vibrateShort({ type: 'medium' })
      wx.showToast({ title: 'Updated!', icon: 'success' })
      this.closeActions()
      const updated = this.data.promoters.map(p =>
        p._id === selectedPromoter._id ? { ...p, status } : p
      )
      this.setData({ promoters: updated })
    } catch (err) {
      wx.showToast({ title: 'Update failed', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  confirmRevoke() {
    const { selectedPromoter } = this.data
    if (!selectedPromoter) return

    wx.showModal({
      title: 'Revoke status?',
      content: `Remove promoter status from ${selectedPromoter.name}?`,
      confirmColor: '#FF3B30',
      confirmText: 'Revoke',
      cancelText: 'Cancel',
      success: async ({ confirm }) => {
        if (!confirm) return
        wx.showLoading({ title: 'Updating...' })
        try {
          const res = await callFunction('manageApplications', {
            action: 'updatePromoterStatus',
            id: selectedPromoter._id,
            status: 'revoked'
          })
          if (!res || !res.success) {
            if (isUnauthorized(res)) { handleAuthFailure(); return }
            wx.showToast({ title: (res && res.message) || 'Error', icon: 'none' })
            return
          }
          wx.vibrateShort({ type: 'medium' })
          wx.showToast({ title: 'Revoked!', icon: 'success' })
          this.closeActions()
          const updated = this.data.promoters.map(p =>
            p._id === selectedPromoter._id ? { ...p, status: 'revoked' } : p
          )
          this.setData({ promoters: updated })
        } catch (err) {
          wx.showToast({ title: 'Error', icon: 'none' })
        } finally {
          wx.hideLoading()
        }
      }
    })
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

  // Deletes `promoter`. `reassignToPromoterId` is omitted on the first attempt;
  // if the server refuses with requiresReassignment, we prompt for a replacement
  // and re-call this with the admin's choice (a promoter _id, or '' to unassign).
  async _deletePromoter(promoter, reassignToPromoterId) {
    wx.showLoading({ title: 'Deleting...', mask: true })
    try {
      const payload = { action: 'deletePromoter', id: promoter._id }
      if (reassignToPromoterId !== undefined) payload.reassignToPromoterId = reassignToPromoterId
      const res = await callFunction('manageApplications', payload)

      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        if (res && res.requiresReassignment) {
          this._promptReassignment(promoter, res.affectedCount)
          return
        }
        wx.showToast({ title: (res && res.message) || 'Error', icon: 'none' })
        return
      }
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

  // Guests reference `promoter` — the deletion was refused. Offer a replacement
  // promoter (or explicit unassignment) before retrying the delete.
  _promptReassignment(promoter, affectedCount) {
    const others = this.data.promoters.filter(p => p._id !== promoter._id)
    const itemList = others.map(p => p.name).concat(['Remove without reassigning'])

    wx.showActionSheet({
      itemList,
      success: ({ tapIndex }) => {
        const reassignToPromoterId = tapIndex < others.length ? others[tapIndex]._id : ''
        this._deletePromoter(promoter, reassignToPromoterId)
      },
      fail: () => {
        // Admin cancelled the action sheet — leave the promoter and its guests untouched.
      }
    })
  }
})
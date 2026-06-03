const { callFunction } = require('../../../utils/request')
const { formatDate } = require('../../../utils/format')

Page({
  data: {
    promoters: [],
    loading: false,

    // Add modal
    showAddModal: false,
    newName: '',
    newPromoCode: '',

    // Action sheet
    showActionSheet: false,
    selectedPromoter: null,
    editPromoCode: '',
    editName: ''
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
    this.setData({ showAddModal: true, newName: '', newPromoCode: '' })
  },

  closeAddModal() {
    this.setData({ showAddModal: false })
  },

  stopPropagation() {},

  onNameInput(e) { this.setData({ newName: e.detail.value }) },

  onPromoCodeInput(e) {
    this.setData({ newPromoCode: e.detail.value.toUpperCase() })
  },

  async createPromoter() {
    const { newName, newPromoCode } = this.data

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
        promoCode: newPromoCode.trim()
      })

      if (res.success) {
        wx.vibrateShort({ type: 'medium' })
        wx.showToast({ title: 'Created!', icon: 'success' })
        this.closeAddModal()
        const newPromoter = {
          _id: res.promoterId,
          name: newName.trim(),
          promoCode: newPromoCode.trim(),
          status: 'approved',
          joinDate: formatDate(new Date()),
          avatarLetter: newName.trim()[0].toUpperCase()
        }
        this.setData({ promoters: [newPromoter, ...this.data.promoters] })
      } else {
        wx.showToast({ title: res.message || 'Error', icon: 'none' })
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
      editName: promoter.name || ''
    })
  },

  closeActions() {
    this.setData({ showActionSheet: false, selectedPromoter: null, editName: '' })
  },

  onEditPromoCodeInput(e) {
    this.setData({ editPromoCode: e.detail.value.toUpperCase() })
  },

  onEditNameInput(e) {
    this.setData({ editName: e.detail.value })
  },

  async savePromoterInfo() {
    const { selectedPromoter, editName, editPromoCode } = this.data

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
        promoCode: editPromoCode.trim()
      })
      if (!res.success) {
        wx.showToast({ title: res.message || 'Error', icon: 'none' })
        return
      }
      wx.vibrateShort({ type: 'medium' })
      wx.showToast({ title: 'Saved!', icon: 'success' })
      this.closeActions()
      const updated = this.data.promoters.map(p =>
        p._id === selectedPromoter._id
          ? { ...p, name: editName.trim(), promoCode: editPromoCode.trim(), avatarLetter: editName.trim()[0].toUpperCase() }
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
      await callFunction('manageApplications', {
        action: 'updatePromoterStatus',
        id: selectedPromoter._id,
        status
      })
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
          await callFunction('manageApplications', {
            action: 'updatePromoterStatus',
            id: selectedPromoter._id,
            status: 'revoked'
          })
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
      success: async ({ confirm }) => {
        if (!confirm) return
        wx.showLoading({ title: 'Deleting...', mask: true })
        try {
          await callFunction('manageApplications', {
            action: 'deletePromoter',
            id: selectedPromoter._id
          })
          wx.vibrateShort({ type: 'medium' })
          wx.showToast({ title: 'Deleted', icon: 'success' })
          this.closeActions()
          this.setData({
            promoters: this.data.promoters.filter(p => p._id !== selectedPromoter._id)
          })
        } catch (err) {
          wx.showToast({ title: 'Error', icon: 'none' })
        } finally {
          wx.hideLoading()
        }
      }
    })
  }
})
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
    editPromoCode: ''
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
        await this._fetchPromoters()
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
    const { promoter } = e.currentTarget.dataset
    this.setData({
      selectedPromoter: promoter,
      showActionSheet: true,
      editPromoCode: promoter.promoCode || ''
    })
  },

  closeActions() {
    this.setData({ showActionSheet: false, selectedPromoter: null })
  },

  onEditPromoCodeInput(e) {
    this.setData({ editPromoCode: e.detail.value.toUpperCase() })
  },

  async savePromoCode() {
    const { selectedPromoter, editPromoCode } = this.data

    if (!editPromoCode.trim()) {
      wx.showToast({ title: 'Enter promo code', icon: 'none' })
      return
    }

    wx.showLoading({ title: 'Saving...', mask: true })
    try {
      await callFunction('manageApplications', {
        action: 'updatePromoterCode',
        id: selectedPromoter._id,
        promoCode: editPromoCode.trim()
      })
      wx.vibrateShort({ type: 'medium' })
      wx.showToast({ title: 'Saved!', icon: 'success' })
      this.closeActions()
      await this._fetchPromoters()
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
      await this._fetchPromoters()
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
          await this._fetchPromoters()
        } catch (err) {
          wx.showToast({ title: 'Error', icon: 'none' })
        } finally {
          wx.hideLoading()
        }
      }
    })
  }
})
const { callFunction } = require('../../../../utils/request')
const { isUnauthorized, handleAuthFailure } = require('../../../../utils/auth')
const refCache = require('../../../../utils/refCache')

Page({
  data: {
    staffList: [],
    loading: false,
    showModal: false,
    tempName: '',
    tempPhone: '',
    tempPassword: '',
    tempRole: 'counter',
    editingId: null
  },

  onShow() {
    this._fetchStaff()
  },

  goBack() {
    wx.navigateBack()
  },

  // Staff *management* screen: always reads fresh rather than through the
  // reference cache (an admin opening it expects current data), and shares what
  // it got so the read-only consumers benefit. Mutations below invalidate the key.
  async _fetchStaff() {
    this.setData({ loading: true })
    try {
      const res = await callFunction('manageStaff', { action: 'getAll' })
      if (res && res.success) {
        refCache.set(refCache.KEYS.STAFF, res.data || [])
        this.setData({ staffList: res.data })
      } else if (isUnauthorized(res)) {
        handleAuthFailure()
      } else {
        wx.showToast({ title: 'Load failed', icon: 'none' })
      }
    } catch (err) {
      console.error('[Staff] fetch error:', err)
      wx.showToast({ title: 'Load failed', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  openCreateModal() {
    this.setData({
      showModal: true,
      tempName: '',
      tempPhone: '',
      tempPassword: '',
      tempRole: 'counter',
      editingId: null
    })
  },

  openEditModal(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.staffList.find(s => s._id === id)
    if (!item) return
    this.setData({
      showModal: true,
      tempName: item.name,
      tempPhone: item.phone || '',
      tempPassword: '',
      tempRole: item.role || 'counter',
      editingId: item._id
    })
  },

  closeModal() {
    this.setData({ showModal: false })
  },

  stopPropagation() {},

  onInputName(e) { this.setData({ tempName: e.detail.value }) },
  onInputPhone(e) { this.setData({ tempPhone: e.detail.value }) },
  onInputPassword(e) { this.setData({ tempPassword: e.detail.value }) },

  selectRole(e) {
    this.setData({ tempRole: e.currentTarget.dataset.role })
  },

  async confirmSave() {
    const { tempName, tempPhone, tempPassword, tempRole, editingId } = this.data

    if (!tempName.trim()) {
      wx.showToast({ title: 'Enter name', icon: 'none' })
      return
    }

    wx.showLoading({ title: 'Saving...', mask: true })

    try {
      if (editingId) {
        const res = await callFunction('manageStaff', {
          action: 'update',
          id: editingId,
          name: tempName.trim(),
          phone: tempPhone.trim(),
          password: tempPassword,
          role: tempRole
        })
        if (!res || !res.success) {
          if (isUnauthorized(res)) { handleAuthFailure(); return }
          wx.showToast({ title: (res && res.message) || 'Save failed', icon: 'none' })
          return
        }
        wx.vibrateShort({ type: 'medium' })
        wx.showToast({ title: 'Saved!', icon: 'success' })
        refCache.invalidate(refCache.KEYS.STAFF)
        this.closeModal()
        const updated = this.data.staffList.map(s =>
          s._id === editingId ? { ...s, name: tempName.trim(), phone: tempPhone.trim(), role: tempRole } : s
        )
        this.setData({ staffList: updated })
      } else {
        const res = await callFunction('manageStaff', {
          action: 'add',
          name: tempName.trim(),
          phone: tempPhone.trim(),
          password: tempPassword,
          role: tempRole
        })
        if (!res || !res.success) {
          if (isUnauthorized(res)) { handleAuthFailure(); return }
          wx.showToast({ title: (res && res.message) || 'Save failed', icon: 'none' })
          return
        }
        wx.vibrateShort({ type: 'medium' })
        wx.showToast({ title: 'Saved!', icon: 'success' })
        refCache.invalidate(refCache.KEYS.STAFF)
        this.closeModal()
        // _fetchStaff re-seeds the cache with the roster including the new member.
        await this._fetchStaff()
        this._showIssuedCredentials(tempName.trim(), res.password)
      }

    } catch (err) {
      console.error('[Staff] save error:', err)
      wx.showToast({ title: 'Save failed', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  _showIssuedCredentials(name, password) {
    if (!password) return
    const credentials = `Login: ${name}\nPassword: ${password}`
    wx.showModal({
      title: 'Counter created',
      content: credentials,
      confirmText: 'Copy',
      cancelText: 'Done',
      success: ({ confirm }) => {
        if (!confirm) return
        wx.setClipboardData({
          data: credentials,
          success: () => wx.showToast({ title: 'Copied!', icon: 'none' })
        })
      }
    })
  },

  confirmDelete(e) {
    const { id, name } = e.currentTarget.dataset
    wx.showModal({
      title: 'Remove staff?',
      content: `Remove access for ${name}?`,
      confirmColor: '#FF3B30',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      success: async ({ confirm }) => {
        if (!confirm) return
        this._deleteById(id)
      }
    })
  },

  deleteEditing() {
    const id = this.data.editingId
    const name = this.data.tempName
    if (!id) return
    wx.showModal({
      title: 'Delete Counter',
      content: `Delete "${name}"?`,
      confirmColor: '#FF3B30',
      confirmText: 'Delete',
      success: (res) => {
        if (res.confirm) {
          this.closeModal()
          this._deleteById(id)
        }
      }
    })
  },

  async _deleteById(id) {
    wx.showLoading({ title: 'Deleting...' })
    try {
      const res = await callFunction('manageStaff', { action: 'delete', id })
      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: (res && res.message) || 'Delete failed', icon: 'none' })
        return
      }
      refCache.invalidate(refCache.KEYS.STAFF)
      wx.vibrateShort({ type: 'medium' })
      wx.showToast({ title: 'Deleted', icon: 'success' })
      const updated = this.data.staffList.filter(s => s._id !== id)
      this.setData({ staffList: updated })
    } catch (err) {
      wx.showToast({ title: 'Error', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  }
})
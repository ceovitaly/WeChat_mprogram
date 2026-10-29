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
    editingId: null,
    passwordVisible: true,
    passwordLoading: false,
    passwordAvailable: false,
    passwordEdited: false,
    passwordMessage: '',
    saving: false,
    keyboardHeight: 0
  },

  onShow() {
    this._pageVisible = true
    this._unloaded = false
    this._fetchStaff()
  },

  onHide() {
    this._pageVisible = false
    this.closeModal()
  },

  onUnload() {
    this._pageVisible = false
    this.closeModal()
    this._unloaded = true
  },

  // Only roster fields belong in page data or the shared reference cache.
  // Older deployments may still return credential fields in getAll.
  _sanitizeStaff(rows) {
    return (Array.isArray(rows) ? rows : []).map(item => ({
      _id: item._id,
      name: item.name || '',
      phone: item.phone || '',
      role: item.role || 'counter'
    }))
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
        const staffList = this._sanitizeStaff(res.data)
        refCache.set(refCache.KEYS.STAFF, staffList)
        if (!this._unloaded) this.setData({ staffList })
      } else if (isUnauthorized(res)) {
        handleAuthFailure()
      } else {
        wx.showToast({ title: 'Load failed', icon: 'none' })
      }
    } catch (err) {
      wx.showToast({ title: 'Load failed', icon: 'none' })
    } finally {
      if (!this._unloaded) this.setData({ loading: false })
    }
  },

  _resetEditor() {
    this._editorVersion = (this._editorVersion || 0) + 1
    this._loadedPassword = ''
    this._passwordEdited = false
    return {
      tempName: '', tempPhone: '', tempPassword: '', tempRole: 'counter',
      editingId: null, passwordVisible: true, passwordLoading: false,
      passwordAvailable: false, passwordEdited: false, passwordMessage: '',
      keyboardHeight: 0
    }
  },

  openCreateModal() {
    if (this._saving) return
    this.setData({ ...this._resetEditor(), showModal: true })
  },

  openEditModal(e) {
    if (this._saving) return
    const id = e.currentTarget.dataset.id
    const item = this.data.staffList.find(s => s._id === id)
    if (!item) return
    this.setData({
      ...this._resetEditor(),
      showModal: true,
      tempName: item.name,
      tempPhone: item.phone || '',
      tempRole: item.role || 'counter',
      editingId: id,
      passwordLoading: true
    })
    this._loadPassword(id, this._editorVersion)
  },

  async _loadPassword(id, version) {
    const isCurrent = () => !this._unloaded && this.data.showModal &&
      this._editorVersion === version && this.data.editingId === id
    try {
      const res = await callFunction('manageStaff', { action: 'getPassword', id })
      if (!isCurrent()) return
      if (res && res.success && res.passwordAvailable === true && typeof res.password === 'string') {
        this._loadedPassword = res.password
        const next = { passwordAvailable: true, passwordMessage: '' }
        // A delayed response must never replace a password the admin is typing.
        if (!this._passwordEdited) next.tempPassword = res.password
        this.setData(next)
      } else if (res && res.success && res.passwordAvailable === false && res.code === 'PASSWORD_NOT_RECOVERABLE') {
        this.setData({
          passwordAvailable: false,
          passwordMessage: 'The current password cannot be displayed. It remains valid. Leave this field unchanged to keep it, or enter a new password.'
        })
      } else {
        this.setData({ passwordMessage: 'Could not load the current password. It will stay unchanged unless you enter a new one.' })
        if (isUnauthorized(res)) handleAuthFailure()
      }
    } catch (err) {
      if (isCurrent()) this.setData({ passwordMessage: 'Could not load the current password. It will stay unchanged unless you enter a new one.' })
    } finally {
      if (isCurrent()) this.setData({ passwordLoading: false })
    }
  },

  retryPassword() {
    if (this._saving || this.data.passwordLoading || !this.data.editingId) return
    const version = this._editorVersion = (this._editorVersion || 0) + 1
    this.setData({ passwordLoading: true })
    this._loadPassword(this.data.editingId, version)
  },

  closeModal() {
    this.setData({ ...this._resetEditor(), showModal: false })
  },

  stopPropagation() {},

  onInputName(e) { if (!this._saving) this.setData({ tempName: e.detail.value }) },
  onInputPhone(e) { if (!this._saving) this.setData({ tempPhone: e.detail.value }) },
  onInputPassword(e) {
    if (this._saving) return
    this._passwordEdited = true
    this.setData({ tempPassword: e.detail.value, passwordEdited: true })
  },

  togglePasswordVisibility() {
    this.setData({ passwordVisible: !this.data.passwordVisible })
  },

  onKeyboardHeightChange(e) {
    if (this.data.showModal) this.setData({ keyboardHeight: Math.max(0, e.detail.height || 0) })
  },

  selectRole(e) {
    if (!this._saving) this.setData({ tempRole: e.currentTarget.dataset.role })
  },

  async confirmSave() {
    if (this._saving || this.data.passwordLoading || !this.data.showModal) return
    const { tempName, tempPhone, tempPassword, tempRole, editingId, passwordAvailable } = this.data
    const passwordChanged = editingId
      ? this._passwordEdited && (passwordAvailable ? tempPassword !== this._loadedPassword : tempPassword !== '')
      : tempPassword !== ''
    if (!tempName.trim()) {
      wx.showToast({ title: 'Enter name', icon: 'none' })
      return
    }
    if (passwordChanged && tempPassword === '') {
      wx.showToast({ title: 'Enter password', icon: 'none' })
      return
    }

    const version = this._editorVersion
    const isCurrent = () => !this._unloaded && this._pageVisible &&
      this.data.showModal && this._editorVersion === version
    const payload = {
      action: editingId ? 'update' : 'add',
      name: tempName.trim(), phone: tempPhone.trim(), role: tempRole
    }
    if (editingId) payload.id = editingId
    // Omit untouched passwords: even a readable current password must not be rehashed.
    if (passwordChanged) payload.password = tempPassword
    this._saving = true
    this.setData({ saving: true })
    wx.showLoading({ title: 'Saving...', mask: true })
    try {
      const res = await callFunction('manageStaff', payload)
      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        if (isCurrent()) wx.showToast({ title: 'Save failed', icon: 'none' })
        return
      }
      refCache.invalidate(refCache.KEYS.STAFF)
      if (editingId && !this._unloaded) {
        this.setData({ staffList: this.data.staffList.map(s => s._id === editingId
          ? { ...s, name: payload.name, phone: payload.phone, role: tempRole } : s) })
      }
      if (!isCurrent()) return
      wx.vibrateShort({ type: 'medium' })
      this.closeModal()
      wx.hideLoading()
      wx.showToast({ title: 'Saved!', icon: 'success' })
      if (!editingId) {
        // Show issued credentials once; never seed them into the public roster.
        this._showIssuedCredentials(payload.name, res.password)
        this._fetchStaff()
      }
    } catch (err) {
      if (isCurrent()) wx.showToast({ title: 'Save failed', icon: 'none' })
    } finally {
      this._saving = false
      if (!this._unloaded) this.setData({ saving: false })
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
    if (this._saving || this.data.passwordLoading) return
    const id = this.data.editingId
    const name = this.data.tempName
    if (!id) return
    wx.showModal({
      title: 'Delete Counter',
      content: `Delete "${name}"?`,
      confirmColor: '#FF3B30',
      confirmText: 'Delete',
      success: (res) => {
        if (res.confirm && !this._saving && this.data.showModal && this.data.editingId === id) {
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
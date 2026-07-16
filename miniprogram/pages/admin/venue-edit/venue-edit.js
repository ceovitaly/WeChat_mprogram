const { callFunction, collection } = require('../../../utils/request')
const { COLLECTIONS, CLOUD_FUNCTIONS } = require('../../../utils/constants')
const { isUnauthorized, handleAuthFailure } = require('../../../utils/auth')

Page({
  data: {
    id: '',
    isEdit: false,
    isProcessing: false,
    name: '',
    password: '',
    address: '',
    latitude: 0,
    longitude: 0
  },

  onLoad(options) {
    this.setData({
      id: options.id || '',
      isEdit: !!options.id
    })
    if (options.id) this._loadVenue(options.id)
  },

  async _loadVenue(id) {
    wx.showLoading({ title: 'Loading...', mask: true })
    try {
      const res = await collection(COLLECTIONS.VENUES).doc(id).get()
      const v = res.data
      this.setData({
        name: v.name || '',
        password: v.password || '',
        address: v.address || '',
        latitude: v.latitude || (v.coordinates && v.coordinates.lat) || 0,
        longitude: v.longitude || (v.coordinates && v.coordinates.lng) || 0
      })
    } catch (err) {
      wx.showToast({ title: 'Load failed', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  onNameInput(e) { this.setData({ name: e.detail.value }) },
  onPasswordInput(e) { this.setData({ password: e.detail.value.toUpperCase() }) },

  chooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          address: res.address || res.name || this.data.address,
          latitude: parseFloat(res.latitude) || 0,
          longitude: parseFloat(res.longitude) || 0
        })
      }
    })
  },

  openInMaps() {
    const { latitude, longitude, address, name } = this.data
    if (!latitude || !longitude) return
    wx.openLocation({
      latitude: latitude,
      longitude: longitude,
      name: name || 'Venue',
      address: address || ''
    })
  },

  async onSave() {
    if (this.data.isProcessing) return

    const { name, password } = this.data
    if (!name.trim()) {
      wx.showToast({ title: 'Name is required', icon: 'none' })
      return
    }
    if (!password.trim()) {
      wx.showToast({ title: 'Password is required', icon: 'none' })
      return
    }

    this.setData({ isProcessing: true })
    wx.showLoading({ title: 'Saving...', mask: true })

    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'saveVenue',
        id: this.data.id || '',
        name: name.trim(),
        password: password.trim(),
        address: this.data.address || '',
        latitude: this.data.latitude || 0,
        longitude: this.data.longitude || 0
      })

      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: (res && res.message) || 'Save failed', icon: 'none' })
        return
      }

      wx.vibrateShort({ type: 'medium' })
      wx.showToast({ title: 'Saved!', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 800)

    } catch (err) {
      console.error('[VenueEdit] save error:', err)
      wx.showToast({ title: 'Save failed', icon: 'none' })
    } finally {
      this.setData({ isProcessing: false })
      wx.hideLoading()
    }
  }
})

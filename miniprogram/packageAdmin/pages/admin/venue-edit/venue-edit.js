const { callFunction } = require('../../../../utils/request')
const { CLOUD_FUNCTIONS } = require('../../../../utils/constants')
const { isUnauthorized, handleAuthFailure } = require('../../../../utils/auth')
const refCache = require('../../../../utils/refCache')

Page({
  data: {
    id: '',
    isEdit: false,
    isProcessing: false,
    name: '',
    password: '',
    address: '',
    latitude: 0,
    longitude: 0,
    // Gallery photos of this venue: [{ fileID, url }] — fileID is stored on
    // the venue doc, url is the temp https link for display.
    gallery: []
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
      // Server-side read — the venues collection is not client-readable.
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, { action: 'getVenues', id })
      if (isUnauthorized(res)) { handleAuthFailure(); return }
      if (!res || !res.success || !(res.data && res.data.length)) {
        wx.showToast({ title: 'Load failed', icon: 'none' })
        return
      }
      const v = res.data[0]
      this.setData({
        name: v.name || '',
        password: v.password || '',
        address: v.address || '',
        latitude: v.latitude || (v.coordinates && v.coordinates.lat) || 0,
        longitude: v.longitude || (v.coordinates && v.coordinates.lng) || 0
      })
      this._loadGalleryUrls(Array.isArray(v.galleryImages) ? v.galleryImages : [])
    } catch (err) {
      wx.showToast({ title: 'Load failed', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  // fileIDs → displayable temp URLs (this app owns the env, so direct
  // wx.cloud.getTempFileURL works; batches of 50 per call).
  async _loadGalleryUrls(fileIDs) {
    if (!fileIDs.length) { this.setData({ gallery: [] }); return }
    try {
      const map = {}
      for (let i = 0; i < fileIDs.length; i += 50) {
        const res = await wx.cloud.getTempFileURL({ fileList: fileIDs.slice(i, i + 50) })
        ;(res.fileList || []).forEach(f => { if (f.tempFileURL) map[f.fileID] = f.tempFileURL })
      }
      this.setData({
        gallery: fileIDs.map(f => ({ fileID: f, url: map[f] || '' }))
      })
    } catch (err) {
      console.error('[VenueEdit] gallery urls failed:', err)
      this.setData({ gallery: fileIDs.map(f => ({ fileID: f, url: '' })) })
    }
  },

  // ─── Venue gallery management ──────────────────────────────
  // Photos upload straight away and are recorded on the venue doc via the
  // updateVenueGallery action — independent of the Save button, which only
  // covers the info fields.
  addGalleryPhotos() {
    if (!this.data.id) return
    wx.chooseMedia({
      count: 9,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => this._uploadGalleryFiles((res.tempFiles || []).map(f => f.tempFilePath))
    })
  },

  async _uploadGalleryFiles(paths) {
    if (!paths.length) return
    wx.showLoading({ title: 'Uploading...', mask: true })
    try {
      const uploaded = []
      for (const p of paths) {
        const ext = (p.match(/\.(\w+)$/) || [null, 'jpg'])[1]
        const cloudPath = `venue-gallery/${this.data.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
        const res = await wx.cloud.uploadFile({ cloudPath, filePath: p })
        if (res && res.fileID) uploaded.push(res.fileID)
      }
      if (!uploaded.length) throw new Error('no files uploaded')
      const saved = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'updateVenueGallery', id: this.data.id, add: uploaded
      })
      if (!saved || !saved.success) throw new Error((saved && saved.message) || 'save failed')
      await this._loadGalleryUrls(saved.galleryImages || [])
      wx.vibrateShort({ type: 'light' })
      wx.showToast({ title: 'Added', icon: 'success' })
    } catch (err) {
      console.error('[VenueEdit] gallery upload failed:', err)
      wx.showToast({ title: 'Upload failed', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  removeGalleryPhoto(e) {
    const i = e.currentTarget.dataset.index
    const item = this.data.gallery[i]
    if (!item) return
    wx.showModal({
      title: 'Delete photo',
      content: 'Remove this photo from the venue gallery?',
      confirmText: 'Delete', confirmColor: '#FF3B30', cancelText: 'Cancel',
      success: async ({ confirm }) => {
        if (!confirm) return
        try {
          const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
            action: 'updateVenueGallery', id: this.data.id, remove: [item.fileID]
          })
          if (!res || !res.success) throw new Error((res && res.message) || 'failed')
          await this._loadGalleryUrls(res.galleryImages || [])
          wx.showToast({ title: 'Removed', icon: 'none' })
        } catch (err) {
          wx.showToast({ title: 'Failed', icon: 'none' })
        }
      }
    })
  },

  previewGalleryPhoto(e) {
    const { url } = e.currentTarget.dataset
    const urls = this.data.gallery.map(g => g.url).filter(Boolean)
    if (!url) return
    wx.previewImage({ current: url, urls: urls.length ? urls : [url] })
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

      // The venue roster just changed — drop the cached list so event-edit's picker
      // and venue-list don't show the pre-edit names.
      refCache.invalidate(refCache.KEYS.VENUES)
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

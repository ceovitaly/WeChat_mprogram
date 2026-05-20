const { collection } = require('../../../utils/request')
const { COLLECTIONS } = require('../../../utils/constants')
const { validateVenue } = require('../../../utils/validator')

Page({
  data: {
    activeTab: 0,
    id: '',
    isEdit: false,
    isProcessing: false,
    name: '',
    type: 'club',
    typeIndex: 0,
    password: '',
    logo: '',
    logoChanged: false,
    phone: '',
    instagram: '',
    wechat: '',
    facebook: '',
    address: '',
    coordinates: null,
    openTime: '21:00',
    closeTime: '04:00',
    workDays: '',
    capacity: '',
    gallery: [],
    newGalleryFiles: [],
    typeOptions: ['Club', 'Bar', 'Restaurant', 'Other']
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
      const typeOptions = ['club', 'bar', 'restaurant', 'other']
      const typeIndex = typeOptions.indexOf(v.type || 'club')
      this.setData({
        name: v.name || '',
        type: v.type || 'club',
        typeIndex: typeIndex >= 0 ? typeIndex : 0,
        password: v.password || '',
        logo: v.logo || '',
        phone: v.phone || '',
        instagram: v.social?.instagram || '',
        wechat: v.social?.wechat || '',
        facebook: v.social?.facebook || '',
        address: v.address || '',
        coordinates: v.coordinates || null,
        openTime: v.openTime || '21:00',
        closeTime: v.closeTime || '04:00',
        workDays: v.workDays || '',
        capacity: v.capacity ? String(v.capacity) : '',
        gallery: v.gallery || []
      })
    } catch (err) {
      wx.showToast({ title: 'Load failed', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  switchTab(e) {
    this.setData({ activeTab: Number(e.currentTarget.dataset.index) })
  },

  onNameInput(e) { this.setData({ name: e.detail.value }) },
  onPasswordInput(e) { this.setData({ password: e.detail.value }) },
  onPhoneInput(e) { this.setData({ phone: e.detail.value }) },
  onInstagramInput(e) { this.setData({ instagram: e.detail.value }) },
  onWechatInput(e) { this.setData({ wechat: e.detail.value }) },
  onFacebookInput(e) { this.setData({ facebook: e.detail.value }) },

  onTypeChange(e) {
    const types = ['club', 'bar', 'restaurant', 'other']
    this.setData({
      typeIndex: Number(e.detail.value),
      type: types[Number(e.detail.value)]
    })
  },

  uploadLogo() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        this.setData({
          logo: res.tempFiles[0].tempFilePath,
          logoChanged: true
        })
      }
    })
  },

  onAddressInput(e) { this.setData({ address: e.detail.value }) },
  onWorkDaysInput(e) { this.setData({ workDays: e.detail.value }) },
  onCapacityInput(e) { this.setData({ capacity: e.detail.value }) },
  onOpenTimeChange(e) { this.setData({ openTime: e.detail.value }) },
  onCloseTimeChange(e) { this.setData({ closeTime: e.detail.value }) },

  chooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          address: res.address || this.data.address,
          coordinates: { lat: res.latitude, lng: res.longitude }
        })
      }
    })
  },

  uploadGallery() {
    const remaining = 9 - this.data.gallery.length
    if (remaining <= 0) {
      wx.showToast({ title: 'Max 9 photos', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        const newFiles = res.tempFiles.map(f => f.tempFilePath)
        this.setData({
          gallery: [...this.data.gallery, ...newFiles],
          newGalleryFiles: [...this.data.newGalleryFiles, ...newFiles]
        })
      }
    })
  },

  removeGalleryPhoto(e) {
    const { index } = e.currentTarget.dataset
    const gallery = [...this.data.gallery]
    const removed = gallery.splice(index, 1)[0]
    const newGalleryFiles = this.data.newGalleryFiles.filter(f => f !== removed)
    this.setData({ gallery, newGalleryFiles })
  },

  previewPhoto(e) {
    const { url } = e.currentTarget.dataset
    wx.previewImage({ current: url, urls: this.data.gallery })
  },

  async _uploadToCloud(tempFilePath, folder) {
    const ext = tempFilePath.split('.').pop() || 'jpg'
    const cloudPath = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
    const fs = wx.getFileSystemManager()
    return new Promise((resolve, reject) => {
      fs.readFile({
        filePath: tempFilePath,
        encoding: 'base64',
        success: async (res) => {
          try {
            const r = await wx.cloud.callFunction({
              name: 'uploadImageDirect',
              data: { fileContent: res.data, path: cloudPath }
            })
            if (r.result?.fileID) resolve(r.result.fileID)
            else reject(new Error('Upload failed'))
          } catch (err) { reject(err) }
        },
        fail: reject
      })
    })
  },

  async onSave() {
    if (this.data.isProcessing) return

    const { name, type, password, id, isEdit } = this.data
    const errors = validateVenue({ name, password, type })
    if (errors.length > 0) {
      wx.showToast({ title: errors[0], icon: 'none' })
      return
    }

    this.setData({ isProcessing: true })
    wx.showLoading({ title: 'Saving...', mask: true })

    try {
      const {
        logo, logoChanged, phone, instagram, wechat, facebook,
        address, coordinates, openTime, closeTime, workDays,
        capacity, gallery, newGalleryFiles
      } = this.data

      let finalLogo = logo
      if (logoChanged && logo && !logo.startsWith('cloud://')) {
        finalLogo = await this._uploadToCloud(logo, 'logos')
      }

      let finalGallery = [...gallery]
      if (newGalleryFiles.length > 0) {
        const uploaded = await Promise.all(
          newGalleryFiles.map(f => this._uploadToCloud(f, 'gallery'))
        )
        finalGallery = gallery.map(g => {
          const idx = newGalleryFiles.indexOf(g)
          return idx >= 0 ? uploaded[idx] : g
        })
      }

      const db = wx.cloud.database()
      const venueData = {
        name: name.trim(),
        type,
        password,
        logo: finalLogo || '',
        phone: phone || '',
        social: {
          instagram: instagram || '',
          wechat: wechat || '',
          facebook: facebook || ''
        },
        address: address || '',
        coordinates: coordinates || null,
        openTime,
        closeTime,
        workDays: workDays || '',
        capacity: capacity ? Number(capacity) : null,
        gallery: finalGallery,
        updatedAt: db.serverDate()
      }

      if (isEdit) {
        await collection(COLLECTIONS.VENUES).doc(id).update({ data: venueData })
      } else {
        await collection(COLLECTIONS.VENUES).add({
          data: { ...venueData, createdAt: db.serverDate() }
        })
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
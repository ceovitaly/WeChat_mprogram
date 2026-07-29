const { collection, callFunction } = require('../../../../utils/request')
const { COLLECTIONS, CLOUD_FUNCTIONS } = require('../../../../utils/constants')
const { isUnauthorized, handleAuthFailure } = require('../../../../utils/auth')
const { validateEvent } = require('../../../../utils/validator')
const refCache = require('../../../../utils/refCache')

Page({
  data: {
    activeTab: 0,
    id: '',
    isEdit: false,
    isProcessing: false,

    images: [],
    imageDisplayUrls: [],

    title: '',
    description: '',
    descPreviewText: '',
    showDescEditor: false,
    editorFormats: {},
    date: '',
    startTime: '22:00',
    endTime: '04:00',

    venues: [],
    venueIndex: -1,
    selectedVenueId: '',
    selectedVenueName: '',

    // Free entry toggle
    hasFreeEntry: true,

    // Paid packages
    hasPaidPackages: false,
    paidPackages: [], // [{ name: '', paymentLink: '' }]

    // Real event fields — persisted by onSave. There is currently no UI for editing
    // them here (the ticket/table modal markup was removed); they round-trip through
    // _loadEvent so saving an event never wipes values set elsewhere.
    tickets: [],
    tables: [],
    bottles: [],

    partyCapacity: '',
    afterPartyCapacity: '',
    lateAfterPartyCapacity: '',
  },

  onLoad(options) {
    this.setData({
      date: options.date || '',
      id: options.id || '',
      isEdit: !!options.id
    })
    this._loadVenues()
    if (options.id) this._loadEvent(options.id)
  },

  // ─── Photos ─────────────────────────────────────────────

  chooseImages() {
    const currentCount = this.data.images.length
    if (currentCount >= 10) {
      wx.showToast({ title: 'Max 10 photos', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: 10 - currentCount,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        const newPaths = res.tempFiles.map(f => f.tempFilePath)
        this.setData({
          images: [...this.data.images, ...newPaths],
          imageDisplayUrls: [...this.data.imageDisplayUrls, ...newPaths]
        })
      }
    })
  },

  removeImage(e) {
    const { index } = e.currentTarget.dataset
    const images = [...this.data.images]
    const imageDisplayUrls = [...this.data.imageDisplayUrls]
    images.splice(index, 1)
    imageDisplayUrls.splice(index, 1)
    this.setData({ images, imageDisplayUrls })
  },

  // ─── Data Loading ────────────────────────────────────────

  // Venues come from the shared reference cache (utils/refCache) — the same list
  // is read by venue-list and rarely changes, so re-entering this page normally
  // costs no cloud request at all. Failure handling is unchanged: the cache's
  // loader rejects on a non-success response and the original response is
  // recovered here, so unauthorized still logs out and any other failure still
  // toasts exactly as before.
  async _loadVenues() {
    try {
      const venues = await refCache.getVenues()
      this.setData({ venues })
    } catch (err) {
      if (isUnauthorized(refCache.cloudResponseOf(err))) { handleAuthFailure(); return }
      if (refCache.isFailedResponse(err)) {
        wx.showToast({ title: 'Venues load failed', icon: 'none' })
        return
      }
      console.error('[EventEdit] venues error:', err)
    }
  },

  async _loadEvent(id) {
    wx.showLoading({ title: 'Loading...', mask: true })
    try {
      const res = await collection(COLLECTIONS.EVENTS).doc(id).get()
      const e = res.data
      const venueIndex = this.data.venues.findIndex(v => v._id === e.venueId)

      let initialImages = []
      if (e.images && e.images.length > 0) {
        initialImages = e.images
      } else if (e.coverImage) {
        initialImages = [e.coverImage]
      }

      // Resolve cloud:// URLs server-side (works for all admins, not just uploader)
      const cloudIds = initialImages.filter(u => u.startsWith('cloud://'))
      let displayUrls = [...initialImages]
      if (cloudIds.length > 0) {
        try {
          const resolved = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
            action: 'getTempFileURLs',
            fileList: cloudIds
          })
          if (isUnauthorized(resolved)) { handleAuthFailure(); return }
          const urlMap = (resolved && resolved.urlMap) || {}
          displayUrls = initialImages.map(u => urlMap[u] || u)
        } catch (e2) {
          console.warn('[EventEdit] getTempFileURLs failed:', e2)
        }
      }

      this.setData({
        title: e.title || '',
        description: e.description || '',
        descPreviewText: this._stripHtml(e.description || ''),
        date: e.date || '',
        startTime: e.startTime || '22:00',
        endTime: e.endTime || '04:00',
        images: initialImages,
        imageDisplayUrls: displayUrls,
        selectedVenueId: e.venueId || '',
        selectedVenueName: e.venueName || '',
        venueIndex: venueIndex >= 0 ? venueIndex : -1,
        hasFreeEntry: e.hasFreeEntry || false,
        hasPaidPackages: e.hasPaidPackages || false,
        paidPackages: e.paidPackages || [],
        tickets: e.tickets || [],
        tables: e.tables || [],
        bottles: e.bottles || [],
        partyCapacity: e.partyCapacity != null ? String(e.partyCapacity) : '',
        afterPartyCapacity: e.afterPartyCapacity != null ? String(e.afterPartyCapacity) : '',
        lateAfterPartyCapacity: e.lateAfterPartyCapacity != null ? String(e.lateAfterPartyCapacity) : '',
      })
    } catch (err) {
      wx.showToast({ title: 'Load failed', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  // ─── General ─────────────────────────────────────────────

  switchTab(e) {
    this.setData({ activeTab: Number(e.currentTarget.dataset.index) })
  },

  onTitleInput(e) { this.setData({ title: e.detail.value }) },
  onDateChange(e) { this.setData({ date: e.detail.value }) },
  onStartTimeChange(e) { this.setData({ startTime: e.detail.value }) },
  onEndTimeChange(e) { this.setData({ endTime: e.detail.value }) },

  onPartyCapInput(e) { this.setData({ partyCapacity: e.detail.value }) },
  onAfterPartyCapInput(e) { this.setData({ afterPartyCapacity: e.detail.value }) },
  onLateAfterPartyCapInput(e) { this.setData({ lateAfterPartyCapacity: e.detail.value }) },

  onVenueChange(e) {
    const index = e.detail.value
    const venue = this.data.venues[index]
    if (!venue) return
    this.setData({
      venueIndex: index,
      selectedVenueId: venue._id,
      selectedVenueName: venue.name
    })
  },

  // ─── Packages Tab ────────────────────────────────────────

  toggleFreeEntry(e) {
    this.setData({ hasFreeEntry: e.detail.value })
  },

  togglePaidPackages(e) {
    const val = e.detail.value
    this.setData({
      hasPaidPackages: val,
      paidPackages: val && this.data.paidPackages.length === 0
        ? [{ name: '', paymentLink: '' }]
        : this.data.paidPackages
    })
  },

  onPaidPackageInput(e) {
    const { index, field } = e.currentTarget.dataset
    const paidPackages = [...this.data.paidPackages]
    paidPackages[index][field] = e.detail.value
    this.setData({ paidPackages })
  },

  addPaidPackage() {
    const paidPackages = [...this.data.paidPackages, { name: '', paymentLink: '' }]
    this.setData({ paidPackages })
  },

  removePaidPackage(e) {
    const { index } = e.currentTarget.dataset
    const paidPackages = this.data.paidPackages.filter((_, i) => i !== index)
    this.setData({ paidPackages })
  },

  // ─── Description Editor ──────────────────────────────────

  _stripHtml(html) {
    return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  },

  openDescEditor() {
    this.setData({ showDescEditor: true })
  },

  onEditorReady() {
    const query = wx.createSelectorQuery().in(this)
    query.select('#descEditor').context((res) => {
      this._descEditorCtx = res.context
      this._descEditorCtx.setContents({ html: this.data.description || '' })
    }).exec()
  },

  onEditorStatusChange(e) {
    // bindstatuschange fires on every cursor/selection move, not just on an
    // actual format toggle — calling setData unconditionally here re-renders
    // the toolbar (and, it turns out, appears to jostle the keyboard/focus
    // state of the native <editor> component) on every single cursor
    // movement. Only touch data when the format flags we actually care
    // about have changed, so simply moving the cursor through plain text
    // no longer triggers any re-render at all.
    var next = e.detail || {}
    var prev = this.data.editorFormats || {}
    var keys = ['bold', 'italic', 'header', 'list']
    var changed = false
    for (var i = 0; i < keys.length; i++) {
      if (prev[keys[i]] !== next[keys[i]]) {
        changed = true
        break
      }
    }
    if (changed) this.setData({ editorFormats: next })
  },

  onFormatBold() {
    if (this._descEditorCtx) this._descEditorCtx.format('bold')
  },

  onFormatItalic() {
    if (this._descEditorCtx) this._descEditorCtx.format('italic')
  },

  onFormatHeader() {
    if (this._descEditorCtx) this._descEditorCtx.format('header', 2)
  },

  onFormatBulletList() {
    if (this._descEditorCtx) this._descEditorCtx.format('list', 'bullet')
  },

  closeDescEditor() {
    this.setData({ showDescEditor: false })
    this._descEditorCtx = null
  },

  saveDescEditor() {
    if (!this._descEditorCtx) {
      this.closeDescEditor()
      return
    }
    this._descEditorCtx.getContents({
      success: (res) => {
        this.setData({
          description: res.html,
          descPreviewText: this._stripHtml(res.html),
          showDescEditor: false
        })
        this._descEditorCtx = null
      }
    })
  },

  noop() {},

  // ─── Save ────────────────────────────────────────────────

  async onSave() {
    if (this.data.isProcessing) return

    const {
      title, date, startTime, endTime, description,
      selectedVenueId, selectedVenueName,
      images, tickets, tables, bottles,
      hasFreeEntry, hasPaidPackages, paidPackages,
      partyCapacity, afterPartyCapacity, lateAfterPartyCapacity,
      id, isEdit
    } = this.data

    const errors = validateEvent({ title, venueId: selectedVenueId, date, startTime })
    if (errors.length > 0) {
      wx.showToast({ title: errors[0], icon: 'none' }); return
    }

    this.setData({ isProcessing: true })
    wx.showLoading({ title: 'Saving...', mask: true })

    try {
      const uploadPromises = images.map(path => {
        if (path.startsWith('cloud://')) return Promise.resolve(path)
        return this._uploadToCloud(path, 'events')
      })

      const finalImages = await Promise.all(uploadPromises)

      const eventData = {
        title: title.trim(),
        description: description || '',
        date,
        startTime,
        endTime,
        venueId: selectedVenueId,
        venueName: selectedVenueName,
        images: finalImages,
        promoImages: finalImages,
        coverImage: finalImages[0] || '',
        hasFreeEntry,
        hasPaidPackages,
        paidPackages: hasPaidPackages ? paidPackages : [],
        isFree: hasFreeEntry,
        isPaid: hasPaidPackages,
        tickets,
        tables,
        bottles,
        partyCapacity: Number(partyCapacity) || 0,
        afterPartyCapacity: Number(afterPartyCapacity) || 0,
        lateAfterPartyCapacity: Number(lateAfterPartyCapacity) || 0,
      }

      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'saveEvent',
        id: isEdit ? id : null,
        eventData
      })
      if (isUnauthorized(res)) { handleAuthFailure(); return }
      if (!res || !res.success) throw new Error(res && res.message || 'Save failed')

      wx.vibrateShort({ type: 'medium' })
      wx.showToast({ title: 'Saved!', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 800)

    } catch (err) {
      console.error('[EventEdit] save error:', err)
      wx.showToast({ title: 'Save failed', icon: 'none' })
    } finally {
      this.setData({ isProcessing: false })
      wx.hideLoading()
    }
  },

  async _uploadToCloud(tempFilePath, folder) {
    const ext = tempFilePath.split('.').pop() || 'jpg'
    const cloudPath = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
    const res = await wx.cloud.uploadFile({ cloudPath, filePath: tempFilePath })
    return res.fileID
  },

  onCancel() {
    wx.navigateBack()
  }
})
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
    externalLink: '',
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
    freeTicketsLimit: '',
    freeUntil: '',

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
    // No total cap by design — up to 20 per pick, and the admin can keep
    // adding more in another round.
    wx.chooseMedia({
      count: 20,
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
        externalLink: e.externalLink || '',
        descPreviewText: this._stripHtml(e.description || ''),
        date: e.date || '',
        startTime: e.startTime || '22:00',
        endTime: e.endTime || '04:00',
        images: initialImages,
        imageDisplayUrls: displayUrls,
        selectedVenueId: e.venueId || '',
        selectedVenueName: e.venueName || '',
        venueIndex: venueIndex >= 0 ? venueIndex : -1,
        hasFreeEntry: e.hasFreeEntry !== false,
        freeTicketsLimit: e.freeTicketsLimit || '',
        freeUntil: e.freeUntil || '',
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
  onExternalLinkInput(e) { this.setData({ externalLink: e.detail.value }) },
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

  onFreeLimitInput(e) {
    this.setData({ freeTicketsLimit: e.detail.value })
  },

  // "Free entry until" — after this moment (night rule applies server-side:
  // a time before noon belongs to the morning after) only paid tickets
  // remain. Empty = free all night.
  onFreeUntilChange(e) {
    this.setData({ freeUntil: e.detail.value })
  },

  togglePaidPackages(e) {
    const val = e.detail.value
    this.setData({
      hasPaidPackages: val,
      paidPackages: val && this.data.paidPackages.length === 0
        ? [{ name: '', description: '', price: '' }]
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
    const paidPackages = [...this.data.paidPackages, { name: '', description: '', price: '', quantity: '' }]
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
    // Reset the seed flag so the existing description is loaded fresh each open.
    this._descSeeded = false
    this.setData({ showDescEditor: true })
    // bindready re-fires each open (the bottom-sheet uses wx:if, so the <editor>
    // is rebuilt every time), but on real devices setContents from the ready
    // callback can race the editor's init and silently no-op — which is why an
    // existing description opened an empty editor. Seed again here, retrying
    // briefly until the context is ready.
    this._seedDescEditor()
  },

  onEditorReady() {
    const query = wx.createSelectorQuery().in(this)
    query.select('#descEditor').context((res) => {
      this._descEditorCtx = res.context
      this._seedDescEditor()
    }).exec()
  },

  // Push the current description into the editor exactly once per open.
  // _descSeeded guarantees a single apply (the first moment the context exists),
  // so a late retry can never wipe text the user has already started typing.
  // Bounded retries so it can never spin forever.
  _seedDescEditor(retries) {
    if (retries === undefined) retries = 0
    if (this._descEditorCtx && !this._descSeeded) {
      this._descSeeded = true
      this._descEditorCtx.setContents({ html: this.data.description || '' })
    } else if (!this._descEditorCtx && retries < 12) {
      setTimeout(() => this._seedDescEditor(retries + 1), 50)
    }
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

  // Tap anywhere on the form background dismisses the keyboard. When the
  // user taps another input, iOS re-focuses it after hideKeyboard runs,
  // so this doesn't interfere with moving between fields.
  dismissKeyboard() {
    wx.hideKeyboard({ fail() {} })
  },

  // ─── Save ────────────────────────────────────────────────

  async onSave() {
    if (this.data.isProcessing) return

    const {
      title, date, startTime, endTime, description, externalLink,
      selectedVenueId, selectedVenueName,
      images, tickets, tables, bottles,
      hasFreeEntry, hasPaidPackages, paidPackages: paidPackagesRaw,
      freeTicketsLimit,
      freeUntil,
      partyCapacity, afterPartyCapacity, lateAfterPartyCapacity,
      id, isEdit
    } = this.data

    const errors = validateEvent({ title, venueId: selectedVenueId, date, startTime })
    if (errors.length > 0) {
      wx.showToast({ title: errors[0], icon: 'none' }); return
    }

    const normalizedExternalLink = (externalLink || '').trim()
    if (normalizedExternalLink && !/^https?:\/\/\S+$/i.test(normalizedExternalLink)) {
      wx.showToast({ title: 'Link must start with http:// or https://', icon: 'none' }); return
    }

    // Entry mode: at least one of free entry / paid tickets must be on.
    // With free entry off, paid tickets are the only way in — so there must
    // be at least one named ticket and every one of them needs a price.
    const validPkgs = (hasPaidPackages ? paidPackagesRaw : []).filter(p => (p.name || '').trim())
    if (!hasFreeEntry && !hasPaidPackages) {
      wx.showToast({ title: 'Enable free entry or paid tickets', icon: 'none' }); return
    }
    if (!hasFreeEntry && validPkgs.length === 0) {
      wx.showToast({ title: 'Add at least one paid ticket', icon: 'none' }); return
    }
    if (!hasFreeEntry && validPkgs.some(p => !(Number(p.price) > 0))) {
      wx.showToast({ title: 'Every ticket needs a price', icon: 'none' }); return
    }

    this.setData({ isProcessing: true })
    wx.showLoading({ title: 'Saving...', mask: true })

    try {
      const uploadPromises = images.map(path => {
        if (path.startsWith('cloud://')) return Promise.resolve(path)
        return this._uploadToCloud(path, 'events')
      })

      const finalImages = await Promise.all(uploadPromises)

      // Paid tickets: each row gets a stable id on first save (orders
      // reference it; index-based ids would break on reorder/delete) and a
      // numeric price — >0 means in-app WeChat Pay. The ticket card only
      // edits name/description/price; quantity and paymentLink (legacy
      // external-link flow) are passed through untouched if an old event
      // already has them.
      const paidPackages = (hasPaidPackages ? paidPackagesRaw : [])
        .map(p => ({
          id: p.id || ('pkg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
          name: (p.name || '').trim(),
          description: (p.description || '').trim(),
          price: Number(p.price) || 0,
          quantity: p.quantity || 0,
          paymentLink: (p.paymentLink || '').trim()
        }))
        .filter(p => p.name)

      const eventData = {
        title: title.trim(),
        description: description || '',
        externalLink: normalizedExternalLink,
        date,
        startTime,
        endTime,
        venueId: selectedVenueId,
        venueName: selectedVenueName,
        images: finalImages,
        promoImages: finalImages,
        coverImage: finalImages[0] || '',
        hasFreeEntry,
        freeTicketsLimit: Number(freeTicketsLimit) || 0, // 0 = unlimited
        freeUntil: freeUntil || '', // '' = free all night
        hasPaidPackages,
        paidPackages,
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
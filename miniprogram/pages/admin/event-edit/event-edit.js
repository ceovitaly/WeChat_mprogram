const { collection, callFunction } = require('../../../utils/request')
const { COLLECTIONS, CLOUD_FUNCTIONS } = require('../../../utils/constants')
const { isUnauthorized, handleAuthFailure } = require('../../../utils/auth')
const { validateEvent } = require('../../../utils/validator')

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

    tickets: [],
    tables: [],
    bottles: [],

    showTicketForm: false,
    ticketForm: { name: '', price: '', capacity: '', description: '' },
    editTicketIndex: -1,

    showTableForm: false,
    tableForm: { name: '', deposit: '', capacity: '', description: '' },
    editTableIndex: -1,

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

  async _loadVenues() {
    try {
      const res = await collection(COLLECTIONS.VENUES).get()
      this.setData({ venues: res.data || [] })
    } catch (err) {
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
  onDescInput(e) { this.setData({ description: e.detail.value }) },
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

  // ─── Tickets ─────────────────────────────────────────────

  openTicketForm(e) {
    const index = e.currentTarget.dataset.index
    if (index !== undefined) {
      this.setData({ showTicketForm: true, editTicketIndex: index, ticketForm: { ...this.data.tickets[index] } })
    } else {
      this.setData({ showTicketForm: true, editTicketIndex: -1, ticketForm: { name: '', price: '', capacity: '', description: '' } })
    }
  },
  closeTicketForm() { this.setData({ showTicketForm: false }) },
  onTicketInput(e) {
    const { field } = e.currentTarget.dataset
    this.setData({ [`ticketForm.${field}`]: e.detail.value })
  },
  saveTicket() {
    const { ticketForm, tickets, editTicketIndex } = this.data
    if (!ticketForm.name || !ticketForm.price) {
      wx.showToast({ title: 'Name & price required', icon: 'none' }); return
    }
    const ticket = {
      id: editTicketIndex >= 0 ? tickets[editTicketIndex].id : `t_${Date.now()}`,
      name: ticketForm.name,
      price: Number(ticketForm.price),
      capacity: ticketForm.capacity ? Number(ticketForm.capacity) : null,
      description: ticketForm.description || ''
    }
    const updated = [...tickets]
    if (editTicketIndex >= 0) updated[editTicketIndex] = ticket
    else updated.push(ticket)
    this.setData({ tickets: updated, showTicketForm: false })
    wx.vibrateShort({ type: 'light' })
  },
  removeTicket(e) {
    const { index } = e.currentTarget.dataset
    this.setData({ tickets: this.data.tickets.filter((_, i) => i !== index) })
  },

  // ─── Tables ──────────────────────────────────────────────

  openTableForm(e) {
    const index = e.currentTarget.dataset.index
    if (index !== undefined) {
      this.setData({ showTableForm: true, editTableIndex: index, tableForm: { ...this.data.tables[index] } })
    } else {
      this.setData({ showTableForm: true, editTableIndex: -1, tableForm: { name: '', deposit: '', capacity: '', description: '' } })
    }
  },
  closeTableForm() { this.setData({ showTableForm: false }) },
  onTableInput(e) {
    const { field } = e.currentTarget.dataset
    this.setData({ [`tableForm.${field}`]: e.detail.value })
  },
  saveTable() {
    const { tableForm, tables, editTableIndex } = this.data
    if (!tableForm.name || !tableForm.deposit) {
      wx.showToast({ title: 'Name & deposit required', icon: 'none' }); return
    }
    const table = {
      id: editTableIndex >= 0 ? tables[editTableIndex].id : `tb_${Date.now()}`,
      name: tableForm.name,
      deposit: Number(tableForm.deposit),
      capacity: tableForm.capacity ? Number(tableForm.capacity) : null,
      description: tableForm.description || ''
    }
    const updated = [...tables]
    if (editTableIndex >= 0) updated[editTableIndex] = table
    else updated.push(table)
    this.setData({ tables: updated, showTableForm: false })
    wx.vibrateShort({ type: 'light' })
  },
  removeTable(e) {
    const { index } = e.currentTarget.dataset
    this.setData({ tables: this.data.tables.filter((_, i) => i !== index) })
  },

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
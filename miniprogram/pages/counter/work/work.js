const app = getApp()
const { callFunction, collection } = require('../../../utils/request')
const { COLLECTIONS, CLOUD_FUNCTIONS } = require('../../../utils/constants')

Page({
  data: {
    step: 'venue',
    clubCode: '',
    venueName: '',
    currentVenueId: '',
    events: [],
    currentEvent: null,
    guests: [],
    filteredGuests: [],
    arrivedGuests: [],
    filteredArrivedGuests: [],
    arrivedSections: [],
    filteredArrivedSections: [],
    totalExpected: 0,
    promoterNames: [],
    searchQuery: '',
    selectedPromoter: '',
    isLoading: false,
    staffName: '',
    staffId: '',
    isOnDuty: false
  },

  onLoad() {
    this._checkingIn = new Set()
  },

  onShow() {
    this._syncTabBar()
    this._restoreSession()
  },

  _syncTabBar() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().updateTabs()
      this.getTabBar().setData({ selected: 0 })
    }
  },

  _restoreSession() {
    const user = app.globalData.userInfo || wx.getStorageSync('staffUser')
    const staffName = user ? (user.name || '') : ''
    const staffId = user ? (user._id || '') : ''
    const savedId = wx.getStorageSync('currentVenueId')
    const savedName = wx.getStorageSync('currentVenueName')
    const savedEvent = wx.getStorageSync('currentEvent')
    this.setData({ staffName, staffId })
    if (savedId && savedEvent) {
      const savedDuty = !!wx.getStorageSync('isOnDuty')
      this.setData({ step: 'guests', venueName: savedName, currentVenueId: savedId, currentEvent: savedEvent, isOnDuty: savedDuty })
      this._fetchGuests(savedEvent._id)
      if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ hidden: true })
    } else if (savedId) {
      this.setData({ step: 'event', venueName: savedName, currentVenueId: savedId })
      this._fetchEvents(savedId)
    }
  },

  // ─── Step 1 ───────────────────────────────────────────────

  onCodeInput(e) { this.setData({ clubCode: e.detail.value.toUpperCase() }) },

  async enterVenue() {
    const code = this.data.clubCode.trim()
    if (!code) { wx.showToast({ title: 'Enter password', icon: 'none' }); return }
    wx.showLoading({ title: 'Verifying...', mask: true })
    try {
      const res = await collection(COLLECTIONS.VENUES).where({ password: code }).get()
      if (res.data && res.data.length > 0) {
        const venue = res.data[0]
        wx.setStorageSync('currentVenueId', venue._id)
        wx.setStorageSync('currentVenueName', venue.name)
        this.setData({ step: 'event', venueName: venue.name, currentVenueId: venue._id, clubCode: '' })
        this._fetchEvents(venue._id)
      } else {
        wx.showToast({ title: 'Invalid password', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: 'Connection error', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  leaveVenue() {
    wx.showModal({
      title: 'Exit venue', content: 'Finish session and exit?',
      confirmText: 'Exit', confirmColor: '#FF3B30', cancelText: 'Cancel',
      success: ({ confirm }) => {
        if (!confirm) return
        wx.removeStorageSync('currentVenueId')
        wx.removeStorageSync('currentVenueName')
        wx.removeStorageSync('currentEvent')
        wx.removeStorageSync('isOnDuty')
        if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ hidden: false })
        const { staffId } = this.data
        if (staffId) {
          callFunction(CLOUD_FUNCTIONS.MANAGE_STAFF, { action: 'setDutyStatus', staffId, isOnDuty: false }).catch(() => {})
        }
        this.setData({
          step: 'venue', venueName: '', currentVenueId: '', currentEvent: null,
          events: [], guests: [], filteredGuests: [], arrivedGuests: [], totalExpected: 0, isOnDuty: false
        })
      }
    })
  },

  async toggleDuty() {
    const { isOnDuty, staffId, currentEvent } = this.data
    const newDuty = !isOnDuty
    this.setData({ isOnDuty: newDuty })
    if (newDuty) {
      wx.setStorageSync('isOnDuty', true)
    } else {
      wx.removeStorageSync('isOnDuty')
    }
    if (!staffId) return
    try {
      await callFunction(CLOUD_FUNCTIONS.MANAGE_STAFF, {
        action: 'setDutyStatus',
        staffId,
        isOnDuty: newDuty,
        eventId: currentEvent ? currentEvent._id : '',
        eventTitle: currentEvent ? currentEvent.title : ''
      })
    } catch (e) {}
  },

  // ─── Step 2 ───────────────────────────────────────────────

  async _fetchEvents(venueId) {
    this.setData({ isLoading: true })
    try {
      const venueRes = await collection(COLLECTIONS.VENUES).doc(venueId).get()
      const venueName = venueRes.data.name
      const now = new Date()
      if (now.getHours() < 5) now.setDate(now.getDate() - 1)
      const today = now.toISOString().split('T')[0]
      const eventRes = await collection(COLLECTIONS.EVENTS).where({ venueName }).orderBy('date', 'asc').get()
      this.setData({ events: eventRes.data.filter(e => e.date >= today), isLoading: false })
    } catch (e) {
      this.setData({ isLoading: false })
    }
  },

  selectEvent(e) {
    const { event } = e.currentTarget.dataset
    wx.setStorageSync('currentEvent', event)
    const isOnDuty = !!wx.getStorageSync('isOnDuty')
    this.setData({ step: 'guests', currentEvent: event, searchQuery: '', selectedPromoter: '', isOnDuty })
    this._fetchGuests(event._id)
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ hidden: true })
    const { staffId } = this.data
    if (isOnDuty && staffId) {
      callFunction(CLOUD_FUNCTIONS.MANAGE_STAFF, {
        action: 'setDutyStatus', staffId, isOnDuty: true,
        eventId: event._id, eventTitle: event.title
      }).catch(() => {})
    }
  },

  backToEvents() {
    wx.removeStorageSync('currentEvent')
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ hidden: false })
    this.setData({ step: 'event', currentEvent: null, guests: [], filteredGuests: [], arrivedGuests: [], totalExpected: 0 })
    this._fetchEvents(this.data.currentVenueId)
  },

  // ─── Step 3 ───────────────────────────────────────────────

  async _fetchGuests(eventId) {
    this.setData({ isLoading: true })
    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, { action: 'getRegistrations', eventId })
      this._buildState(res.data || [])
    } catch (e) {
      this.setData({ isLoading: false })
    }
  },

  _buildSections(arrivedList, p, ap, lap) {
    const sectionDefs = [
      { label: 'Party', tag: 'P' },
      { label: 'After Party', tag: 'AP' },
      { label: 'Late After Party', tag: 'LAP' },
      { label: 'Extra', tag: '' }
    ]
    const buckets = {}
    sectionDefs.forEach(s => { buckets[s.tag] = [] })
    arrivedList.forEach(g => {
      const tag = g.group !== undefined ? g.group : ''
      if (buckets[tag] !== undefined) buckets[tag].push(g)
      else buckets[''].push(g)
    })
    return sectionDefs
      .filter(s => buckets[s.tag].length > 0)
      .map(s => ({
        label: s.label,
        tag: s.tag,
        guests: buckets[s.tag].slice().sort((a, b) => a.arrivalNumber - b.arrivalNumber)
      }))
  },

  _buildState(raw) {
    const ev = this.data.currentEvent || {}
    const p = Number(ev.partyCapacity) || 0
    const ap = Number(ev.afterPartyCapacity) || 0
    const lap = Number(ev.lateAfterPartyCapacity) || 0
    const groupOrder = { 'P': 0, 'AP': 1, 'LAP': 2, '': 3 }
    const arrivedGuests = raw
      .filter(g => g.arrivedAt)
      .sort((a, b) => (a.arrivedAt < b.arrivedAt ? -1 : 1))
      .map((g, i) => {
        const num = i + 1
        let group = ''
        if (p > 0 && num <= p) group = 'P'
        else if (ap > 0 && num <= p + ap) group = 'AP'
        else if (lap > 0 && num <= p + ap + lap) group = 'LAP'
        return { ...g, arrivalNumber: num, group }
      })
      .sort((a, b) => (groupOrder[a.group] ?? 3) - (groupOrder[b.group] ?? 3))

    const arrivedSections = this._buildSections(arrivedGuests, p, ap, lap)

    const pending = raw.filter(g => !g.arrivedAt)
    const map = {}
    pending.forEach(g => {
      const key = g.promoterName || '__none__'
      if (!map[key]) map[key] = { promoterName: g.promoterName || null, guests: [] }
      map[key].guests.push(g)
    })
    const guests = Object.values(map).sort((a, b) => {
      if (!a.promoterName) return 1
      if (!b.promoterName) return -1
      return a.promoterName.localeCompare(b.promoterName)
    })

    const names = [...new Set(raw.filter(g => g.promoterName).map(g => g.promoterName))].sort()

    this.setData({ guests, filteredGuests: guests, arrivedGuests, filteredArrivedGuests: arrivedGuests, arrivedSections, filteredArrivedSections: arrivedSections, totalExpected: raw.length, promoterNames: names, isLoading: false })
  },

  filterPromoter(e) {
    const name = e.currentTarget.dataset.name
    this.setData({ selectedPromoter: name })
    this._applyFilter(this.data.searchQuery, name)
  },

  onSearchInput(e) {
    this.setData({ searchQuery: e.detail.value })
    this._applyFilter(e.detail.value, this.data.selectedPromoter)
  },

  _applyFilter(query, promoter) {
    const q = (query || '').toLowerCase().trim()
    let list = this.data.guests
    if (promoter) list = list.filter(g => g.promoterName === promoter)
    if (q) list = list.map(g => ({ ...g, guests: g.guests.filter(gg => (gg.guestName || '').toLowerCase().includes(q)) })).filter(g => g.guests.length > 0)

    let arrivedList = this.data.arrivedGuests
    if (promoter) arrivedList = arrivedList.filter(g => g.promoterName === promoter)
    if (q) arrivedList = arrivedList.filter(g => (g.guestName || '').toLowerCase().includes(q))

    const ev = this.data.currentEvent || {}
    const p = Number(ev.partyCapacity) || 0
    const ap = Number(ev.afterPartyCapacity) || 0
    const lap = Number(ev.lateAfterPartyCapacity) || 0
    const filteredArrivedSections = this._buildSections(arrivedList, p, ap, lap)

    this.setData({ filteredGuests: list, filteredArrivedGuests: arrivedList, filteredArrivedSections })
  },

  async checkIn(e) {
    const { id, pindex, gindex } = e.currentTarget.dataset
    if (this._checkingIn.has(id)) return
    if (this.data.currentEvent && this.data.currentEvent.isClosed) {
      wx.showToast({ title: 'Event is closed', icon: 'none' })
      return
    }
    // Also block if event's end time has passed
    const ev = this.data.currentEvent || {}
    if (ev.date && ev.endTime) {
      try {
        const parts = ev.date.split('-').map(Number)
        const timeParts = ev.endTime.split(':').map(Number)
        const endDt = new Date(parts[0], parts[1] - 1, parts[2], timeParts[0], timeParts[1], 0, 0)
        if (timeParts[0] < 12) endDt.setDate(endDt.getDate() + 1)
        if (!isNaN(endDt.getTime()) && new Date() > endDt) {
          wx.showToast({ title: 'Event is closed', icon: 'none' })
          return
        }
      } catch (_) {}
    }
    const group = this.data.filteredGuests[pindex]
    if (!group) return
    const guest = group.guests[gindex]
    if (!guest) return

    this._checkingIn.add(id)
    const now = new Date()
    const arrivedAt = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

    try {
      const res = await callFunction(CLOUD_FUNCTIONS.CHECK_IN_GUEST, { registrationId: id, arrivedAt })
      if (!res || !res.success) { wx.showToast({ title: 'Error', icon: 'none' }); return }

      const remove = arr => arr.map(g => ({ ...g, guests: g.guests.filter(gg => gg._id !== id) })).filter(g => g.guests.length > 0)

      const ev = this.data.currentEvent || {}
      const p = Number(ev.partyCapacity) || 0
      const ap = Number(ev.afterPartyCapacity) || 0
      const lap = Number(ev.lateAfterPartyCapacity) || 0

      const newArrived = [...this.data.arrivedGuests, { ...guest, arrivedAt }]
        .sort((a, b) => (a.arrivedAt < b.arrivedAt ? -1 : 1))
        .map((g, i) => {
          const num = i + 1
          let group = ''
          if (p > 0 && num <= p) group = 'P'
          else if (ap > 0 && num <= p + ap) group = 'AP'
          else if (lap > 0 && num <= p + ap + lap) group = 'LAP'
          return { ...g, arrivalNumber: num, group }
        })

      const arrivedSections = this._buildSections(newArrived, p, ap, lap)

      this.setData({ guests: remove(this.data.guests), filteredGuests: remove(this.data.filteredGuests), arrivedGuests: newArrived, arrivedSections })
      this._applyFilter(this.data.searchQuery, this.data.selectedPromoter)
      wx.vibrateShort({ type: 'medium' })
    } catch (e) {
      wx.showToast({ title: 'Error', icon: 'none' })
    } finally {
      this._checkingIn.delete(id)
    }
  },

  confirmUncheck(e) {
    const { id, name } = e.currentTarget.dataset
    wx.showModal({
      title: 'Remove arrival',
      content: `Remove "${name}" from arrived?`,
      confirmText: 'Remove', confirmColor: '#FF3B30', cancelText: 'Cancel',
      success: ({ confirm }) => { if (confirm) this._doUncheck(id) }
    })
  },

  async _doUncheck(id) {
    try {
      await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, { action: 'uncheckGuest', registrationId: id })
      const guest = this.data.arrivedGuests.find(g => g._id === id)
      if (!guest) return

      const pendingGuest = { _id: guest._id, guestName: guest.guestName, promoterName: guest.promoterName || null }

      const ev = this.data.currentEvent || {}
      const p = Number(ev.partyCapacity) || 0
      const ap = Number(ev.afterPartyCapacity) || 0
      const lap = Number(ev.lateAfterPartyCapacity) || 0

      const arrivedGuests = this.data.arrivedGuests
        .filter(g => g._id !== id)
        .sort((a, b) => (a.arrivedAt < b.arrivedAt ? -1 : 1))
        .map((g, i) => {
          const num = i + 1
          let group = ''
          if (p > 0 && num <= p) group = 'P'
          else if (ap > 0 && num <= p + ap) group = 'AP'
          else if (lap > 0 && num <= p + ap + lap) group = 'LAP'
          return { ...g, arrivalNumber: num, group }
        })

      let guests = this.data.guests.map(g => ({ ...g, guests: [...g.guests] }))
      const grp = guests.find(g => g.promoterName === pendingGuest.promoterName)
      if (grp) {
        grp.guests.push(pendingGuest)
      } else {
        guests.push({ promoterName: pendingGuest.promoterName, guests: [pendingGuest] })
        guests.sort((a, b) => { if (!a.promoterName) return 1; if (!b.promoterName) return -1; return a.promoterName.localeCompare(b.promoterName) })
      }

      const arrivedSections = this._buildSections(arrivedGuests, p, ap, lap)

      this.setData({ arrivedGuests, arrivedSections, guests })
      this._applyFilter(this.data.searchQuery, this.data.selectedPromoter)
      wx.showToast({ title: 'Removed', icon: 'none' })
    } catch (e) {
      wx.showToast({ title: 'Error', icon: 'none' })
    }
  },

  confirmCloseEvent() {
    const { currentEvent, staffName } = this.data;
    if (!currentEvent) return;
    wx.showModal({
      title: 'Close Event',
      content: `Generate final attendance report for "${currentEvent.title}"?`,
      confirmText: 'Close Event',
      confirmColor: '#FF3B30',
      cancelText: 'Cancel',
      success: async ({ confirm }) => {
        if (!confirm) return;
        wx.showLoading({ title: 'Saving report...', mask: true });
        try {
          const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
            action: 'closeEvent',
            eventId: currentEvent._id,
            closedBy: staffName
          });
          wx.hideLoading();
          if (res.success) {
            wx.vibrateShort({ type: 'medium' });
            wx.showToast({ title: 'Report saved!', icon: 'success' });
            setTimeout(() => this.backToEvents(), 1500);
          } else {
            wx.showToast({ title: res.message || 'Error', icon: 'none' });
          }
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: 'Error', icon: 'none' });
        }
      }
    });
  },

  confirmLogout() {
    wx.showModal({
      title: 'Log out', content: 'Log out from account?',
      confirmText: 'Log out', confirmColor: '#FF3B30', cancelText: 'Cancel',
      success: ({ confirm }) => { if (confirm) getApp().logout() }
    })
  },

  onShareAppMessage() {
    return {
      title: 'Yue! Admin',
      path: '/pages/counter/work/work'
    }
  }
})

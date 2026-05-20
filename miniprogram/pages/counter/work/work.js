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
    totalExpected: 0,
    guestTab: 'promoter',
    searchQuery: '',
    isLoading: false,
    staffName: ''
  },

  onLoad() {},

  onShow() {
    this._syncTabBar()
    this._restoreSession()
  },

  onPullDownRefresh() {
    const { step, currentVenueId, currentEvent } = this.data
    if (step === 'guests' && currentEvent) {
      this._fetchGuests(currentEvent._id)
    } else if (step === 'event' && currentVenueId) {
      this._fetchEvents(currentVenueId)
    } else {
      wx.stopPullDownRefresh()
    }
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
    const savedId = wx.getStorageSync('currentVenueId')
    const savedName = wx.getStorageSync('currentVenueName')
    const savedEvent = wx.getStorageSync('currentEvent')

    this.setData({ staffName })

    if (savedId && savedEvent) {
      this.setData({
        step: 'guests',
        venueName: savedName,
        currentVenueId: savedId,
        currentEvent: savedEvent
      })
      this._fetchGuests(savedEvent._id)
    } else if (savedId) {
      this.setData({
        step: 'event',
        venueName: savedName,
        currentVenueId: savedId
      })
      this._fetchEvents(savedId)
    }
  },

  // ─── Step 1: Venue ───────────────────────────────────────

  onCodeInput(e) {
    this.setData({ clubCode: e.detail.value })
  },

  async enterVenue() {
    const code = this.data.clubCode.trim()
    if (!code) {
      wx.showToast({ title: 'Enter password', icon: 'none' })
      return
    }

    wx.showLoading({ title: 'Verifying...', mask: true })
    try {
      const res = await collection(COLLECTIONS.VENUES)
        .where({ password: code })
        .get()

      if (res.data && res.data.length > 0) {
        const venue = res.data[0]
        wx.setStorageSync('currentVenueId', venue._id)
        wx.setStorageSync('currentVenueName', venue.name)
        this.setData({
          step: 'event',
          venueName: venue.name,
          currentVenueId: venue._id,
          clubCode: ''
        })
        this._fetchEvents(venue._id)
      } else {
        wx.showToast({ title: 'Invalid password', icon: 'none' })
      }
    } catch (err) {
      console.error('[Work] enter venue error:', err)
      wx.showToast({ title: 'Connection error', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  leaveVenue() {
    wx.showModal({
      title: 'Exit venue',
      content: 'Finish session and exit?',
      confirmText: 'Exit',
      confirmColor: '#FF3B30',
      cancelText: 'Cancel',
      success: ({ confirm }) => {
        if (!confirm) return
        wx.removeStorageSync('currentVenueId')
        wx.removeStorageSync('currentVenueName')
        wx.removeStorageSync('currentEvent')
        this.setData({
          step: 'venue',
          venueName: '',
          currentVenueId: '',
          currentEvent: null,
          events: [],
          guests: [],
          filteredGuests: [],
          arrivedGuests: [],
          totalExpected: 0
        })
      }
    })
  },

  // ─── Step 2: Events ──────────────────────────────────────

  async _fetchEvents(venueId) {
    this.setData({ isLoading: true })
    try {
      const venueRes = await collection(COLLECTIONS.VENUES).doc(venueId).get()
      const venueName = venueRes.data.name

      const now = new Date()
      if (now.getHours() < 9) now.setDate(now.getDate() - 1)
      const today = now.toISOString().split('T')[0]

      const eventRes = await collection(COLLECTIONS.EVENTS)
        .where({ venueName })
        .orderBy('date', 'asc')
        .get()

      const events = eventRes.data.filter(e => e.date >= today)
      this.setData({ events, isLoading: false })
    } catch (err) {
      console.error('[Work] fetch events error:', err)
      this.setData({ isLoading: false })
    }
  },

  selectEvent(e) {
    const { event } = e.currentTarget.dataset
    wx.setStorageSync('currentEvent', event)
    this.setData({
      step: 'guests',
      currentEvent: event,
      guestTab: 'promoter',
      searchQuery: ''
    })
    this._fetchGuests(event._id)
  },

  backToEvents() {
    wx.removeStorageSync('currentEvent')
    this.setData({
      step: 'event',
      currentEvent: null,
      guests: [],
      filteredGuests: [],
      arrivedGuests: [],
      totalExpected: 0
    })
    this._fetchEvents(this.data.currentVenueId)
  },

  // ─── Step 3: Guests ──────────────────────────────────────

  async _fetchGuests(eventId) {
    this.setData({ isLoading: true })
    try {
      const res = await callFunction(
        CLOUD_FUNCTIONS.MANAGE_APPLICATIONS,
        { action: 'getRegistrations', eventId }
      )
      const raw = res.data || []

      const totalExpected = raw.length

      const promoterMap = {}
      const grouped = []
      raw.forEach(guest => {
        const key = guest.promoterName || '__none__'
        if (!promoterMap[key]) {
          promoterMap[key] = {
            promoterName: guest.promoterName || null,
            guests: []
          }
          grouped.push(promoterMap[key])
        }
        promoterMap[key].guests.push(guest)
      })

      grouped.sort((a, b) => {
        if (!a.promoterName) return 1
        if (!b.promoterName) return -1
        return a.promoterName.localeCompare(b.promoterName)
      })

      const arrived = raw
        .filter(g => g.arrivedAt)
        .sort((a, b) => a.arrivedAt < b.arrivedAt ? -1 : 1)
        .map((g, i) => ({ ...g, arrivalNumber: i + 1 }))

      this.setData({
        guests: grouped,
        filteredGuests: grouped,
        arrivedGuests: arrived,
        totalExpected,
        isLoading: false
      })
    } catch (err) {
      console.error('[Work] fetch guests error:', err)
      this.setData({ isLoading: false })
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  switchGuestTab(e) {
    const { tab } = e.currentTarget.dataset
    this.setData({ guestTab: tab, searchQuery: '' })
    if (tab === 'promoter') {
      this.setData({ filteredGuests: this.data.guests })
    }
  },

  onSearchInput(e) {
    const searchQuery = e.detail.value
    this.setData({ searchQuery })
    this._applySearch(searchQuery)
  },

  _applySearch(query) {
    const q = (query || '').toLowerCase().trim()
    if (!q) {
      this.setData({ filteredGuests: this.data.guests })
      return
    }
    const filtered = this.data.guests
      .map(group => ({
        ...group,
        guests: group.guests.filter(g =>
          (g.guestName || '').toLowerCase().includes(q)
        )
      }))
      .filter(group => group.guests.length > 0)
    this.setData({ filteredGuests: filtered })
  },

  async checkIn(e) {
    const { id, pindex, gindex } = e.currentTarget.dataset
    const group = this.data.filteredGuests[pindex]
    if (!group) return
    const guest = group.guests[gindex]
    if (!guest || guest.arrivedAt) return

    const now = new Date()
    const arrivedAt = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

    try {
      const res = await callFunction(CLOUD_FUNCTIONS.CHECK_IN_GUEST, {
        registrationId: id,
        arrivedAt
      })

      if (res && res.success) {
        const filteredGuests = this.data.filteredGuests
        filteredGuests[pindex].guests[gindex].arrivedAt = arrivedAt

        const guests = this.data.guests
        const masterGroup = guests.find(g => g.promoterName === group.promoterName)
        if (masterGroup) {
          const masterGuest = masterGroup.guests.find(g => g._id === id)
          if (masterGuest) masterGuest.arrivedAt = arrivedAt
        }

        const arrivedGuests = [...this.data.arrivedGuests, {
          ...filteredGuests[pindex].guests[gindex],
          arrivalNumber: this.data.arrivedGuests.length + 1
        }]

        this.setData({ guests, filteredGuests, arrivedGuests })
        wx.vibrateShort({ type: 'medium' })
        wx.showToast({ title: 'Checked in!', icon: 'success' })
      }
    } catch (err) {
      console.error('[Work] check-in error:', err)
      wx.showToast({ title: 'Error', icon: 'none' })
    }
  },

  confirmLogout() {
    wx.showModal({
      title: 'Log out',
      content: 'Log out from account?',
      confirmText: 'Log out',
      confirmColor: '#FF3B30',
      cancelText: 'Cancel',
      success: ({ confirm }) => {
        if (confirm) getApp().logout()
      }
    })
  }
})
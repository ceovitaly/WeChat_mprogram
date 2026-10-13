const { callFunction } = require('../../../utils/request')
const { CLOUD_FUNCTIONS } = require('../../../utils/constants')
const { isUnauthorized, handleAuthFailure } = require('../../../utils/auth')
const { businessToday } = require('../../../utils/format')

// Past events — moved verbatim from the old Stats tab's Past section
// (same query, same isClosed/date/end-time filtering).
Page({
  data: {
    loading: false,
    allPastEvents: [],
    pastEvents: [],
    selectedDate: '',
    todayDate: ''
  },

  onShow() {
    this.setData({ todayDate: businessToday() })
    this._loadPastEvents()
  },

  async _loadPastEvents() {
    this.setData({ loading: true })
    try {
      const todayStr = businessToday()

      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'getEventsWithGuestCounts',
        dateFilter: todayStr,
        mode: 'past'
      })
      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: 'Load failed', icon: 'none' })
        return
      }
      const nowTs = new Date()
      const past = (res.data || []).filter(ev => {
        if (ev.isClosed) return true
        if (ev.date < todayStr) return true
        if (ev.date === todayStr && ev.endTime) {
          try {
            const parts = ev.date.split('-').map(Number)
            const timeParts = ev.endTime.split(':').map(Number)
            const endDt = new Date(parts[0], parts[1] - 1, parts[2], timeParts[0], timeParts[1], 0, 0)
            if (timeParts[0] < 12) endDt.setDate(endDt.getDate() + 1)
            return !isNaN(endDt.getTime()) && nowTs > endDt
          } catch (_) { return false }
        }
        return false
      })
      this.setData({ allPastEvents: past })
      this._applyDateFilter()
    } catch (err) {
      console.error('[PastEvents] load error:', err)
    } finally {
      this.setData({ loading: false })
    }
  },

  onDateChange(e) {
    this.setData({ selectedDate: e.detail.value })
    this._applyDateFilter()
  },

  clearDateFilter() {
    this.setData({ selectedDate: '' })
    this._applyDateFilter()
  },

  _applyDateFilter() {
    const selectedDate = this.data.selectedDate
    const events = this.data.allPastEvents || []
    this.setData({
      pastEvents: selectedDate
        ? events.filter(event => event.date === selectedDate)
        : events
    })
  },

  openPastEvent(e) {
    const id = e.currentTarget.dataset.id
    const event = this.data.pastEvents.find(ev => ev._id === id)
    if (!event) return
    // closed=1 lets the page render its past-event view from the FIRST
    // frame — without it the page briefly loads as an active event and then
    // re-flips after the server round-trip.
    wx.navigateTo({
      url: `/packageAdmin/pages/admin/event-guests/event-guests?eventId=${id}&closed=1&eventTitle=${encodeURIComponent(event.title || '')}&venueName=${encodeURIComponent(event.venueName || '')}`
    })
  },
})

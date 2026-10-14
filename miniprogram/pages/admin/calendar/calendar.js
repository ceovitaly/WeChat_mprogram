const { callFunction } = require('../../../utils/request')
const { CLOUD_FUNCTIONS } = require('../../../utils/constants')
const { isUnauthorized, handleAuthFailure } = require('../../../utils/auth')
const { hasEnded } = require('../../../utils/format')

// Plain LOCAL calendar date, YYYY-MM-DD. Not toISOString — that shifts by timezone.
const localToday = (now) => {
  const d = now ? new Date(now) : new Date()
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

Page({
  data: {
    monthName: '',
    currMonth: 0,
    currYear: 0,
    calendarDays: [],
    selectedDate: '',
    selectedDateLabel: '',
    events: [],
    filteredEvents: [],
    calendarVisible: false,
    loading: false,
    refreshing: false,
    // Custom dots refresher (guest-app feed mechanic, admin blue) — see the
    // WXML slot and onRefresherPulling below.
    refresherThreshold: 50, // px; corrected from the status bar in onLoad
    dotStyles: ['', '', ''],

    pickerVisible: false,
    pickerMonthIndex: 0,
    monthNames: MONTH_NAMES,

    // Swipe-to-delete state (one open card at a time): swipeId = the card
    // being dragged/revealed, swipeX = its current px offset, swiping =
    // finger still down (transition disabled while dragging).
    swipeId: '',
    swipeX: 0,
    swiping: false
  },

  onLoad() {
    const info = (wx.getWindowInfo && wx.getWindowInfo()) || {}
    this.setData({ refresherThreshold: (info.statusBarHeight || 20) + 20 })
    // Delete-button width in px (its wxss width is 160rpx) — the swipe offset
    // math needs real pixels for the transform.
    this._delW = Math.round((info.windowWidth || 375) / 750 * 160)
    this._applyToday(() => {
      this._updateCalendar()
    })
  },

  onShow() {
    this._syncTabBar()
    // The page can sit backgrounded across midnight, leaving a stale selected date next
    // to freshly fetched events. Re-derive ONLY when the calendar day actually rolled
    // over, so a date the admin deliberately picked is never clobbered.
    if (localToday() !== this._today) {
      this._applyToday(() => {
        this._updateCalendar()
        this._fetchEvents()
      })
      return
    }
    this._fetchEvents()
  },

  // Point the grid + selection at today and remember which day that was (on the
  // instance, not in data — it's bookkeeping, nothing renders it). Year/month/day all
  // come from the SAME date string, so the grid and the selection can't land on
  // different months.
  _applyToday(done) {
    const selectedDate = localToday()
    this._today = selectedDate
    const [y, m, d] = selectedDate.split('-').map(Number)
    this.setData({
      currYear: y,
      currMonth: m - 1,
      selectedDate,
      selectedDateLabel: this._formatLabel(new Date(y, m - 1, d))
    }, done)
  },

  _syncTabBar() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().updateTabs()
      this.getTabBar().setData({ selected: 0 })
    }
  },

  _formatDate(y, m, d) {
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  },

  _formatLabel(date) {
    const dayName = DAY_NAMES[date.getDay()]
    const d = date.getDate()
    const month = MONTH_NAMES[date.getMonth()]
    return `${dayName}, ${d} ${month}`
  },

  _updateCalendar() {
    const { currYear: y, currMonth: m } = this.data
    const firstDay = new Date(y, m, 1).getDay()
    const startOffset = firstDay === 0 ? 6 : firstDay - 1
    const daysInMonth = new Date(y, m + 1, 0).getDate()

    const days = []
    for (let i = 0; i < startOffset; i++) {
      days.push({ day: '', fullDate: '' })
    }
    for (let i = 1; i <= daysInMonth; i++) {
      days.push({
        day: i,
        fullDate: this._formatDate(y, m + 1, i)
      })
    }
    this.setData({
      calendarDays: days,
      monthName: MONTH_NAMES[m]
    })
  },

  async _fetchEvents() {
    // Silent refresh: the "Loading..." state only appears on the very first
    // load. onShow fires on EVERY tab switch, and wiping the list to a
    // loading placeholder there read as the screen flickering.
    this.setData({ loading: !this._loadedOnce })
    this._loadedOnce = true
    wx.showNavigationBarLoading()
    try {
      const { currYear, currMonth } = this.data
      const fromDate = new Date(currYear, currMonth - 3, 1)
      const toDate = new Date(currYear, currMonth + 4, 0)
      const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
      // Server-side: a client-issued query is capped at 20 docs regardless of .limit(),
      // which over this ~7 month ascending window kept the OLDEST events and dropped
      // today's entirely. The cloud function gets the real 1000 limit.
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'getEvents',
        dateFrom: fmt(fromDate),
        dateTo: fmt(toDate)
      })
      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: 'Load failed', icon: 'none' })
        return
      }
      this.setData({ events: res.data || [] }, () => this._filterEvents())
    } catch (err) {
      console.error('[Calendar] fetch error:', err)
      wx.showToast({ title: 'Load failed', icon: 'none' })
    } finally {
      this.setData({ loading: false })
      wx.hideNavigationBarLoading()
    }
  },

  _filterEvents() {
    const { events, selectedDate } = this.data
    const now = new Date()
    const today = localToday(now)
    // Browsing a PAST date is schedule history — show everything on that date, ended or
    // not, or the history reads as empty. Today and later hide ended events instead.
    const isPast = selectedDate < today
    const filtered = events
      .filter(e => {
        if (isPast) return e.date === selectedDate
        if (hasEnded(e, now)) return false
        // Still-running events dated EARLIER bleed into today only — that's what keeps a
        // 22:00→04:00 event from yesterday on screen at 01:00. Not when browsing other dates.
        if (selectedDate === today && e.date < selectedDate) return true
        return e.date === selectedDate
      })
      .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''))
    this.setData({ filteredEvents: filtered })
  },

  async onRefresh() {
    // The dots' pre-trigger progress styles no longer matter once the bounce
    // animation (refresh-dot-active) takes over; reset so nothing lingers.
    this.setData({ dotStyles: ['', '', ''] })
    await this._fetchEvents()
    this.setData({ refreshing: false })
  },

  // Fires continuously while the user drags down, before the refresh
  // triggers: each dot's scale/opacity grows with the pull distance in
  // staggered bands, so the dots pop in one by one (same feel as the guest
  // app's feed).
  onRefresherPulling(e) {
    if (this.data.refreshing) return // bounce animation already owns the dots
    const dy = (e.detail && e.detail.dy) || 0
    const threshold = this.data.refresherThreshold || 50
    let progress = dy / threshold
    if (progress < 0) progress = 0
    if (progress > 1) progress = 1
    const bands = [[0, 0.6], [0.2, 0.8], [0.4, 1.0]]
    const styles = bands.map(band => {
      let p = (progress - band[0]) / (band[1] - band[0])
      if (p < 0) p = 0
      if (p > 1) p = 1
      const scale = (0.4 + p * 0.6).toFixed(3)
      const opacity = (0.25 + p * 0.75).toFixed(3)
      return 'transform: scale(' + scale + '); opacity: ' + opacity + ';'
    })
    this.setData({ dotStyles: styles })
  },

  // Released before crossing the threshold — snap the dots back to baseline.
  onRefresherRestore() {
    this.setData({ dotStyles: ['', '', ''] })
  },

  selectDate(e) {
    const { date } = e.currentTarget.dataset
    if (!date) return
    const d = new Date(date)
    this.setData({
      selectedDate: date,
      selectedDateLabel: this._formatLabel(d),
      currMonth: d.getMonth(),
      currYear: d.getFullYear(),
      calendarVisible: false
    }, () => {
      this._filterEvents()
    })
  },

  toggleCalendar() {
    this.setData({ calendarVisible: !this.data.calendarVisible })
  },

  openPicker() {
    this.setData({
      pickerVisible: true,
      pickerMonthIndex: this.data.currMonth
    })
  },

  closePicker() {
    this.setData({ pickerVisible: false })
  },

  onPickerMonthChange(e) {
    this.setData({ pickerMonthIndex: e.detail.value[0] })
  },

  confirmPicker() {
    const { pickerMonthIndex, currYear } = this.data
    this.setData({
      currMonth: pickerMonthIndex,
      pickerVisible: false,
      calendarVisible: true
    }, () => {
      this._updateCalendar()
      this._fetchEvents()
    })
  },

  goCreateEvent() {
    wx.navigateTo({
      url: `/packageAdmin/pages/admin/event-edit/event-edit?date=${this.data.selectedDate}`
    })
  },

  goEditEvent(e) {
    const { id } = e.currentTarget.dataset
    // A revealed delete eats the first tap: closing the swipe comes before
    // any navigation (iOS pattern) — applies to the open card itself and to
    // any other card while one is open.
    if (this.data.swipeId) {
      this.setData({ swipeId: '', swipeX: 0 })
      return
    }
    wx.navigateTo({
      url: `/packageAdmin/pages/admin/event-edit/event-edit?id=${id}`
    })
  },

  // ── Swipe-to-delete ─────────────────────────────────────────────────────
  // Horizontal drag moves the card left over the red Delete button; vertical
  // movement is ignored so the page still scrolls normally. On release the
  // card snaps open (past half the button) or back closed. Only one card can
  // be open: starting a drag/tap elsewhere resets the previous one.
  onSwipeStart(e) {
    const t = e.touches && e.touches[0]
    if (!t) return
    this._sx = t.clientX
    this._sy = t.clientY
    this._dragId = e.currentTarget.dataset.id
    this._wasOpen = this.data.swipeId === this._dragId && this.data.swipeX <= -this._delW / 2
    this.setData({
      swiping: true,
      swipeId: this._dragId,
      swipeX: this._wasOpen ? -this._delW : 0
    })
  },

  onSwipeMove(e) {
    const t = e.touches && e.touches[0]
    if (!t || !this._dragId) return
    const dx = t.clientX - this._sx
    const dy = t.clientY - this._sy
    if (Math.abs(dx) < Math.abs(dy)) return // vertical intent — let the page scroll
    let x = (this._wasOpen ? -this._delW : 0) + dx
    if (x > 0) x = 0
    if (x < -this._delW) x = -this._delW
    this.setData({ swipeId: this._dragId, swipeX: x })
  },

  onSwipeEnd() {
    if (!this._dragId) return
    const open = this.data.swipeX <= -this._delW / 2
    this.setData({
      swiping: false,
      swipeId: open ? this._dragId : '',
      swipeX: open ? -this._delW : 0
    })
    this._dragId = ''
  },

  confirmDelete(e) {
    const { id, title } = e.currentTarget.dataset
    // Reset any open swipe — the card is about to disappear.
    this.setData({ swipeId: '', swipeX: 0, swiping: false })
    wx.showModal({
      title: 'Delete Event',
      content: `Remove "${title}"?`,
      confirmColor: '#FF3B30',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      success: async ({ confirm }) => {
        if (!confirm) return
        wx.showLoading({ title: 'Deleting...' })
        try {
          const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
            action: 'deleteEvent',
            eventId: id
          })
          if (isUnauthorized(res)) { handleAuthFailure(); return }
          if (!res || !res.success) throw new Error(res && res.error || 'Delete failed')
          this.setData({
            events: this.data.events.filter(event => event._id !== id),
            filteredEvents: this.data.filteredEvents.filter(event => event._id !== id)
          })
          wx.vibrateShort({ type: 'medium' })
          wx.showToast({ title: 'Deleted', icon: 'success' })
          await this._fetchEvents()
        } catch (err) {
          console.error('[Calendar] delete error:', err)
          wx.showModal({ title: 'Error', content: String(err && err.message || 'Delete failed'), showCancel: false })
        } finally {
          wx.hideLoading()
        }
      }
    })
  },

  onShareAppMessage() {
    return {
      title: 'Yue! Admin',
      path: '/pages/admin/calendar/calendar'
    }
  }
})

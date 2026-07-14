const { collection, callFunction } = require('../../../utils/request')
const { COLLECTIONS, CLOUD_FUNCTIONS } = require('../../../utils/constants')

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

    pickerVisible: false,
    pickerMonthIndex: 0,
    monthNames: MONTH_NAMES
  },

  onLoad() {
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth()
    const d = now.getDate()
    const selectedDate = this._formatDate(y, m + 1, d)
    this.setData({
      currYear: y,
      currMonth: m,
      selectedDate,
      selectedDateLabel: this._formatLabel(new Date(y, m, d))
    }, () => {
      this._updateCalendar()
    })
  },

  onShow() {
    this._syncTabBar()
    this._fetchEvents()
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
    this.setData({ loading: true })
    wx.showNavigationBarLoading()
    try {
      const { currYear, currMonth } = this.data
      const db = wx.cloud.database()
      const _ = db.command
      const fromDate = new Date(currYear, currMonth - 3, 1)
      const toDate = new Date(currYear, currMonth + 4, 0)
      const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
      const res = await db.collection('events')
        .where({ date: _.gte(fmt(fromDate)).and(_.lte(fmt(toDate))) })
        .orderBy('date', 'asc')
        .get()
      this.setData({ events: res.data }, () => this._filterEvents())
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
    const filtered = events
      .filter(e => e.date === selectedDate)
      .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''))
    this.setData({ filteredEvents: filtered })
  },

  async onRefresh() {
    await this._fetchEvents()
    this.setData({ refreshing: false })
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
      url: `/pages/admin/event-edit/event-edit?date=${this.data.selectedDate}`
    })
  },

  goEditEvent(e) {
    const { id } = e.currentTarget.dataset
    wx.navigateTo({
      url: `/pages/admin/event-edit/event-edit?id=${id}`
    })
  },

  confirmDelete(e) {
    const { id, title } = e.currentTarget.dataset
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
          if (!res || !res.success) throw new Error(res && res.error || 'Delete failed')
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

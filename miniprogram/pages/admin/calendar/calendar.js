const { collection } = require('../../../utils/request')
const { COLLECTIONS } = require('../../../utils/constants')

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const CURRENT_YEAR = new Date().getFullYear()
const YEARS = Array.from({ length: 11 }, (_, i) => CURRENT_YEAR - 2 + i)

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

    pickerVisible: false,
    pickerMonthIndex: 0,
    pickerYearIndex: 2,
    monthNames: MONTH_NAMES,
    years: YEARS
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
    const y = date.getFullYear()
    return `${dayName}, ${d} ${month} ${y}`
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
      const res = await collection(COLLECTIONS.EVENTS).get()
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

  prevDay() {
    const { selectedDate } = this.data
    const date = new Date(selectedDate)
    date.setDate(date.getDate() - 1)
    const y = date.getFullYear()
    const m = date.getMonth()
    const newSelected = this._formatDate(y, m + 1, date.getDate())
    this.setData({
      selectedDate: newSelected,
      selectedDateLabel: this._formatLabel(date),
      currYear: y,
      currMonth: m
    }, () => {
      this._updateCalendar()
      this._filterEvents()
    })
  },

  nextDay() {
    const { selectedDate } = this.data
    const date = new Date(selectedDate)
    date.setDate(date.getDate() + 1)
    const y = date.getFullYear()
    const m = date.getMonth()
    const newSelected = this._formatDate(y, m + 1, date.getDate())
    this.setData({
      selectedDate: newSelected,
      selectedDateLabel: this._formatLabel(date),
      currYear: y,
      currMonth: m
    }, () => {
      this._updateCalendar()
      this._filterEvents()
    })
  },

  openPicker() {
    const { currMonth, currYear } = this.data
    const yearIndex = YEARS.indexOf(currYear)
    this.setData({
      pickerVisible: true,
      pickerMonthIndex: currMonth,
      pickerYearIndex: yearIndex >= 0 ? yearIndex : 2
    })
  },

  closePicker() {
    this.setData({ pickerVisible: false })
  },

  onPickerMonthChange(e) {
    this.setData({ pickerMonthIndex: e.detail.value })
  },

  onPickerYearChange(e) {
    this.setData({ pickerYearIndex: e.detail.value })
  },

  confirmPicker() {
    const { pickerMonthIndex, pickerYearIndex } = this.data
    const newMonth = pickerMonthIndex
    const newYear = YEARS[pickerYearIndex]
    this.setData({
      currMonth: newMonth,
      currYear: newYear,
      pickerVisible: false,
      calendarVisible: true
    }, () => this._updateCalendar())
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
          await collection(COLLECTIONS.EVENTS).doc(id).remove()
          wx.vibrateShort({ type: 'medium' })
          wx.showToast({ title: 'Deleted', icon: 'success' })
          await this._fetchEvents()
        } catch (err) {
          console.error('[Calendar] delete error:', err)
          wx.showToast({ title: 'Error', icon: 'none' })
        } finally {
          wx.hideLoading()
        }
      }
    })
  }
})
const { callFunction } = require('../../../utils/request')
const { CLOUD_FUNCTIONS } = require('../../../utils/constants')
const { isUnauthorized, handleAuthFailure } = require('../../../utils/auth')

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function localToday() {
  const t = new Date()
  return t.getFullYear() + '-' +
    String(t.getMonth() + 1).padStart(2, '0') + '-' +
    String(t.getDate()).padStart(2, '0')
}

// '2026-09-18' → 'Fri, Sep 18' (page section headers)
function dateLabel(dateStr) {
  const parts = String(dateStr || '').split('-').map(Number)
  if (parts.length !== 3 || parts.some(isNaN)) return dateStr
  const d = new Date(parts[0], parts[1] - 1, parts[2])
  return WEEKDAYS[d.getDay()] + ', ' + MONTHS[parts[1] - 1] + ' ' + parts[2]
}

// Events tab — every ACTUAL event: today's (not yet ended) on top, then
// future events grouped by date. 'upcoming' mode on the server returns
// everything from today onward with guest counts attached; grouping and
// the ended/closed filtering happen here.
Page({
  data: {
    loading: false,
    groups: []
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().updateTabs()
      this.getTabBar().setData({ selected: 1 })
    }
    this._loadEvents()
  },

  async _loadEvents() {
    // Silent refresh after the first load (tab switches must not flicker).
    this.setData({ loading: !this._loadedOnce })
    this._loadedOnce = true
    try {
      const todayStr = localToday()

      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'getEventsWithGuestCounts',
        dateFilter: todayStr,
        mode: 'upcoming'
      })
      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: 'Load failed', icon: 'none' })
        return
      }
      // STATUS-based list: the server already auto-closed anything past its
      // end time (see getEventsWithGuestCounts 'upcoming'), so whatever
      // arrives here is active by flag — no extra time filtering client-side.
      const actual = (res.data || [])
        .sort((a, b) =>
          (a.date || '').localeCompare(b.date || '') ||
          String(a.startTime || '').localeCompare(String(b.startTime || '')))

      // Today first, then dates ascending, one section per date.
      const groups = []
      const byDate = {}
      actual.forEach(ev => {
        const key = ev.date === todayStr ? 'today' : ev.date
        if (!byDate[key]) {
          byDate[key] = { label: key === 'today' ? 'Today' : dateLabel(key), events: [] }
          groups.push(byDate[key])
        }
        byDate[key].events.push(ev)
      })
      this.setData({ groups })
    } catch (err) {
      console.error('[Events] load error:', err)
    } finally {
      this.setData({ loading: false })
    }
  },

  // Full statistics for the event (registered / in venue / waiting + the
  // guest list itself) live on the event-guests page.
  openEvent(e) {
    const id = e.currentTarget.dataset.id
    const event = this._findEvent(id)
    if (!event) return
    wx.navigateTo({
      url: `/packageAdmin/pages/admin/event-guests/event-guests?eventId=${id}&eventTitle=${encodeURIComponent(event.title || '')}&venueName=${encodeURIComponent(event.venueName || '')}`
    })
  },

  _findEvent(id) {
    for (const g of this.data.groups) {
      const hit = g.events.find(ev => ev._id === id)
      if (hit) return hit
    }
    return null
  }
})

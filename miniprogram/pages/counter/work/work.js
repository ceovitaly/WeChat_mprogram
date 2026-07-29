const app = getApp()
const { callFunction, collection } = require('../../../utils/request')
const { COLLECTIONS, CLOUD_FUNCTIONS } = require('../../../utils/constants')
const { isUnauthorized, handleAuthFailure } = require('../../../utils/auth')
const { startLiveSync } = require('../../../utils/liveSync')
const phoneMatch = require('../../../utils/phoneMatch')
const refCache = require('../../../utils/refCache')

// checkedInAt normalizer: the server value (db.serverDate()) crosses the cloud-function
// JSON boundary as an ISO string or a {$date: <ms>} object depending on SDK serialization;
// optimistic local inserts carry a plain ISO string. Normalize any of those shapes to
// epoch milliseconds, NaN when absent/unparseable.
const checkedInMs = (g) => {
  const v = g && g.checkedInAt
  if (!v) return NaN
  const raw = (typeof v === 'object' && v.$date !== undefined) ? v.$date : v
  return new Date(raw).getTime()
}

// Arrival-order comparator. checkedInAt (a server timestamp) is the primary key: unlike
// the bare "HH:MM" arrivedAt string it survives midnight (00:10 must sort after 23:50).
// Legacy rows checked in before checkedInAt existed lack the field, so unless BOTH sides
// have a valid timestamp we fall back to the old arrivedAt string comparison — within an
// all-legacy list HH:MM order is the best information available, and mixed lists only
// occur for the one night this fix ships mid-event.
const compareArrival = (a, b) => {
  const ta = checkedInMs(a)
  const tb = checkedInMs(b)
  if (!isNaN(ta) && !isNaN(tb)) return ta - tb
  const sa = (a && a.arrivedAt) || ''
  const sb = (b && b.arrivedAt) || ''
  return sa < sb ? -1 : (sa > sb ? 1 : 0)
}

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
    staffId: ''
  },

  onLoad() {
    this._checkingIn = new Set()
    this._roleMap = {}
    this._lastRawGuests = null
    this._stopLiveSync = null
    this._watchedEventId = null
  },

  onShow() {
    this._syncTabBar()
    this._restoreSession()
  },

  onHide() {
    this._stopLiveUpdates()
  },

  onUnload() {
    this._stopLiveUpdates()
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
      this.setData({ step: 'guests', venueName: savedName, currentVenueId: savedId, currentEvent: savedEvent })
      this._fetchGuests(savedEvent._id)
      this._fetchStaffAndPromoters()
      // onShow runs on every tab switch / foreground, so this restart path can hit
      // repeatedly — _startLiveUpdates always tears down first, so no watcher stacks up.
      this._startLiveUpdates(savedEvent._id)
      if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ hidden: true })
    } else if (savedId) {
      this._stopLiveUpdates()
      this.setData({ step: 'event', venueName: savedName, currentVenueId: savedId })
      this._fetchEvents()
    } else {
      this._stopLiveUpdates()
    }
  },

  // ─── Live guest-list updates ──────────────────────────────
  //
  // The whole watch-as-trigger / debounce / init-skip / polling-fallback mechanism
  // lives in utils/liveSync.js (see that file for the full design rationale). Here
  // it is used purely as a change signal: whenever a registration for the current
  // event changes, re-run _fetchGuests() so all existing join/build logic is kept.
  //
  // Two page-level details:
  //   - Lifecycle: the stop handle lives on the page instance (never in `data`) and
  //     _startLiveUpdates() always tears down first, so onShow re-entry, event
  //     switches and venue switches can't stack duplicate listeners.
  //   - Stale-event guard: _watchedEventId is re-checked inside the callback so a
  //     signal that lands after the user left this event can't refetch it.
  //   - Silent refetch: { silent: true } keeps the isLoading spinner from flashing.

  _startLiveUpdates(eventId) {
    this._stopLiveUpdates()
    if (!eventId) return
    this._watchedEventId = eventId
    this._stopLiveSync = startLiveSync({
      collection: COLLECTIONS.REGISTRATIONS,
      where: { eventId },
      label: '[work]',
      onChange: () => {
        if (this._watchedEventId !== eventId) return
        this._fetchGuests(eventId, { silent: true })
      }
    })
  },

  // Single teardown for the live-update mechanism.
  // Safe to call when nothing is running, and safe to call twice.
  _stopLiveUpdates() {
    if (this._stopLiveSync) {
      this._stopLiveSync()
      this._stopLiveSync = null
    }
    this._watchedEventId = null
  },

  // ─── Step 1 ───────────────────────────────────────────────

  onCodeInput(e) { this.setData({ clubCode: e.detail.value.toUpperCase() }) },

  async enterVenue() {
    const code = this.data.clubCode.trim()
    if (!code) { wx.showToast({ title: 'Enter password', icon: 'none' }); return }
    wx.showLoading({ title: 'Verifying...', mask: true })
    try {
      // Server-side check — the venues collection (door passwords) is not client-readable.
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, { action: 'verifyVenuePassword', password: code })
      if (res && res.success && res.venue) {
        const venue = res.venue
        wx.setStorageSync('currentVenueId', venue._id)
        wx.setStorageSync('currentVenueName', venue.name)
        this.setData({ step: 'event', venueName: venue.name, currentVenueId: venue._id, clubCode: '' })
        this._fetchEvents()
      } else if (isUnauthorized(res)) {
        handleAuthFailure()
      } else {
        wx.showToast({ title: (res && res.message) || 'Invalid password', icon: 'none' })
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
        this._stopLiveUpdates()
        wx.removeStorageSync('currentVenueId')
        wx.removeStorageSync('currentVenueName')
        wx.removeStorageSync('currentEvent')
        if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ hidden: false })
        this.setData({
          step: 'venue', venueName: '', currentVenueId: '', currentEvent: null,
          events: [], guests: [], filteredGuests: [], arrivedGuests: [], totalExpected: 0
        })
      }
    })
  },

  // ─── Step 2 ───────────────────────────────────────────────

  async _fetchEvents() {
    this.setData({ isLoading: true })
    try {
      // Venue name comes from the login step / storage — events reference venues by
      // name, and the venues collection itself is not client-readable.
      const venueName = this.data.venueName || wx.getStorageSync('currentVenueName')
      const now = new Date()
      if (now.getHours() < 5) now.setDate(now.getDate() - 1)
      // Build the date string from LOCAL components — toISOString() is UTC, which
      // between 00:00 and 05:00 China time still points at the previous UTC day and
      // made the 5am night-shift cutoff land on the wrong date.
      const today = now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0')
      const eventRes = await collection(COLLECTIONS.EVENTS).where({ venueName }).orderBy('date', 'asc').get()
      this.setData({ events: eventRes.data.filter(e => e.date >= today), isLoading: false })
    } catch (e) {
      this.setData({ isLoading: false })
    }
  },

  selectEvent(e) {
    const { event } = e.currentTarget.dataset
    wx.setStorageSync('currentEvent', event)
    this.setData({ step: 'guests', currentEvent: event, searchQuery: '', selectedPromoter: '' })
    this._fetchGuests(event._id)
    this._fetchStaffAndPromoters()
    // Switching events restarts the watcher against the new eventId (old one closed first).
    this._startLiveUpdates(event._id)
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ hidden: true })
  },

  backToEvents() {
    this._stopLiveUpdates()
    wx.removeStorageSync('currentEvent')
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ hidden: false })
    this.setData({ step: 'event', currentEvent: null, guests: [], filteredGuests: [], arrivedGuests: [], totalExpected: 0 })
    this._fetchEvents()
  },

  // ─── Step 3 ───────────────────────────────────────────────

  // opts.silent — skip the isLoading spinner and the failure toast. Used by the live
  // update path so a background refresh never flickers the list under staff's fingers.
  // Existing call sites pass no opts and keep their original visible-loading behaviour.
  async _fetchGuests(eventId, opts = {}) {
    const silent = !!opts.silent
    if (!silent) this.setData({ isLoading: true })
    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, { action: 'getRegistrations', eventId })
      if (!res || !res.success) {
        if (!silent) this.setData({ isLoading: false })
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        if (!silent) wx.showToast({ title: 'Load failed', icon: 'none' })
        return
      }
      // A slow silent refetch can land after the user already left this event — drop it.
      if (silent && this.data.currentEvent && this.data.currentEvent._id !== eventId) return
      this._lastRawGuests = res.data || []
      this._buildState(this._lastRawGuests)
    } catch (e) {
      if (!silent) {
        this.setData({ isLoading: false })
        wx.showToast({ title: 'Load failed', icon: 'none' })
      }
    }
  },

  // Fetches the full staff + promoter rosters and builds the phone -> role lookup used to
  // badge/mark internal people hiding in the guest list. Independent of _fetchGuests — may
  // resolve before or after it. Whichever finishes last re-runs _buildState so the guest
  // list ends up correctly annotated either way (annotation never changes grouping/sorting,
  // it only adds fields, so re-running is safe/idempotent).
  // Both rosters are read through the shared reference cache (utils/refCache): this runs
  // on every venue/event switch on a door screen that stays open all night, and neither
  // list changes during a shift. Promise.all still resolves only when both are available,
  // so the role map is replaced all-or-nothing exactly as before.
  async _fetchStaffAndPromoters() {
    try {
      const [staff, promoters] = await Promise.all([
        refCache.getStaff(),
        refCache.getPromoters()
      ])
      this._roleMap = phoneMatch.buildInternalRoleMap(staff, promoters)
    } catch (e) {
      if (isUnauthorized(refCache.cloudResponseOf(e))) { handleAuthFailure(); return }
      // any other failure: keep whatever role map we already had (possibly empty) —
      // annotation just no-ops
    }
    if (this._lastRawGuests) this._buildState(this._lastRawGuests)
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
    const eventId = ev._id
    const roleMap = this._roleMap || {}
    const annotated = raw.map(g => phoneMatch.annotateAttendance(g, roleMap, eventId))
    const p = Number(ev.partyCapacity) || 0
    const ap = Number(ev.afterPartyCapacity) || 0
    const lap = Number(ev.lateAfterPartyCapacity) || 0
    const groupOrder = { 'P': 0, 'AP': 1, 'LAP': 2, '': 3 }
    const arrivedGuests = annotated
      .filter(g => g.arrivedAt)
      .sort(compareArrival)
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

    const pending = annotated.filter(g => !g.arrivedAt)
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

    const names = [...new Set(annotated.filter(g => g.promoterName).map(g => g.promoterName))].sort()

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
    // Local stand-in for the server's checkedInAt so the new sort key exists immediately;
    // the authoritative server timestamp replaces it on the next full fetch (minor clock
    // skew between phone and server is acceptable for ordering).
    const checkedInAt = now.toISOString()

    try {
      const res = await callFunction(CLOUD_FUNCTIONS.CHECK_IN_GUEST, { registrationId: id, arrivedAt })
      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: 'Error', icon: 'none' })
        return
      }

      // Keep the raw cache in sync so a late-resolving _fetchStaffAndPromoters rebuilding
      // via _buildState(this._lastRawGuests) doesn't revert this optimistic check-in.
      if (this._lastRawGuests) {
        this._lastRawGuests = this._lastRawGuests.map(g => g._id === id ? { ...g, arrivedAt, checkedInAt } : g)
      }

      const remove = arr => arr.map(g => ({ ...g, guests: g.guests.filter(gg => gg._id !== id) })).filter(g => g.guests.length > 0)

      const ev = this.data.currentEvent || {}
      const p = Number(ev.partyCapacity) || 0
      const ap = Number(ev.afterPartyCapacity) || 0
      const lap = Number(ev.lateAfterPartyCapacity) || 0

      const newArrived = [...this.data.arrivedGuests, { ...guest, arrivedAt, checkedInAt }]
        .sort(compareArrival)
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
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, { action: 'uncheckGuest', registrationId: id })
      // Only apply the local revert if the server actually uncheck-ed the guest.
      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: 'Error', icon: 'none' })
        return
      }
      const guest = this.data.arrivedGuests.find(g => g._id === id)
      if (!guest) return

      // Same sync as checkIn — keep the raw cache consistent for any late _buildState rebuild.
      if (this._lastRawGuests) {
        this._lastRawGuests = this._lastRawGuests.map(g => g._id === id ? { ...g, arrivedAt: null, checkedInAt: null } : g)
      }

      // Preserve internalRole/internalLabel/internalId/attendancePresent across the
      // arrived -> pending transition so the attendance button doesn't disappear.
      const pendingGuest = {
        _id: guest._id,
        guestName: guest.guestName,
        promoterName: guest.promoterName || null,
        internalRole: guest.internalRole || null,
        internalLabel: guest.internalLabel || '',
        internalId: guest.internalId || '',
        attendancePresent: guest.attendancePresent || false
      }

      const ev = this.data.currentEvent || {}
      const p = Number(ev.partyCapacity) || 0
      const ap = Number(ev.afterPartyCapacity) || 0
      const lap = Number(ev.lateAfterPartyCapacity) || 0

      const arrivedGuests = this.data.arrivedGuests
        .filter(g => g._id !== id)
        .sort(compareArrival)
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

  // Toggles "physically present at this event" for a staff/promoter row found phone-matched
  // inside the guest list. gid is the registration's own _id (used to find/patch the guest
  // wherever it currently lives — pending `guests` nested groups or flat `arrivedGuests`);
  // id/type identify the staff or promoter doc to write to.
  async toggleAttendance(e) {
    const { type, id, present, gid } = e.currentTarget.dataset
    const eventId = this.data.currentEvent && this.data.currentEvent._id
    if (!type || !id || !eventId) return
    const nextPresent = !present
    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'markAttendance', targetType: type, targetId: id, eventId, present: nextPresent
      })
      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: 'Error', icon: 'none' })
        return
      }

      let foundInPending = false
      const guests = this.data.guests.map(grp => {
        const idx = grp.guests.findIndex(gg => gg._id === gid)
        if (idx === -1) return grp
        foundInPending = true
        const groupGuests = grp.guests.slice()
        groupGuests[idx] = { ...groupGuests[idx], attendancePresent: nextPresent }
        return { ...grp, guests: groupGuests }
      })

      const arrivedGuests = foundInPending
        ? this.data.arrivedGuests
        : this.data.arrivedGuests.map(g => g._id === gid ? { ...g, attendancePresent: nextPresent } : g)

      const ev = this.data.currentEvent || {}
      const p = Number(ev.partyCapacity) || 0
      const ap = Number(ev.afterPartyCapacity) || 0
      const lap = Number(ev.lateAfterPartyCapacity) || 0
      const arrivedSections = this._buildSections(arrivedGuests, p, ap, lap)

      this.setData({ guests, arrivedGuests, arrivedSections })
      this._applyFilter(this.data.searchQuery, this.data.selectedPromoter)
      wx.vibrateShort({ type: 'light' })
    } catch (err) {
      wx.showToast({ title: 'Error', icon: 'none' })
    }
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

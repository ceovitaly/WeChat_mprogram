const app = getApp()
const { callFunction } = require('../../../utils/request')
const { COLLECTIONS, CLOUD_FUNCTIONS } = require('../../../utils/constants')
const { isUnauthorized, handleAuthFailure } = require('../../../utils/auth')
const { startLiveSync } = require('../../../utils/liveSync')
const phoneMatch = require('../../../utils/phoneMatch')
const refCache = require('../../../utils/refCache')
const { createMatrix } = require('../../../utils/qrCode')
const { businessToday, hasEnded } = require('../../../utils/format')

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


// Delta refreshes carry only changed rows; a FULL refresh still runs at
// least this often as the safety net for changes the delta channel can't see.
const FULL_EVERY_MS = 5 * 60 * 1000
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
    // Check-in QR overlay: the token rotates every 20s server-side; the overlay
    // refetches a few seconds before expiry so the displayed code is always
    // valid. qrToken drives the canvas redraw.
    showCheckinQr: false,
    qrToken: '',
    qrExpired: false,
    qrTtl: 20,
    qrSecondsLeft: 0,
    // Paid-guest scan alert: when a PAID guest scans the door QR, their
    // ticket details pop up here so the counter never misses them. Free
    // guests check in silently as before.
    paidScanAlert: null
  },

  onLoad() {
    this._checkingIn = new Set()
    this._roleMap = {}
    this._lastRawGuests = null
    this._scanMarks = {}
    // Delta-refresh cursors (server clock; see _fetchGuests's delta branch).
    this._lastSyncMs = 0
    this._lastFullAt = 0
    this._stopLiveSync = null
    this._watchedEventId = null
  },

  onShow() {
    this._syncTabBar()
    this._restoreSession()
  },

  onHide() {
    this._stopLiveUpdates()
    this._stopQrCountdown()
    this.closePaidScanAlert()
  },

  onUnload() {
    this._stopLiveUpdates()
    this._stopQrCountdown()
    this.closePaidScanAlert()
  },

  // ─── Check-in QR (anti-fraud) ─────────────────────────────
  //
  // Guests scan this rotating code with The List app; their registration gets
  // scannedAt, and the counter's check-in tap stays the second confirmation.
  // Rotation is server-driven (signed token, 20s TTL); the countdown and
  // refetch below only keep the DISPLAY fresh — validity is enforced in the
  // cloud function, so a stale phone clock can't extend a code.
  openCheckinQr() {
    this.setData({ showCheckinQr: true, qrExpired: false })
    this._fetchQrToken()
    this._startQrCountdown()
  },

  closeCheckinQr() {
    this._stopQrCountdown()
    this.setData({ showCheckinQr: false, qrToken: '', qrSecondsLeft: 0, qrExpired: false })
  },

  async _fetchQrToken() {
    if (this._qrFetching) return
    const eventId = (this.data.currentEvent || {})._id
    if (!eventId) return
    this._qrFetching = true
    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'issueCheckinToken', eventId
      })
      if (!res || !res.success) throw new Error((res && res.message) || 'failed')
      this._qrExpiresAt = Math.floor(Date.now() / 1000) + (res.ttl || 20)
      this.setData({ qrToken: res.token, qrSecondsLeft: res.ttl || 20, qrTtl: res.ttl || 20, qrExpired: false })
      this._drawQr(res.token)
    } catch (e) {
      wx.showToast({ title: 'Code refresh failed', icon: 'none' })
      // Offer the refresh icon as the retry path — an empty square helps nobody.
      if (this.data.showCheckinQr) this.setData({ qrExpired: true })
    } finally {
      this._qrFetching = false
    }
  },

  // Countdown only — NO auto-refresh loop: the code lives until it expires,
  // then hides behind a refresh icon and the COUNTER decides when a new one
  // is needed (one request per tap instead of a rotation request every TTL).
  _startQrCountdown() {
    this._stopQrCountdown()
    this._qrTimer = setInterval(() => {
      if (!this.data.showCheckinQr) { this._stopQrCountdown(); return }
      const left = Math.max(0, (this._qrExpiresAt || 0) - Math.floor(Date.now() / 1000))
      this.setData({ qrSecondsLeft: left })
      if (left === 0 && !this.data.qrExpired) this.setData({ qrExpired: true })
    }, 1000)
  },

  _stopQrCountdown() {
    if (this._qrTimer) {
      clearInterval(this._qrTimer)
      this._qrTimer = null
    }
  },

  refreshCheckinQr() {
    if (this._qrFetching) return
    this._fetchQrToken()
  },

  _drawQr(token) {
    wx.createSelectorQuery().in(this)
      .select('#checkinQrCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        // The overlay's wx:if may not have mounted the canvas yet when the
        // token fetch resolves fast — retry shortly instead of leaving the
        // code blank until the next rotation.
        if (!res || !res[0] || !res[0].node) {
          if (!this._qrDrawRetries) this._qrDrawRetries = 0
          if (this._qrDrawRetries < 5 && this.data.showCheckinQr) {
            this._qrDrawRetries++
            setTimeout(() => this._drawQr(token), 250)
          }
          return
        }
        this._qrDrawRetries = 0
        const canvas = res[0].node
        const ctx = canvas.getContext('2d')
        const dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2
        canvas.width = res[0].width * dpr
        canvas.height = res[0].height * dpr
        const m = createMatrix(token)
        const quiet = 4
        const cell = Math.min(canvas.width, canvas.height) / (m.size + quiet * 2)
        ctx.fillStyle = '#FFFFFF'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = '#000000'
        for (let r = 0; r < m.size; r++) {
          for (let c = 0; c < m.size; c++) {
            if (!m.modules[r][c]) continue
            ctx.fillRect(
              Math.floor((c + quiet) * cell),
              Math.floor((r + quiet) * cell),
              Math.ceil(cell), Math.ceil(cell)
            )
          }
        }
      })
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
        this._fetchGuests(eventId, { silent: true, delta: true })
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
        // Navigation is always hidden for counter role
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
      // Server-side date filter: a client-issued query is capped at 20 docs regardless
      // of .limit(), so ascending order returned the venue's oldest history and the
      // upcoming events were never in the result set to filter. businessToday() (6 AM
      // shift day) is passed through unchanged.
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'getEvents',
        venueName,
        dateGte: businessToday()
      })
      if (!res || !res.success) {
        this.setData({ isLoading: false })
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        return
      }
      this.setData({ events: res.data || [], isLoading: false })
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
    // Navigation is always hidden for counter role
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

    // DELTA path — same design as event-guests: only rows changed since the
    // last sync (server clock) merge into _lastRawGuests and the view
    // rebuilds locally. One check-in = one row over the wire. A full silent
    // fetch stays the fallback (any delta problem) and the safety net (at
    // least every FULL_EVERY_MS).
    if (opts.delta && this._lastSyncMs && Date.now() - (this._lastFullAt || 0) < FULL_EVERY_MS) {
      try {
        const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
          action: 'getRegistrations',
          eventId,
          since: this._lastSyncMs
        })
        if (res && res.success && res.delta) {
          if (silent && this.data.currentEvent && this.data.currentEvent._id !== eventId) return
          this._lastSyncMs = res.serverNow || Date.now()
          if (this._lastRawGuests) {
            const byId = {}
            this._lastRawGuests.forEach(r => { byId[r._id] = r })
            ;(res.changed || []).forEach(r => { byId[r._id] = r })
            this._lastRawGuests = Object.keys(byId).map(k => byId[k])
            this._checkPaidScans(res.changed || [], true)
            this._buildState(this._lastRawGuests)
            return
          }
        }
      } catch (e) { /* fall through to the full fetch below */ }
    }

    try {
      // getRegistrations is paginated server-side (the unpaginated reply
      // outgrew the ~1MB callFunction cap on big events). The door screen
      // still wants EVERYONE, so pages are looped until exhausted — each
      // reply stays small; only the local array holds the full list.
      const PAGE = 1000
      let all = []
      let res = null
      let failed = false
      while (true) {
        res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
          action: 'getRegistrations',
          eventId,
          offset: all.length,
          limit: PAGE
        })
        if (!res || !res.success) { failed = true; break }
        all = all.concat(res.data || [])
        if (!res.hasMore) break
      }
      if (failed) {
        if (!silent) this.setData({ isLoading: false })
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        if (!silent) wx.showToast({ title: 'Load failed', icon: 'none' })
        return
      }
      // A slow silent refetch can land after the user already left this event — drop it.
      if (silent && this.data.currentEvent && this.data.currentEvent._id !== eventId) return
      this._lastRawGuests = all
      this._lastSyncMs = res.serverNow || Date.now()
      this._lastFullAt = Date.now()
      // Record-only pass: full loads update the per-guest scan marks so a
      // later delta compares against the right baseline, but never pop.
      this._checkPaidScans(all, false)
      this._buildState(this._lastRawGuests)
    } catch (e) {
      if (!silent) {
        this.setData({ isLoading: false })
        wx.showToast({ title: 'Load failed', icon: 'none' })
      }
    }
  },

  // ─── Paid-guest scan alert ────────────────────────────────
  //
  // Pops up ONLY at the moment a PAID guest scans the door QR: the scan
  // stamps scannedAt on their registration, the live watcher fires a delta
  // refresh, and the changed row lands here with live=true. Full loads
  // (page open, event switch) pass live=false — they only RECORD the current
  // scan marks, never replay them. Per guest the LAST scannedAt value is
  // remembered (not a one-time flag), so after a "Remove arrival" reset the
  // next scan is a NEW mark and pops again. FREE guests are untouched:
  // silent check-in, exactly as before.
  _checkPaidScans(rows, live) {
    if (!Array.isArray(rows) || !rows.length) return
    if (!this._scanMarks) this._scanMarks = {}
    // Freshness guard: the changed row's scan must be ~just now (a little
    // slack for phone-vs-server clock skew). Anything older is an edit to an
    // already-scanned row, not a new arrival.
    const freshAfter = Date.now() - 90 * 1000
    rows.forEach(r => {
      if (!r || !r._id) return
      let mark = ''
      if (r.scannedAt) {
        const raw = (typeof r.scannedAt === 'object' && r.scannedAt.$date !== undefined) ? r.scannedAt.$date : r.scannedAt
        const ms = new Date(raw).getTime()
        if (!isNaN(ms)) mark = String(ms)
      }
      const prev = this._scanMarks[r._id]
      this._scanMarks[r._id] = mark
      if (!live || !mark || !r.paid || mark === prev) return
      if (Number(mark) < freshAfter) return
      this._showPaidScanAlert(r)
    })
  },

  _showPaidScanAlert(r) {
    if (this._paidScanTimer) clearTimeout(this._paidScanTimer)
    // The alert replaces the QR overlay instead of stacking on top of it —
    // two overlapping windows read as broken. The counter reopens the code
    // with one tap when the next guest approaches.
    this._stopQrCountdown()
    wx.vibrateShort({ type: 'medium' })
    this.setData({
      showCheckinQr: false,
      qrToken: '',
      qrSecondsLeft: 0,
      qrExpired: false,
      paidScanAlert: {
        guestName: r.guestName || '',
        ticketType: r.ticketType || '',
        price: r.paidAmountFen ? '¥ ' + (r.paidAmountFen / 100) : '',
        promoterName: r.promoterName || '',
        arrivedAt: r.arrivedAt || ''
      }
    })
    // Auto-dismiss: never leave a stale popup covering the work screen.
    this._paidScanTimer = setTimeout(() => this.closePaidScanAlert(), 20 * 1000)
  },

  closePaidScanAlert() {
    if (this._paidScanTimer) { clearTimeout(this._paidScanTimer); this._paidScanTimer = null }
    this.setData({ paidScanAlert: null })
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
      // Manual-only (no-scan) marks land in the Extra bucket regardless of
      // their capacity group — verified (scanned) arrivals fill P/AP/LAP. The
      // guest's own group/arrivalNumber stay truthful, so a later scan moves
      // them back into their own section on the next rebuild.
      const tag = (!g.scannedAt || g.group === undefined) ? '' : g.group
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
    // Closed by the admin, or its end time has passed
    if (hasEnded(this.data.currentEvent)) {
      wx.showToast({ title: 'Event is closed', icon: 'none' })
      return
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

  // ─── Staff / promoter attendance ──────────────────────────
  //
  // Flips attendancePresent for every row belonging to one staff/promoter record
  // (matched by internalId, so multiple registrations of the same person stay in sync).
  // The list is fanned out across six data arrays — flat arrived, grouped pending,
  // sectioned arrived and the filtered copy of each — plus the phone->role map that
  // _buildState re-annotates from. All of them move together: live sync rebuilds the
  // list constantly, so a stale copy anywhere reverts the badge on the next render.
  _setAttendance(internalId, present) {
    const eventId = (this.data.currentEvent || {})._id
    const flip = list => list.map(g => g.internalId === internalId ? { ...g, attendancePresent: present } : g)
    const flipGroups = list => list.map(grp => ({ ...grp, guests: flip(grp.guests) }))
    Object.keys(this._roleMap || {}).forEach(k => {
      const m = this._roleMap[k]
      if (!m || m.id !== internalId) return
      const ids = m.eventIds || []
      m.eventIds = present ? (ids.includes(eventId) ? ids : [...ids, eventId]) : ids.filter(i => i !== eventId)
    })
    this.setData({
      guests: flipGroups(this.data.guests),
      filteredGuests: flipGroups(this.data.filteredGuests),
      arrivedGuests: flip(this.data.arrivedGuests),
      filteredArrivedGuests: flip(this.data.filteredArrivedGuests),
      arrivedSections: flipGroups(this.data.arrivedSections),
      filteredArrivedSections: flipGroups(this.data.filteredArrivedSections)
    })
  },

  async toggleAttendance(e) {
    const { internalId, internalRole, present } = e.currentTarget.dataset
    if (!internalId) return
    const eventId = (this.data.currentEvent || {})._id
    if (!eventId) return
    const next = !present
    this._setAttendance(internalId, next)  // optimistic; reverted below on failure
    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'markAttendance', targetType: internalRole, targetId: internalId, eventId, present: next
      })
      if (!res || !res.success) {
        this._setAttendance(internalId, !next)
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: 'Error', icon: 'none' })
        return
      }
      wx.vibrateShort({ type: 'medium' })
      wx.showToast({ title: next ? 'Marked present' : 'Unmarked', icon: 'none' })
    } catch (err) {
      this._setAttendance(internalId, !next)
      wx.showToast({ title: 'Error', icon: 'none' })
    }
  },

  // Empty handler for WXML scroll/tap blocks (catchtouchmove / catchtap noop).
  noop() {},

  confirmLogout() {    wx.showModal({
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

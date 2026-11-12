const { callFunction } = require('../../../../utils/request')
const { COLLECTIONS, CLOUD_FUNCTIONS } = require('../../../../utils/constants')
const { isUnauthorized, handleAuthFailure } = require('../../../../utils/auth')
const { startLiveSync } = require('../../../../utils/liveSync')
const { normalizePhone, buildInternalRoleMap, annotateInternalRole } = require('../../../../utils/phoneMatch')
const refCache = require('../../../../utils/refCache')
const { openAsXls } = require('../../../../utils/xlsx')
const { hasEnded } = require('../../../../utils/format')
const { createArrivalGroupAssigner } = require('../../../../utils/arrivalGroups')

// checkedInAt normalizer: the server value (db.serverDate()) crosses the cloud-function
// JSON boundary as an ISO string or a {$date: <ms>} object depending on SDK serialization.
// Normalize either shape to epoch milliseconds, NaN when absent/unparseable.
const checkedInMs = (g) => {
  const v = g && g.checkedInAt
  if (!v) return NaN
  const raw = (typeof v === 'object' && v.$date !== undefined) ? v.$date : v
  return new Date(raw).getTime()
}

// Arrival-order comparator (same design as counter/work). checkedInAt is the primary key:
// unlike the bare "HH:MM" arrivedAt string it survives midnight (00:10 sorts after 23:50).
// Legacy rows lack checkedInAt, so unless BOTH sides have a valid timestamp we fall back
// to the old arrivedAt string comparison.
const compareArrival = (a, b) => {
  const ta = checkedInMs(a)
  const tb = checkedInMs(b)
  if (!isNaN(ta) && !isNaN(tb)) return ta - tb
  const sa = (a && a.arrivedAt) || ''
  const sb = (b && b.arrivedAt) || ''
  return sa < sb ? -1 : (sa > sb ? 1 : 0)
}

// Delta refreshes carry only changed rows; a FULL refresh still runs at least
// this often as the safety net for changes the delta channel can't see.
const FULL_EVERY_MS = 5 * 60 * 1000

Page({
  data: {
    eventId: '',
    eventTitle: '',
    venueName: '',
    eventDate: '',
    dutyStaff: [],
    arrivedGuests: [],
    arrivedSections: [],
    pendingGuests: [],
    totalRegistered: 0,
    totalArrived: 0,
    paidCount: 0,
    loading: true,
    lastUpdated: '',
    isClosed: false,
    isAdmin: false,
    promoters: [],
    staffList: [],
    // Promoter chip filter — the same control as the counter workspace: "All"
    // or one promoter name narrows the DISPLAYED lists; stats bar and the
    // export stay event-wide.
    selectedPromoter: '',
    promoterNames: [],
    filteredPendingGuests: [],
    filteredArrivedCount: 0
  },

  onLoad(options) {
    const userInfo = getApp().globalData.userInfo
    this._stopLiveSync = null
    // Accumulator for paginated registration docs (see _fetch).
    this._allRegs = []
    // Delta-refresh cursors (server clock; see _fetch's delta branch).
    this._lastSyncMs = 0
    this._lastFullAt = 0
    // onShow fires straight after onLoad — onLoad already fetched, so the first
    // onShow must not fire a duplicate request.
    this._firstShow = true
    this.setData({
      eventId: options.eventId || '',
      eventTitle: options.eventTitle ? decodeURIComponent(options.eventTitle) : '',
      venueName: options.venueName ? decodeURIComponent(options.venueName) : '',
      // Optimistic closed state from the Past Events list (closed=1): the
      // page renders its past-event view immediately; the first fetch below
      // sets the authoritative value.
      isClosed: options.closed === '1',
      isAdmin: !!(userInfo && userInfo.role === 'admin')
    })
    this._fetch()
    this._fetchPromoterRoster()
    this._fetchPromoters()
    this._fetchStaff()
  },

  // ─── Live guest-list updates ──────────────────────────────
  //
  // Replaces the old unconditional 10-second interval poll. The mechanism (watch as a
  // change trigger, debounce, init-snapshot skip, 30s polling fallback) lives in
  // utils/liveSync.js — see that file for the full rationale. Here it only signals
  // "registrations for this event changed", and the page re-runs its own _fetch()
  // silently so no spinner flashes under the admin's eyes.
  //
  // Bound to onShow/onHide, not just onLoad/onUnload: a backgrounded or
  // navigated-away-from page must not keep watching or polling.

  _startLiveUpdates() {
    this._stopLiveUpdates()
    const { eventId } = this.data
    if (!eventId) return
    // Past events don't change anymore — no watcher/polling on their page.
    if (this.data.isClosed) return
    this._stopLiveSync = startLiveSync({
      collection: COLLECTIONS.REGISTRATIONS,
      where: { eventId },
      label: '[event-guests]',
      onChange: () => {
        // A signal that lands after the page moved on must not refetch.
        if (this.data.eventId !== eventId) return
        this._fetch({ silent: true, delta: true })
      }
    })
  },

  // Safe to call when nothing is running, and safe to call twice.
  _stopLiveUpdates() {
    if (this._stopLiveSync) {
      this._stopLiveSync()
      this._stopLiveSync = null
    }
  },

  onShow() {
    this._startLiveUpdates()
    if (this._firstShow) {
      this._firstShow = false
      return
    }
    // Returning to the page: show current data immediately, without a spinner.
    this._fetch({ silent: true })
  },

  onHide() {
    this._stopLiveUpdates()
  },

  onUnload() {
    this._stopLiveUpdates()
  },

  // Both rosters come from the shared reference cache (utils/refCache), so opening
  // several events in a row costs one fetch each per 5 minutes instead of two per
  // event. Still tolerant reads: any failure other than an expired session is
  // swallowed and the badges simply no-op, exactly as before.
  async _fetchPromoters() {
    try {
      const promoters = await refCache.getPromoters()
      this.setData({ promoters })
    } catch (err) {
      if (isUnauthorized(refCache.cloudResponseOf(err))) { handleAuthFailure() }
    }
  },

  // Full staff roster (for phone-matching guests against internal people) — distinct
  // from `dutyStaff` below, which is who's clocked in to work *this* event.
  async _fetchStaff() {
    try {
      const staffList = await refCache.getStaff()
      this.setData({ staffList })
    } catch (err) {
      if (isUnauthorized(refCache.cloudResponseOf(err))) { handleAuthFailure() }
    }
  },

  // Promoter chip roster as its OWN lightweight request (getEventPromoters is
  // a single names-only query), so the chips render before the heavy guest
  // list finishes loading. _fetch still falls back to the promoterNames
  // returned alongside the registrations for compatibility.
  _fetchPromoterRoster() {
    const { eventId } = this.data
    if (!eventId) return
    callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
      action: 'getEventPromoters',
      eventId
    }).then(res => {
      if (res && res.success && Array.isArray(res.promoterNames) && res.promoterNames.length) {
        this.setData({ promoterNames: res.promoterNames })
      }
    }).catch(() => {})
  },

  // opts.silent — skip clearing the `loading` flag and skip the failure toast, so a
  // live-update-driven background refresh never flashes a spinner or steals focus.
  // `lastUpdated` is still written in silent mode: it is a "data as of…" indicator
  // and the data genuinely did refresh. Existing call sites pass no opts and keep
  // their original visible-loading behaviour.
  // Paginated fetch (100 per page — see getRegistrations in
  // manageApplications) that LOOP-loads every page, exactly like the
  // counter's Work page: the admin expects the complete guest list with no
  // "load more" tap, and each transport reply stays small so the ~1MB
  // callFunction cap is never hit. Arrival numbers come from the server's
  // FULL arrival-time list, so numbering and the stats stay global.
  async _fetch(opts = {}) {
    const silent = !!opts.silent
    const { eventId } = this.data
    if (!eventId) return

    // DELTA path — liveSync signals: only rows changed since the last sync
    // (server clock) travel back; they're merged into the local full list
    // and the view rebuilds from it. One check-in = one row over the wire,
    // not the whole guest list. A full silent fetch remains the fallback (on
    // any delta problem) and the safety net (at least every FULL_EVERY_MS —
    // changes outside the delta channel are only visible to a full read).
    if (opts.delta && this._lastSyncMs && Date.now() - (this._lastFullAt || 0) < FULL_EVERY_MS) {
      try {
        const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
          action: 'getRegistrations',
          eventId,
          since: this._lastSyncMs
        })
        if (res && res.success && res.delta) {
          if (this.data.eventId !== eventId) return
          const removalVersion = Number(res.event && res.event.freeRegistrationRemovalVersion) || 0
          if (removalVersion !== (this._freeRegistrationRemovalVersion || 0)) {
            return await this._fetch({ silent: true })
          }
          this._lastSyncMs = res.serverNow || Date.now()
          const byId = {}
          this._allRegs.forEach(r => { byId[r._id] = r })
          ;(res.changed || []).forEach(r => { byId[r._id] = r })
          this._allRegs = Object.keys(byId).map(k => byId[k])
          this._applyRegResponse(res, silent)
          return
        }
      } catch (e) { /* fall through to the full fetch below */ }
    }

    try {
      const PAGE = 1000
      this._allRegs = []
      let regRes = null
      let failed = false
      while (true) {
        regRes = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
          action: 'getRegistrations',
          eventId,
          offset: this._allRegs.length,
          limit: PAGE
        })
        if (!regRes || !regRes.success) {
          failed = true
          break
        }
        this._allRegs = this._allRegs.concat(regRes.data || [])
        if (!regRes.hasMore) break
      }
      if (!silent) this.setData({ loading: false })
      if (failed) {
        if (isUnauthorized(regRes)) { handleAuthFailure(); return }
        if (!silent) wx.showToast({ title: 'Load failed', icon: 'none' })
        return
      }
      if (!regRes) return
      // Full refresh: reset both cursors — the delta channel continues from
      // the server's notion of "now".
      this._lastSyncMs = regRes.serverNow || Date.now()
      this._freeRegistrationRemovalVersion = Number(regRes.event && regRes.event.freeRegistrationRemovalVersion) || 0
      this._lastFullAt = Date.now()
      this._applyRegResponse(regRes, silent)
    } catch (e) {
      if (!silent) this.setData({ loading: false })
    }
  },

  // Shared view rebuild for the full and delta paths: takes one
  // getRegistrations response (full pages or delta globals) and rebuilds
  // stats, sections, chips and the waiting list from this._allRegs.
  _applyRegResponse(regRes, silent) {
      const regs = this._allRegs
      // Duty staff (workedEventIds contains this event) is resolved server-side inside
      // getRegistrations — the staff collection is not client-readable.
      const dutyStaff = (regRes.dutyStaff || [])
        .map(s => ({ _id: s._id, guestName: s.name, position: 0 }))
      const ev = regRes.event || {}
      const isClosed = hasEnded(ev)
      // Ended by time but the doc doesn't say so yet → close it server-side.
      // _closing guards against duplicate closeEvent calls from consecutive
      // refreshes (the event doc only reflects isClosed after a round-trip).
      if (isClosed && !ev.isClosed && !this._closing) {
        this._closing = true
        callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
          action: 'closeEvent',
          eventId: this.data.eventId,
          closedBy: 'Auto'
        }).catch(() => {})
      }
      const p = Number(ev.partyCapacity) || 0
      const ap = Number(ev.afterPartyCapacity) || 0
      const lap = Number(ev.lateAfterPartyCapacity) || 0
      const groupOrder = { 'P': 0, 'AP': 1, 'LAP': 2, '': 3 }
      const roleMap = buildInternalRoleMap(this.data.staffList, this.data.promoters)
      // Server-side globals: every arrival's timestamp (tiny) + total count.
      const arrivedTimes = (regRes.arrivedTimes || []).sort(compareArrival)
      const totalArrived = arrivedTimes.length
      const total = (regRes.total != null) ? regRes.total : regs.length
      // Event-wide paid count for the stats bar (the `paid` flag ships with
      // every registration row).
      const paidCount = regs.filter(g => g.paid).length
      const assignGroup = createArrivalGroupAssigner(ev)
      const arrived = regs
        .filter(g => g.arrivedAt)
        .sort(compareArrival)
        .map(g => {
          // Global number: arrivals strictly before this one, counted over
          // the full server list — correct across page boundaries.
          let before = 0
          for (let i = 0; i < arrivedTimes.length; i++) {
            if (compareArrival(arrivedTimes[i], g) < 0) before++
          }
          const num = before + 1
          const group = assignGroup(g)
          return { ...g, position: num, group }
        })
        .sort((a, b) => (groupOrder[a.group] ?? 3) - (groupOrder[b.group] ?? 3) || a.position - b.position)
        .map(g => annotateInternalRole(g, roleMap))
      const pending = regs.filter(g => !g.arrivedAt).map(g => annotateInternalRole(g, roleMap))

      // Full (unfiltered) lists feed stats/export; the displayed sections are
      // narrowed by the selected promoter chip. Kept on the instance so a chip
      // tap re-filters without a refetch.
      this._fullArrived = arrived
      this._fullPending = pending
      const shownArrived = this._filterByPromoter(arrived)
      const shownPending = this._filterByPromoter(pending)
      const arrivedSections = this._buildSections(shownArrived, p, ap, lap)
      // Server-computed distinct promoter roster (names-only scan in
      // getRegistrations) — the chip bar is complete from the first
      // response, never dependent on how many guest docs are loaded.
      // Derived-from-loaded values stay only as a legacy fallback.
      const promoterNames = (regRes.promoterNames && regRes.promoterNames.length)
        ? regRes.promoterNames
        : [...new Set(regs.filter(g => g.promoterName).map(g => g.promoterName))].sort()

      const now = new Date()
      const lastUpdated = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0')

      const userInfo = getApp().globalData.userInfo
      const update = { dutyStaff, arrivedGuests: arrived, arrivedSections, promoterNames, filteredPendingGuests: shownPending, filteredArrivedCount: shownArrived.length, pendingGuests: pending, totalRegistered: total, totalArrived, paidCount, lastUpdated, isClosed, eventDate: ev.date || '' }
      if (!silent) update.loading = false
      if (userInfo) update.isAdmin = userInfo.role === 'admin'
      this.setData(update)
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
      const tag = (!g.scannedAt || g.group === undefined) ? '' : g.group
      if (buckets[tag] !== undefined) buckets[tag].push(g)
      else buckets[''].push(g)
    })
    return sectionDefs
      .filter(s => buckets[s.tag].length > 0)
      .map(s => ({
        label: s.label,
        tag: s.tag,
        guests: buckets[s.tag].slice().sort((a, b) => a.position - b.position)
      }))
  },

  // Chip filter helpers — the counter workspace's design: the chips narrow the
  // displayed arrived/waiting lists to one promoter (or to paid guests only);
  // the stats bar above and exportCSV() keep working off the full arrays.
  // '__paid__' is the Paid chip's sentinel: never a real promoter name.
  _filterByPromoter(list) {
    const sel = this.data.selectedPromoter
    if (!sel) return list
    if (sel === '__paid__') return list.filter(g => g.paid)
    return list.filter(g => g.promoterName === sel)
  },

  filterPromoter(e) {
    const name = e.currentTarget.dataset.name || ''
    if (name === this.data.selectedPromoter) return
    // Filter by the NEW name (data still holds the old one at this point).
    const sel = (list) => {
      if (!name) return list
      if (name === '__paid__') return list.filter(g => g.paid)
      return list.filter(g => g.promoterName === name)
    }
    const shownArrived = sel(this._fullArrived || [])
    const shownPending = sel(this._fullPending || [])
    this.setData({
      selectedPromoter: name,
      arrivedSections: this._buildSections(shownArrived, 0, 0, 0),
      filteredArrivedCount: shownArrived.length,
      filteredPendingGuests: shownPending
    })
  },

  onRefresh() {
    this.setData({ loading: true })
    this._fetch()
  },

  exportCSV() {
    const { eventId, eventTitle, venueName, eventDate, arrivedGuests, dutyStaff, staffList, promoters } = this.data

    const normName = (n) => (n || '').toLowerCase().trim()

    const presentPromoters = new Set(
      promoters
        .filter(p => (p.attendedEventIds || []).includes(eventId))
        .map(p => normName(p.name))
    )

    // Count INVITED guests per promoter within one section's slice. A person checking
    // himself in (guestName === promoterName) is not a guest he invited, so his own
    // row is skipped — which leaves a 0 for a stage where only he himself showed up.
    const countByPromoter = (guests) => {
      const map = {}
      guests.forEach(g => {
        const key = g.promoterName || '—'
        if (!(key in map)) map[key] = 0
        if (normName(g.guestName) === normName(key)) return  // self-attendance, not an invited guest
        map[key]++
      })
      return Object.entries(map).sort((a, b) => b[1] - a[1])
    }

    const partyGuests = arrivedGuests.filter(g => g.group === 'P')
    const apGuests    = arrivedGuests.filter(g => g.group === 'AP')
    const lapGuests   = arrivedGuests.filter(g => g.group === 'LAP')
    const extraGuests = arrivedGuests.filter(g => g.group === '' || (g.group !== 'P' && g.group !== 'AP' && g.group !== 'LAP'))

    // Duty-staff (counter) names — present (worked) → eligible for *.
    const dutyNames = new Set(dutyStaff.map(s => normName(s.guestName)))

    // Internal people — staff AND promoters — who physically checked in: every
    // arrived registration whose phone matches a roster record, the same phone
    // match behind the STAFF/PROMOTER badges in the list above. Checking in is
    // the attendance proof; the manual workedEventIds/attendedEventIds marks
    // alone were too easy to skip during a busy door shift, and one skipped
    // mark silently dropped the star from this report.
    const staffPhones = new Set(
      (staffList || []).filter(s => s.role !== 'admin').map(s => normalizePhone(s.phone)).filter(Boolean)
    )
    const promoterPhones = new Set(
      (promoters || []).map(p => normalizePhone(p.phone)).filter(Boolean)
    )
    const internalPresent = new Set(dutyNames)
    arrivedGuests.forEach(g => {
      if (staffPhones.has(normalizePhone(g.phone)) || promoterPhones.has(normalizePhone(g.phone))) {
        internalPresent.add(normName(g.guestName))
      }
    })

    // Total guests a person invited across the WHOLE event — used only to decide
    // whether a counter belongs in the "present but invited no one" roster below.
    const totalByPromoter = {}
    arrivedGuests.forEach(g => {
      const key = normName(g.promoterName)
      if (key && key !== '—') totalByPromoter[key] = (totalByPromoter[key] || 0) + 1
    })

    // Names that have already received their presence star. The star is emitted at
    // most ONCE per person — in the first stage they appear in — so the same person
    // is never marked * in two different stages.
    const starred = new Set()

    // Party-section presence roster: internal people (counters or promoters)
    // who are present — on duty or checked in — but are the host of no row in
    // ANY stage, e.g. someone who checked in under another host's code. Their
    // arrival inflates that host's count, so without this roster they would be
    // invisible in the report.
    const presenceRoster = []
    const seenRoster = new Set()
    const pushRoster = (name) => {
      const key = normName(name)
      if (!key || seenRoster.has(key)) return
      seenRoster.add(key)
      presenceRoster.push(name)
    }
    dutyStaff.forEach(s => pushRoster(s.guestName))
    arrivedGuests.forEach(g => {
      if (staffPhones.has(normalizePhone(g.phone)) || promoterPhones.has(normalizePhone(g.phone))) {
        pushRoster(g.guestName)
      }
    })

    const shortDate = eventDate
      ? eventDate.split('-').slice(1).reverse().join('/')
      : ''

    const rows = []
    rows.push([eventTitle])
    rows.push([venueName])
    if (shortDate) rows.push([shortDate])
    rows.push([])

    const addSection = (title, guests, includeDuty) => {
      rows.push([title])
      const isParty = includeDuty
      if (isParty) {
        // Counters/promoters present but hosts of no row in ANY stage (invited
        // no one, or checked in under someone else's code): acknowledged once
        // here with * (no count) and recorded as already starred.
        presenceRoster.forEach(name => {
          const key = normName(name)
          if ((totalByPromoter[key] || 0) > 0) return
          rows.push([name + ' *'])
          starred.add(key)
        })
      }
      countByPromoter(guests).forEach(([name, count]) => {
        const key = normName(name)
        // Presence mark — emitted only the FIRST time this person appears in any stage:
        //   ' *' = present (counter or promoter who was on duty / checked in, or a
        //   promoter manually marked attended)   |   (none) = absent / already marked.
        const isPresent = internalPresent.has(key) || presentPromoters.has(key)
        let marker = ''
        if (isPresent && !starred.has(key)) {
          marker = ' *'
          starred.add(key)
        }
        // count is invited guests only (own attendance excluded). When it's 0 the
        // person only checked himself in for this stage — show the mark, no number.
        rows.push(count > 0 ? [name + marker, count] : [name + marker])
      })
    }

    if (dutyStaff.length > 0 || partyGuests.length > 0) addSection('Party', partyGuests, true)
    if (apGuests.length > 0) { rows.push([]); addSection('After Party', apGuests, false) }
    if (lapGuests.length > 0) { rows.push([]); addSection('Late After Party', lapGuests, false) }
    if (extraGuests.length > 0) { rows.push([]); addSection('Extra', extraGuests, false) }

    const safeName = (eventTitle || 'event').replace(/[^\w\-_.]/g, '_')
    openAsXls(rows, safeName, 'Report')
  },

  // ── Closed-event report downloads ─────────────────────────────────────
  // A past event's inside view: the live list is retired, two frozen reports
  // sit in its place. kind: 'general' (guest list) or 'promoters' (the Export
  // rollup replica). The server builds on demand for events closed before
  // report generation existed, so the buttons always work.
  async downloadReport(e) {
    if (this._downloading) return
    const { kind } = e.currentTarget.dataset
    const { eventId } = this.data
    if (!eventId) return
    this._downloading = true
    wx.showLoading({ title: 'Preparing...', mask: true })
    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'getEventReport', eventId
      })
      wx.hideLoading()
      if (!res || !res.success || !res.report) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: (res && res.message) || 'Report unavailable', icon: 'none' })
        return
      }
      const report = res.report
      const safeName = (report.eventTitle || this.data.eventTitle || 'event').replace(/[^\w\-_.]/g, '_')

      if (kind === 'promoters') {
        // Frozen verbatim: the same row matrix the Export button produced.
        openAsXls((report.promoterReport && report.promoterReport.rows) || [], safeName + '_promoters', 'Report')
        return
      }

      // General report: header block, then Name / Promoter / Arrival rows
      // grouped into clearly separated per-list blocks (Party, After Party,
      // Late After Party, Extra, Waiting) — a section header with its count
      // and a blank line before each block.
      const lr = report.listReport || {}
      const h = lr.header || {}
      const rows = []
      rows.push([h.title || report.eventTitle || ''])
      rows.push([h.venue || report.venueName || ''])
      rows.push(['Arrived: ' + (h.arrived || 0) + ' / Waiting: ' + (h.waiting || 0) + ' / Registered: ' + (h.total || 0)])
      rows.push([])
      rows.push(['Name', 'Promoter', 'Arrival'])
      const bySection = {}
      const sectionOrder = []
      ;(lr.rows || []).forEach(r => {
        const sec = r.section || 'Other'
        if (!bySection[sec]) { bySection[sec] = []; sectionOrder.push(sec) }
        bySection[sec].push(r)
      })
      sectionOrder.forEach(sec => {
        rows.push([])
        rows.push([sec + ' (' + bySection[sec].length + ')'])
        bySection[sec].forEach(r => {
          rows.push([r.name || '', r.promoter || '', r.arrival || ''])
        })
      })
      openAsXls(rows, safeName + '_guests', 'Report')
    } catch (err) {
      wx.hideLoading()
      console.error('[event-guests] report error:', err)
      wx.showToast({ title: 'Download failed', icon: 'none' })
    } finally {
      this._downloading = false
    }
  },

  async confirmCloseEvent() {
    const { eventId, eventTitle } = this.data
    let confirmed = false
    try {
      const modal = await wx.showModal({
        title: 'Close Event',
        content: `Close "${eventTitle}"?`,
        confirmText: 'Close',
        confirmColor: '#FF3B30',
        cancelText: 'Cancel'
      })
      confirmed = modal.confirm
    } catch (_) {}
    if (!confirmed) return

    wx.showLoading({ title: 'Saving...', mask: true })
    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'closeEvent',
        eventId,
        closedBy: 'Admin'
      })
      wx.hideLoading()
      if (res && res.success) {
        this.setData({ isClosed: true })
        wx.vibrateShort({ type: 'medium' })
        wx.showToast({ title: 'Event closed!', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 1500)
      } else if (isUnauthorized(res)) {
        handleAuthFailure()
      } else {
        wx.showToast({ title: (res && res.message) || 'Close failed', icon: 'none', duration: 3000 })
      }
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: String(e && e.message || 'Connection error'), icon: 'none', duration: 3000 })
    }
  }
})

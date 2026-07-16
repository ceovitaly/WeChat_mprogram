const { callFunction } = require('../../../utils/request')
const { CLOUD_FUNCTIONS } = require('../../../utils/constants')
const { isUnauthorized, handleAuthFailure } = require('../../../utils/auth')
const { buildInternalRoleMap, annotateInternalRole } = require('../../../utils/phoneMatch')

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
    loading: true,
    lastUpdated: '',
    isClosed: false,
    isAdmin: false,
    promoters: [],
    staffList: []
  },

  onLoad(options) {
    const userInfo = getApp().globalData.userInfo
    this.setData({
      eventId: options.eventId || '',
      eventTitle: options.eventTitle ? decodeURIComponent(options.eventTitle) : '',
      venueName: options.venueName ? decodeURIComponent(options.venueName) : '',
      isAdmin: !!(userInfo && userInfo.role === 'admin')
    })
    this._fetch()
    this._fetchPromoters()
    this._fetchStaff()
    this._timer = setInterval(() => this._fetch(), 10000)
  },

  onUnload() {
    if (this._timer) clearInterval(this._timer)
  },

  async _fetchPromoters() {
    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, { action: 'getPromoters' })
      if (isUnauthorized(res)) { handleAuthFailure(); return }
      if (!res || !res.success) return // tolerant read — badges just no-op
      this.setData({ promoters: res.data || [] })
    } catch (_) {}
  },

  // Full staff roster (for phone-matching guests against internal people) — distinct
  // from `dutyStaff` below, which is who's clocked in to work *this* event.
  async _fetchStaff() {
    try {
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_STAFF, { action: 'getAll' })
      if (isUnauthorized(res)) { handleAuthFailure(); return }
      if (!res || !res.success) return // tolerant read — badges just no-op
      this.setData({ staffList: res.data || [] })
    } catch (_) {}
  },

  async _fetch() {
    const { eventId } = this.data
    if (!eventId) return
    try {
      const regRes = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, { action: 'getRegistrations', eventId })
      if (!regRes || !regRes.success) {
        this.setData({ loading: false })
        if (isUnauthorized(regRes)) { handleAuthFailure(); return }
        wx.showToast({ title: 'Load failed', icon: 'none' })
        return
      }
      const regs = regRes.data || []
      // Duty staff (workedEventIds contains this event) is resolved server-side inside
      // getRegistrations — the staff collection is not client-readable.
      const dutyStaff = (regRes.dutyStaff || [])
        .map(s => ({ _id: s._id, guestName: s.name, position: 0 }))
      const ev = regRes.event || {}
      let isClosed = !!ev.isClosed
      if (!isClosed && ev.date && ev.endTime) {
        try {
          const parts = ev.date.split('-').map(Number)
          const timeParts = ev.endTime.split(':').map(Number)
          const endDt = new Date(parts[0], parts[1] - 1, parts[2], timeParts[0], timeParts[1], 0, 0)
          if (timeParts[0] < 12) endDt.setDate(endDt.getDate() + 1)
          if (!isNaN(endDt.getTime()) && new Date() > endDt) {
            isClosed = true
            callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
              action: 'closeEvent',
              eventId: this.data.eventId,
              closedBy: 'Auto'
            }).catch(() => {})
          }
        } catch (_) {}
      }
      const p = Number(ev.partyCapacity) || 0
      const ap = Number(ev.afterPartyCapacity) || 0
      const lap = Number(ev.lateAfterPartyCapacity) || 0
      const groupOrder = { 'P': 0, 'AP': 1, 'LAP': 2, '': 3 }
      const roleMap = buildInternalRoleMap(this.data.staffList, this.data.promoters)
      const arrived = regs
        .filter(g => g.arrivedAt)
        .sort(compareArrival)
        .map((g, i) => {
          const num = i + 1
          let group = ''
          if (p > 0 && num <= p) group = 'P'
          else if (ap > 0 && num <= p + ap) group = 'AP'
          else if (lap > 0 && num <= p + ap + lap) group = 'LAP'
          return { ...g, position: num, group }
        })
        .sort((a, b) => (groupOrder[a.group] ?? 3) - (groupOrder[b.group] ?? 3))
        .map(g => annotateInternalRole(g, roleMap))
      const pending = regs.filter(g => !g.arrivedAt).map(g => annotateInternalRole(g, roleMap))

      const arrivedSections = this._buildSections(arrived, p, ap, lap)

      const now = new Date()
      const lastUpdated = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0')

      const userInfo = getApp().globalData.userInfo
      const update = { dutyStaff, arrivedGuests: arrived, arrivedSections, pendingGuests: pending, totalRegistered: regs.length, loading: false, lastUpdated, isClosed, eventDate: ev.date || '' }
      if (userInfo) update.isAdmin = userInfo.role === 'admin'
      this.setData(update)
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  _buildSections(arrivedList, p, ap, lap) {
    const sectionDefs = [
      { label: 'Party', tag: 'P' },
      { label: 'After Party', tag: 'AP' },
      { label: 'Late After Party', tag: 'LAP' },
      { label: 'Overflow', tag: '' }
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
        guests: buckets[s.tag].slice().sort((a, b) => a.position - b.position)
      }))
  },

  onRefresh() {
    this.setData({ loading: true })
    this._fetch()
  },

  exportCSV() {
    const { eventId, eventTitle, venueName, eventDate, arrivedGuests, dutyStaff, promoters } = this.data

    // Promoters who physically attended this event, per their own attendedEventIds field
    // (written by the counter's guest-list attendance-marking button) — authoritative,
    // replaces the old name/promoCode guesswork against arrivedGuests.
    const presentPromoters = new Set(
      promoters
        .filter(p => (p.attendedEventIds || []).includes(eventId))
        .map(p => (p.name || '').toLowerCase().trim())
    )

    // Group guests by promoter name, sorted by count desc
    const groupByPromoter = (guests) => {
      const map = {}
      guests.forEach(g => {
        const key = g.promoterName || '—'
        map[key] = (map[key] || 0) + 1
      })
      return Object.entries(map).sort((a, b) => b[1] - a[1])
    }

    const partyGuests = arrivedGuests.filter(g => g.group === 'P')
    const apGuests    = arrivedGuests.filter(g => g.group === 'AP')
    const lapGuests   = arrivedGuests.filter(g => g.group === 'LAP')
    const extraGuests = arrivedGuests.filter(g => g.group === '' || (g.group !== 'P' && g.group !== 'AP' && g.group !== 'LAP'))

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
      if (includeDuty) dutyStaff.forEach(s => rows.push([s.guestName + ' [*]', 'Counter']))
      groupByPromoter(guests).forEach(([name, count]) => {
        const marker = presentPromoters.has(name.toLowerCase().trim()) ? ' *' : ''
        rows.push([name + marker, count])
      })
    }

    if (dutyStaff.length > 0 || partyGuests.length > 0) addSection('Party', partyGuests, true)
    if (apGuests.length > 0) { rows.push([]); addSection('After Party', apGuests, false) }
    if (lapGuests.length > 0) { rows.push([]); addSection('Late After Party', lapGuests, false) }
    if (extraGuests.length > 0) { rows.push([]); addSection('Extra', extraGuests, false) }

    const csv = rows.map(row =>
      row.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(',')
    ).join('\n')
    const safeName = (eventTitle || 'event').replace(/[^\w\-_.]/g, '_')
    const filePath = wx.env.USER_DATA_PATH + '/' + safeName + '_' + Date.now() + '.xls'
    wx.getFileSystemManager().writeFile({
      filePath,
      data: '﻿' + csv,
      encoding: 'utf8',
      success: () => {
        wx.openDocument({
          filePath,
          fileType: 'xls',
          showMenu: true,
          fail: () => wx.showToast({ title: 'Export failed', icon: 'none' })
        })
      },
      fail: () => wx.showToast({ title: 'Export failed', icon: 'none' })
    })
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

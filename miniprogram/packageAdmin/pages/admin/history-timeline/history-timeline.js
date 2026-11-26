const { callFunction } = require('../../../../utils/request')
const { CLOUD_FUNCTIONS } = require('../../../../utils/constants')
function decode(value) { try { return decodeURIComponent(value || '') } catch (_) { return value || '' } }
const FILTERS = ['All', 'Admin', 'Counter', 'Promoter', 'Guest', 'System', 'Security']
const ACTIONS = { EVENT_CREATED: 'created event', EVENT_UPDATED: 'updated event', EVENT_COMPLETED: 'completed event',
  EVENT_DELETED: 'deleted event', STAFF_ADDED: 'added employee', STAFF_REMOVED: 'removed employee',
  STAFF_ROLE_CHANGED: 'changed employee rights', VENUE_PASSWORD_CHANGED: 'changed venue password',
  GUEST_REGISTERED: 'joined the guest list', GUEST_SWITCHED: 'changed registration',
  GUEST_REGISTRATION_CANCELLED: 'cancelled registration', QR_CHECKIN: 'checked in via QR',
  QR_SCAN: 'scanned QR after check-in', EVENT_AUTO_COMPLETED: 'automatically completed event',
  MANUAL_CHECKIN: 'checked in guest', MANUAL_CHECKIN_NO_SCAN: 'checked in guest — NO SCAN',
  GUEST_UNCHECKED: 'removed arrival', COUNTER_LOGIN_SUCCESS: 'logged into venue',
  COUNTER_LOGIN_DENIED: 'was denied venue access', COUNTER_INVALID_PASSWORD: 'entered an invalid venue password',
  COUNTER_LOGOUT: 'logged out', COUNTER_SESSION_EXPIRED: 'session expired',
  COUNTER_FORCE_LOGOUT: 'ended Counter Session', COUNTER_ACCESS_REVOKED: 'revoked Counter access' }
function shanghai(value) {
  const raw = value && value.$date !== undefined ? value.$date : value
  const d = new Date(raw)
  return isNaN(d.getTime()) ? '—' : new Date(d.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19)
}
function decorate(row) {
  const type = row.type || ''
  const color = /DENIED|INVALID|REMOVED|CANCELLED|DELETED|REVOKED/.test(type) ? 'red'
    : /UPDATED|CHANGED|UNCHECKED/.test(type) ? 'orange'
      : /CREATED|LOGIN_SUCCESS|STAFF_ADDED/.test(type) ? 'blue'
        : /REGISTERED|CHECKIN|QR_|GUEST_SWITCHED/.test(type) ? 'green' : 'gray'
  const details = row.details || {}
  const diff = Object.keys(details).filter(k => details[k] && Object.prototype.hasOwnProperty.call(details[k], 'from'))
    .map(k => k + ': ' + String(details[k].from == null ? '—' : details[k].from) + ' → ' + String(details[k].to == null ? '—' : details[k].to))
  return { ...row, timeLabel: shanghai(row.at), actorLabel: row.actorName || row.staffName || row.adminName || 'System',
    roleLabel: row.actorRole || row.role || 'system', actionLabel: ACTIONS[type] || type.replace(/_/g, ' ').toLowerCase(),
    objectLabel: row.targetName || row.eventTitle || row.venueName || '—', color,
    detailsLabel: diff.join(' · ') || (details.previousEventTitle ? 'From ' + details.previousEventTitle : '') }
}
Page({
  data: { venueId: '', eventId: '', title: 'Activity Timeline', filters: FILTERS, filter: 'All',
    rows: [], offset: 0, hasMore: true, loading: false, search: '', from: '', to: '' },
  onLoad(options) {
    if ((getApp().globalData.userInfo || {}).role !== 'admin') { wx.reLaunch({ url: '/pages/register/register' }); return }
    this.setData({ venueId: options.venueId || '', eventId: options.eventId || '',
      title: decode(options.eventTitle || options.venueName || 'Activity Timeline') })
    this.load(true)
  },
  changeFilter(e) { this.setData({ filter: e.currentTarget.dataset.filter }); this.load(true) },
  searchInput(e) { this.setData({ search: e.detail.value }); clearTimeout(this._searchTimer); this._searchTimer = setTimeout(() => this.load(true), 350) },
  fromChange(e) { this.setData({ from: e.detail.value }); this.load(true) },
  toChange(e) { this.setData({ to: e.detail.value }); this.load(true) },
  onUnload() { clearTimeout(this._searchTimer) },
  async load(reset) {
    if (this.data.loading || (!reset && !this.data.hasMore)) return
    this.setData({ loading: true })
    try {
      const from = this.data.from ? Date.parse(this.data.from + 'T00:00:00+08:00') : null
      const to = this.data.to ? Date.parse(this.data.to + 'T00:00:00+08:00') + 86400000 - 1 : null
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, {
        action: 'historyTimeline', venueId: this.data.venueId, eventId: this.data.eventId,
        role: this.data.filter, search: this.data.search, from, to,
        offset: reset ? 0 : this.data.offset, limit: 30
      })
      if (!res || !res.success) throw new Error('History unavailable')
      const rows = (res.data || []).map(decorate)
      this.setData({ rows: reset ? rows : this.data.rows.concat(rows), offset: res.nextOffset, hasMore: res.hasMore })
    } catch (_) { wx.showToast({ title: 'History unavailable', icon: 'none' }) }
    finally { this.setData({ loading: false }) }
  },
  loadMore() { this.load(false) }
})

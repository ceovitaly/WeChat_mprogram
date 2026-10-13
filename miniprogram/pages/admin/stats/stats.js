const { callFunction } = require('../../../utils/request')
const { isUnauthorized, handleAuthFailure } = require('../../../utils/auth')

// Stats — promoter leaderboard: every promoter with the number of registered
// guests attributed to them (all-time, the same counting the Promoters page
// shows per row), sorted largest first so the top of the list is the top
// performer. Counts come server-side (getPromoterGuestCounts) — the guest
// roster itself never travels to the phone.
Page({
  data: {
    loading: true,
    rows: []
  },

  onShow() {
    this._load()
  },

  async _load() {
    this.setData({ loading: true })
    try {
      const [promoRes, countsRes] = await Promise.all([
        callFunction('manageApplications', { action: 'getPromoters' }),
        callFunction('manageApplications', { action: 'getPromoterGuestCounts' }).catch(() => null)
      ])
      if (!promoRes || !promoRes.success) {
        if (isUnauthorized(promoRes)) { handleAuthFailure(); return }
        wx.showToast({ title: 'Load failed', icon: 'none' })
        return
      }
      const counts = (countsRes && countsRes.counts) || {}
      const codeCounts = (countsRes && countsRes.codeCounts) || {}
      const countGuests = (p) => counts[p._id] ||
        (p.promoCode && codeCounts[p.promoCode.toUpperCase()]) || 0
      const rows = (promoRes.data || [])
        .map(p => ({
          _id: p._id,
          name: p.name || '—',
          avatarLetter: p.name ? p.name[0].toUpperCase() : '?',
          guestCount: countGuests(p)
        }))
        .sort((a, b) => b.guestCount - a.guestCount || a.name.localeCompare(b.name))
      this.setData({ rows, loading: false })
    } catch (err) {
      console.error('[Stats] fetch error:', err)
      this.setData({ loading: false })
      wx.showToast({ title: 'Load failed', icon: 'none' })
    }
  }
})

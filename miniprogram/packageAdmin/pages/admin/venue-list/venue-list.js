const { callFunction } = require('../../../../utils/request')
const { CLOUD_FUNCTIONS } = require('../../../../utils/constants')
const { isUnauthorized, handleAuthFailure } = require('../../../../utils/auth')
const refCache = require('../../../../utils/refCache')

Page({
  data: {
    venues: [],
    loading: false
  },

  onShow() {
    this._fetchVenues()
  },

  // Venue *management* screen: always reads fresh rather than through the reference
  // cache (it runs on every onShow, including the return from venue-edit, where
  // stale data would be plainly wrong), and shares the result so event-edit's venue
  // picker can skip its own fetch.
  async _fetchVenues() {
    this.setData({ loading: true })
    try {
      // Server-side read — the venues collection is not client-readable.
      const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, { action: 'getVenues' })
      if (!res || !res.success) {
        if (isUnauthorized(res)) { handleAuthFailure(); return }
        wx.showToast({ title: 'Load failed', icon: 'none' })
        return
      }
      refCache.set(refCache.KEYS.VENUES, res.data || [])
      this.setData({ venues: res.data || [] })
    } catch (err) {
      console.error('[VenueList] fetch error:', err)
      wx.showToast({ title: 'Load failed', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  goCreate() {
    wx.navigateTo({ url: '/packageAdmin/pages/admin/venue-edit/venue-edit' })
  },

  goEdit(e) {
    const { id } = e.currentTarget.dataset
    console.log('[goEdit] navigating to:', `/packageAdmin/pages/admin/venue-edit/venue-edit?id=${id}`)
    wx.navigateTo({ url: `/packageAdmin/pages/admin/venue-edit/venue-edit?id=${id}` })
  },

  confirmDelete(e) {
    const { id, name } = e.currentTarget.dataset
    wx.showModal({
      title: 'Delete Venue',
      content: `Remove "${name}"?`,
      confirmColor: '#FF3B30',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      success: async ({ confirm }) => {
        if (!confirm) return
        wx.showLoading({ title: 'Deleting...' })
        try {
          const res = await callFunction(CLOUD_FUNCTIONS.MANAGE_APPLICATIONS, { action: 'deleteVenue', id })
          if (!res || !res.success) {
            if (isUnauthorized(res)) { handleAuthFailure(); return }
            wx.showToast({ title: (res && res.message) || 'Delete failed', icon: 'none' })
            return
          }
          refCache.invalidate(refCache.KEYS.VENUES)
          wx.vibrateShort({ type: 'medium' })
          wx.showToast({ title: 'Deleted', icon: 'success' })
          // _fetchVenues re-seeds the cache with the post-delete list.
          await this._fetchVenues()
        } catch (err) {
          console.error('[VenueList] delete error:', err)
          wx.showToast({ title: 'Error', icon: 'none' })
        } finally {
          wx.hideLoading()
        }
      }
    })
  }
})

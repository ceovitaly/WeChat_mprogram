const app = getApp();
const { callFunction, getTempUrls } = require('../../utils/cloud.js');

// resolveCloudUrls: fileID -> displayable https URL. Primary path is the
// server-side resolver (cross-account reliable), direct client resolution is
// the fallback — same pattern as resolveEventImages in utils/cloud.js.
async function resolveCloudUrls(fileIDs) {
  var map = {};
  if (!fileIDs || fileIDs.length === 0) return map;
  var remaining = fileIDs.slice();
  try {
    for (var i = 0; i < remaining.length; i += 50) {
      var batch = remaining.slice(i, i + 50);
      var result = await callFunction('clientAuth', { action: 'resolveImages', fileList: batch });
      var batchMap = (result && result.urlMap) || {};
      Object.keys(batchMap).forEach(function(k) { map[k] = batchMap[k]; });
    }
    remaining = fileIDs.filter(function(u) { return !map[u]; });
  } catch (err) { /* fall through to direct */ }
  if (remaining.length > 0) {
    try {
      var direct = await getTempUrls(remaining);
      Object.keys(direct).forEach(function(k) { if (direct[k]) map[k] = direct[k]; });
    } catch (err2) { /* leave unresolved — tiles/photos degrade gracefully */ }
  }
  return map;
}

// Gallery — tiles with venue logos; tapping a tile opens that venue's photo
// gallery as a second page on the SAME route (system nav bar title switches
// to the venue name, system back returns to the tiles). Venues and photos
// are managed from the admin panel (getVenueGalleries carries only public
// display fields).
Page({
  data: {
    loading: true,
    venues: [],
    // 'tiles' = the venue grid, 'photos' = one venue's gallery
    view: 'tiles',
    currentVenue: null
  },

  onLoad(query) {
    this._venueId = (query && query.venueId) || '';
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this.loadVenues();
    });
  },

  async loadVenues() {
    if (!this.cloud) return;
    this.setData({ loading: true });
    try {
      const res = await this.cloud.callFunction({
        name: 'clientAuth',
        data: { action: 'getVenueGalleries' }
      });
      const result = (res && res.result) || {};
      if (!result.success) throw new Error(result.message || 'failed');

      // Resolve every cloud:// fileID (logos + photos) to temp https URLs.
      const fileIDs = [];
      (result.data || []).forEach(v => {
        if (v.logo) fileIDs.push(v.logo);
        (v.photos || []).forEach(p => fileIDs.push(p));
      });
      const urlMap = await resolveCloudUrls(fileIDs);

      const venues = (result.data || [])
        .filter(v => v.photos && v.photos.length > 0)
        .map(v => ({
        _id: v._id,
        name: v.name,
        logo: (v.logo && urlMap[v.logo]) || '',
        letter: v.name ? v.name[0].toUpperCase() : '?',
        preview: v.photos && v.photos.length > 0 ? (urlMap[v.photos[0]] || '') : '',
        photos: (v.photos || []).map(p => urlMap[p] || '')
      }));

      // Direct link to one venue's photos (gallery?venueId=...): select it
      // instead of the tiles, with the venue name in the nav bar.
      if (this._venueId) {
        const venue = venues.find(v => v._id === this._venueId);
        if (venue) {
          this.setData({ venues, view: 'photos', currentVenue: venue, loading: false });
          wx.setNavigationBarTitle({ title: venue.name });
          return;
        }
      }
      this.setData({ venues, loading: false });
    } catch (err) {
      console.error('[gallery] load failed:', err);
      this.setData({ loading: false });
      wx.showToast({ title: 'Failed to load', icon: 'none' });
    }
  },

  openVenue(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: '/pages/gallery/gallery?venueId=' + id });
  },

  previewPhoto(e) {
    const { url } = e.currentTarget.dataset;
    const venue = this.data.currentVenue;
    if (!url || !venue) return;
    const urls = venue.photos.filter(Boolean);
    wx.previewImage({ current: url, urls: urls.length ? urls : [url] });
  },

  onPullDownRefresh() {
    this.loadVenues();
    wx.stopPullDownRefresh();
  }
});

const app = getApp();
const auth = require('../../utils/auth.js');
const { resolveEventImages, callFunction } = require('../../utils/cloud.js');

// Short competitor-style datetime line ("Sat, Jul 18 • 22:00") for the
// info block and the related-events cards. Rendered uppercase via CSS
// (text-transform), so the string itself stays mixed-case.
var DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatShortDatetime(dateStr, startTime) {
  if (!dateStr) return '';
  var parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr + (startTime ? ' • ' + startTime : '');
  var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  var s = DAYS_SHORT[d.getDay()] + ', ' + MONTHS_SHORT[d.getMonth()] + ' ' + d.getDate();
  return s + (startTime ? ' • ' + startTime : '');
}

Page({
  data: {
    event: null,
    isRegistered: false,
    hasProfile: null,
    showTicketModal: false,
    showRegisterPrompt: false,
    joinSuccess: false,
    selectedTicketId: '',
    selectedTicketName: '',
    selectedTicketPrice: 0,
    selectedPackageLink: '',
    heroHeight: 560,
    heroLoaded: false,
    relatedEvents: []
  },

  onLoad: function(options) {
    // Hero = 40% of screen height, min 280rpx, max 560rpx (in px, converted to rpx)
    const { windowHeight, windowWidth } = wx.getWindowInfo();
    const rpxPerPx = 750 / windowWidth;
    const heroH = Math.round(Math.min(Math.max(windowHeight * 0.40, 280 / rpxPerPx), 560 / rpxPerPx) * rpxPerPx);
    this.setData({ heroHeight: heroH });

    this._autoTicket = options.autoTicket === '1';
    app.getCloud((cloud) => {
      this.cloud = cloud;
      const id = options.id || options.eventId;
      if (id) this.getEventDetails(id);
      this.checkProfile();
    });
  },

  getEventDetails: function(id) {
    wx.showLoading({ title: 'Loading...' });
    const db = this.cloud.database();
    db.collection('events').doc(id).get({
      success: async res => {
        const event = res.data;

        // Resolve every cloud:// URL (promoImage/coverImage/promoImages/
        // promoMaterials) in one batched call; mutates `event` in place.
        await resolveEventImages([event]);

        // Главное фото — берём первое доступное
        if (!event.promoImage) {
          if (event.promoImages && event.promoImages.length > 0) {
            event.promoImage = event.promoImages[0];
          } else if (event.coverImage) {
            event.promoImage = event.coverImage;
          }
        }

        event.displayDatetimeShort = formatShortDatetime(event.date, event.startTime);
        this.setData({ event });
        wx.setNavigationBarTitle({ title: event.title || '' });

        this.loadVenueInfo(event);

        wx.hideLoading();
        this.checkIfRegistered(id);
        // Deferred: the main event has rendered; this only fills the
        // "You May Also Like" strip at the bottom of the scroll.
        this.loadRelatedEvents(id);
        if (this._autoTicket) {
          this._autoTicket = false;
          this.openTicketModal();
        }
      },
      fail: err => {
        wx.hideLoading();
        console.error(err);
      }
    });
  },

  // Venue address + coordinates live in the venues collection, which is
  // locked to no-client-access (venue docs also carry the door password),
  // so the lookup goes through the clientAuth cloud function's getVenue
  // action — it reads server-side in the shared env and returns only the
  // safe display fields. The server keeps the venueId-first, venueName-
  // fallback priority (venueId is what the admin app writes today; older
  // events only carry the venueName string), and on duplicate venue names
  // the name lookup returns the newest-edited doc (updatedAt desc).
  loadVenueInfo: function(event) {
    if (!event.venueId && !event.venueName) return;
    var apply = this.applyVenue.bind(this);
    callFunction('clientAuth', {
      action: 'getVenue',
      venueId: event.venueId || '',
      venueName: event.venueName || ''
    }).then(function(res) {
      if (res && res.success && res.venue) apply(res.venue);
    }).catch(function(err) {
      console.error('[event-detail] loadVenueInfo failed:', err);
    });
  },

  // Older venue docs store coordinates as coordinates.lat/lng instead of
  // latitude/longitude — same fallback the admin app's venue-edit reads.
  // The address is applied even without coordinates (the mini-map hides
  // itself via wx:if, the address still shows).
  applyVenue: function(v) {
    if (!v) return;
    var lat = v.latitude || (v.coordinates && v.coordinates.lat) || 0;
    var lng = v.longitude || (v.coordinates && v.coordinates.lng) || 0;
    var patch = { 'event.venueAddress': v.address || '' };
    if (lat && lng) {
      patch['event.venueLatitude'] = lat;
      patch['event.venueLongitude'] = lng;
    }
    this.setData(patch);
  },

  checkProfile: function() {
    // hasProfile mirrors the central auth state: anonymous (no guest
    // record, or explicitly logged out) sees the register prompt.
    auth.getAuth((profile) => {
      this.setData({ hasProfile: !!profile });
    });
  },

  goRegister: function() {
    const eventId = this.data.event && this.data.event._id;
    if (eventId) {
      try { wx.setStorageSync('pendingEventId', eventId); } catch(e) {}
    }
    wx.navigateTo({ url: '/pages/register/register' });
  },

  checkIfRegistered: function(eventId) {
    // Gate on auth state: anonymous users never see "on the list".
    // Waiting on getAuth (which itself awaits openid) fixes the cold-start
    // race where a sync globalData.openid read silently skipped the check.
    auth.getAuth((profile) => {
      if (!profile) {
        this.setData({ isRegistered: false });
        return;
      }
      const db = this.cloud.database();
      db.collection('registrations').where({
        _openid: profile._openid,
        eventId: eventId
      }).get({
        success: res => {
          if (res.data.length > 0) {
            this.setData({ isRegistered: true });
          }
        },
        fail: err => console.error('Check registration failed:', err)
      });
    });
  },

  openTicketModal: function() {
    if (this.data.hasProfile === false) {
      this.setData({ showRegisterPrompt: true });
      return;
    }
    var event = this.data.event;
    var autoId = '';
    var autoName = '';
    if (event && event.isFree && (!event.tickets || event.tickets.length === 0)) {
      autoId = 'free';
      autoName = 'Free Entry';
    }
    this.setData({ showTicketModal: true, selectedTicketId: autoId, selectedTicketName: autoName, selectedTicketPrice: 0 });
  },

  selectTicket: function(e) {
    const { id, name, price, link } = e.currentTarget.dataset;
    this.setData({ selectedTicketId: id, selectedTicketName: name, selectedTicketPrice: price || 0, selectedPackageLink: link || '' });
  },

  selectPackage: function(e) {
    const { idx, name, link } = e.currentTarget.dataset;
    this.setData({
      selectedTicketId: 'pkg_' + idx,
      selectedTicketName: name,
      selectedTicketPrice: 0,
      selectedPackageLink: link || ''
    });
  },

  // PACKAGES section rows: open the ticket sheet with the tapped package
  // preselected — same anonymous-user gate as openTicketModal, same
  // selection shape as selectPackage.
  openPackageFromList: function(e) {
    if (this.data.hasProfile === false) {
      this.setData({ showRegisterPrompt: true });
      return;
    }
    var idx = e.currentTarget.dataset.idx;
    var pkgs = (this.data.event && this.data.event.paidPackages) || [];
    var pkg = pkgs[idx];
    if (!pkg) return;
    this.setData({
      showTicketModal: true,
      selectedTicketId: 'pkg_' + idx,
      selectedTicketName: pkg.name,
      selectedTicketPrice: 0,
      selectedPackageLink: pkg.paymentLink || ''
    });
  },

  closeTicketModal: function() {
    this.setData({ showTicketModal: false, joinSuccess: false, selectedTicketId: '', selectedTicketName: '', selectedTicketPrice: 0, selectedPackageLink: '' });
  },

  closeRegisterPrompt: function() {
    this.setData({ showRegisterPrompt: false });
  },

  handleJoin: function() {
    if (this.data.isRegistered) {
      this.setData({ showTicketModal: false });
      wx.showToast({ title: 'Already registered!', icon: 'none' });
      return;
    }

    const type = this.data.selectedTicketId;
    if (!type) {
      wx.showToast({ title: 'Select a ticket type', icon: 'none' });
      return;
    }

    auth.getAuth((guest) => {
      if (!guest) {
        // Anonymous: route into the existing register flow (which stores
        // pendingEventId via goRegister) instead of the old dead-end
        // "go to Profile tab" modal — the app has no tab bar.
        this.setData({ showTicketModal: false, showRegisterPrompt: true });
        return;
      }

      wx.showLoading({ title: 'Registering...', mask: true });
      const db = this.cloud.database();
      const eventId = this.data.event._id;

      // Just-in-time dedup: re-query right before the add in case the
      // isRegistered flag was stale (auto-filtered by _openid, so any hit
      // is this user's registration).
      db.collection('registrations').where({ eventId }).get({
        success: dupRes => {
          if (dupRes.data.length > 0) {
            wx.hideLoading();
            this.setData({ isRegistered: true, showTicketModal: false, selectedTicketId: '' });
            wx.showToast({ title: 'Already registered!', icon: 'none' });
            return;
          }

          db.collection('registrations').add({
            data: {
              eventId,
              eventTitle: this.data.event.title,
              eventDate: this.data.event.date,
              guestName: guest.nickName || guest.name || guest.phone || '',
              guestAvatar: guest.avatarUrl || '',
              promoCode: guest.promoCode || '',
              promoterName: guest.promoterName || '',
              ticketType: this.data.selectedTicketName || type,
              status: 'confirmed',
              createdAt: db.serverDate()
            },
            success: () => {
              wx.hideLoading();
              // Presentation change only: the sheet's content swaps to an
              // animated "You're on the list" state (see .join-success in
              // the wxss) for ~1.2s instead of a toast, then the sheet
              // closes and the same navigation as before happens.
              this.setData({ isRegistered: true, joinSuccess: true, selectedTicketId: '' });
              wx.vibrateShort();
              const pkgLink = this.data.selectedPackageLink;
              setTimeout(() => {
                this.setData({ showTicketModal: false, joinSuccess: false });
                if (pkgLink) {
                  wx.navigateTo({ url: '/pages/webview/webview?url=' + encodeURIComponent(pkgLink) });
                } else {
                  wx.navigateTo({ url: '/pages/mytickets/mytickets' });
                }
              }, 1200);
            },
            fail: err => {
              wx.hideLoading();
              console.error('Registration failed:', err);
              wx.showToast({ title: 'Registration failed', icon: 'none' });
            }
          });
        },
        fail: err => {
          wx.hideLoading();
          console.error('Registration dedup check failed:', err);
          wx.showToast({ title: 'Registration failed', icon: 'none' });
        }
      });
    });
  },

  // "You May Also Like": other upcoming events from the same source as
  // the feed — the events collection with a date-only filter (the feed
  // applies no status/visibility filters either, see feed.js
  // fetchEvents/applyFilters), same 5 AM cutoff so night events count as
  // "today" until the morning. Sorted date-then-time ascending like the
  // feed, current event excluded, capped at 8. Images resolved in one
  // batched resolveEventImages call after the feed's promoImages
  // normalization (promoImages -> images -> promoImage -> coverImage).
  loadRelatedEvents: function(currentId) {
    var self = this;
    var db = this.cloud.database();
    var _ = db.command;

    var now = new Date();
    if (now.getHours() < 5) now.setDate(now.getDate() - 1);
    var todayStr = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0');

    db.collection('events')
      .where({ date: _.gte(todayStr) })
      .orderBy('date', 'asc')
      .limit(9)
      .get()
      .then(function(res) {
        var events = (res.data || [])
          .filter(function(e) { return e._id !== currentId; })
          .slice(0, 8);
        if (events.length === 0) return;

        events.sort(function(a, b) {
          var dc = (a.date || '').localeCompare(b.date || '');
          return dc !== 0 ? dc : (a.startTime || '').localeCompare(b.startTime || '');
        });

        events.forEach(function(e) {
          if (!Array.isArray(e.promoImages) || e.promoImages.length === 0) {
            if (Array.isArray(e.images) && e.images.length > 0) e.promoImages = e.images;
            else if (e.promoImage) e.promoImages = [e.promoImage];
            else if (e.coverImage) e.promoImages = [e.coverImage];
            else e.promoImages = [];
          }
        });

        return resolveEventImages(events).then(function(list) {
          list.forEach(function(e) {
            e.cardImage = e.promoImages[0] || '';
            e.displayDatetimeShort = formatShortDatetime(e.date, e.startTime);
          });
          self.setData({ relatedEvents: list });
        });
      })
      .catch(function(err) {
        console.error('[event-detail] loadRelatedEvents failed:', err);
      });
  },

  goToRelated: function(e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/event-detail/event-detail?id=' + id });
  },

  // Fade the hero in on first load (see .hero-image in event-detail.wxss).
  // One shared flag: only the initially-visible image's pop-in is user-
  // visible; later swiper slides load offscreen.
  onHeroLoad: function() {
    if (!this.data.heroLoaded) this.setData({ heroLoaded: true });
  },

  previewHeroImage: function(e) {
    var url = e.currentTarget.dataset.url;
    var urls = this.data.event.promoImages && this.data.event.promoImages.length
      ? this.data.event.promoImages
      : (this.data.event.promoImage ? [this.data.event.promoImage] : []);
    wx.previewImage({ current: url || urls[0], urls: urls.length ? urls : [url] });
  },

  previewMaterial: function(e) {
    const url = e.currentTarget.dataset.url;
    wx.previewImage({
      current: url,
      urls: this.data.event.promoMaterials
    });
  },

  onShareAppMessage: function() {
    const event = this.data.event;
    return {
      title: event.title,
      path: `/pages/event-detail/event-detail?id=${event._id}`,
      imageUrl: event.promoImage || ''
    };
  },

  handleShare: function() {
    wx.showShareMenu({
      withShareTicket: true,
      menus: ['shareAppMessage', 'shareTimeline']
    });
  },

  openMap: function() {
    var event = this.data.event;
    if (!event) return;
    if (event.venueLatitude && event.venueLongitude) {
      wx.openLocation({
        latitude: event.venueLatitude,
        longitude: event.venueLongitude,
        name: event.venueName || '',
        address: event.venueAddress || event.venueName || ''
      });
    } else {
      wx.showToast({ title: 'Location not available', icon: 'none' });
    }
  }
});
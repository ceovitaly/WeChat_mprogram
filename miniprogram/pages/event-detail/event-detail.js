const app = getApp();

Page({
  data: {
    event: null,
    isRegistered: false,
    hasProfile: null,
    showTicketModal: false,
    showRegisterPrompt: false,
    selectedTicketId: '',
    selectedTicketName: '',
    selectedTicketPrice: 0,
    selectedPackageLink: '',
    heroHeight: 560
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
        const cloudUrls = [];

        // Собираем все cloud:// урлы
        if (event.promoImage && event.promoImage.startsWith('cloud://')) {
          cloudUrls.push(event.promoImage);
        }
        if (event.promoImages && Array.isArray(event.promoImages)) {
          event.promoImages.forEach(u => {
            if (u && u.startsWith('cloud://')) cloudUrls.push(u);
          });
        }
        if (event.promoMaterials && Array.isArray(event.promoMaterials)) {
          event.promoMaterials.forEach(u => {
            if (u && u.startsWith('cloud://')) cloudUrls.push(u);
          });
        }
        if (event.coverImage && event.coverImage.startsWith('cloud://')) {
          cloudUrls.push(event.coverImage);
        }

        // Резолвим все урлы за один запрос
        if (cloudUrls.length > 0) {
          try {
            const cfRes = await this.cloud.callFunction({
              name: 'clientAuth',
              data: { action: 'resolveImages', fileList: cloudUrls }
            });
            const urlMap = cfRes.result.urlMap || {};

            if (event.promoImage) event.promoImage = urlMap[event.promoImage] || event.promoImage;
            if (event.coverImage) event.coverImage = urlMap[event.coverImage] || event.coverImage;
            if (event.promoImages) {
              event.promoImages = event.promoImages.map(u => urlMap[u] || u);
            }
            if (event.promoMaterials) {
              event.promoMaterials = event.promoMaterials.map(u => urlMap[u] || u);
            }
          } catch (err) {
            console.error('getTempFileURL error:', err);
          }
        }

        // Главное фото — берём первое доступное
        if (!event.promoImage) {
          if (event.promoImages && event.promoImages.length > 0) {
            event.promoImage = event.promoImages[0];
          } else if (event.coverImage) {
            event.promoImage = event.coverImage;
          }
        }

        if (event.date) {
          const _parts = event.date.split('-');
          const _d = new Date(parseInt(_parts[0], 10), parseInt(_parts[1], 10) - 1, parseInt(_parts[2], 10));
          const _days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
          const _months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
          event.displayDate = _days[_d.getDay()] + ', ' + _d.getDate() + ' ' + _months[_d.getMonth()];
          event.displayDatetime = event.displayDate + (event.startTime ? '  ·  ' + event.startTime : '');
        }
        this.setData({ event });
        wx.setNavigationBarTitle({ title: event.title || '' });

        if (event.venueId) {
          db.collection('venues').doc(event.venueId).get({
            success: function(venueRes) {
              var v = venueRes.data;
              var lat = v.latitude || (v.coordinates && v.coordinates.lat) || 0;
              var lng = v.longitude || (v.coordinates && v.coordinates.lng) || 0;
              if (lat && lng) {
                this.setData({
                  'event.venueLatitude': lat,
                  'event.venueLongitude': lng,
                  'event.venueAddress': v.address || ''
                });
              }
            }.bind(this),
            fail: function() {}
          });
        }

        wx.hideLoading();
        this.checkIfRegistered(id);
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

  checkProfile: function() {
    const db = this.cloud.database();
    db.collection('guests').limit(1).get({
      success: res => {
        this.setData({ hasProfile: res.data.length > 0 });
      },
      fail: () => {
        this.setData({ hasProfile: false });
      }
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
    const openid = app.globalData.openid;
    if (!openid) return;
    const db = this.cloud.database();
    db.collection('registrations').where({
      _openid: openid,
      eventId: eventId
    }).get({
      success: res => {
        if (res.data.length > 0) {
          this.setData({ isRegistered: true });
        }
      },
      fail: err => console.error('Check registration failed:', err)
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

  closeTicketModal: function() {
    this.setData({ showTicketModal: false, selectedTicketId: '', selectedTicketName: '', selectedTicketPrice: 0, selectedPackageLink: '' });
  },

  closeRegisterPrompt: function() {
    this.setData({ showRegisterPrompt: false });
  },

  noop: function() {},

  handleJoin: function() {
    if (this.data.isRegistered) {
      this.setData({ showTicketModal: false });
      wx.showToast({ title: 'Already registered!', icon: 'none' });
      return;
    }

    const openid = app.globalData.openid;
    if (!openid) {
      wx.showModal({
        title: 'Login Required',
        content: 'Please go to Profile tab and log in first.',
        showCancel: false
      });
      return;
    }

    const type = this.data.selectedTicketId;
    if (!type) {
      wx.showToast({ title: 'Select a ticket type', icon: 'none' });
      return;
    }

    wx.showLoading({ title: 'Registering...', mask: true });
    const db = this.cloud.database();
    const eventId = this.data.event._id;

    // Берём данные гостя
    db.collection('guests').limit(1).get({
      success: userRes => {
        if (userRes.data.length === 0) {
          wx.hideLoading();
          wx.showModal({
            title: 'Profile Empty',
            content: 'Please complete your profile in the Profile tab first.',
            showCancel: false
          });
          return;
        }

        const guest = userRes.data[0];

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
            this.setData({ isRegistered: true, showTicketModal: false, selectedTicketId: '' });
            wx.vibrateShort();
            const pkgLink = this.data.selectedPackageLink;
            if (pkgLink) {
              wx.showToast({ title: "You're in! 🎉", icon: 'success' });
              setTimeout(() => {
                wx.navigateTo({ url: '/pages/webview/webview?url=' + encodeURIComponent(pkgLink) });
              }, 1200);
            } else {
              wx.showToast({ title: "You're in! 🎉", icon: 'success' });
              setTimeout(() => {
                wx.navigateTo({ url: '/pages/mytickets/mytickets' });
              }, 1500);
            }
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
        console.error('Guest lookup failed:', err);
      }
    });
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
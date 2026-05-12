const app = getApp();

Page({
  data: {
    event: null,
    isRegistered: false,
    showTicketModal: false,
    promoCodeInput: '',
    promoCodeValid: false,
    promoCodeError: '',
    verifiedPromoterName: '',
    verifiedPromoterId: '',
    selectedTicketType: '',
    requireAuth: false
  },

  onLoad: function(options) {
    app.getCloud((cloud) => {
      this.cloud = cloud;

      if (options.id) {
        this.getEventDetails(options.id);
      }

      if (options.eventId) {
        this.getEventDetails(options.eventId);
      }
    });
  },

  getEventDetails: function(id) {
    wx.showLoading({ title: 'Loading...' });
    const db = this.cloud.database();
    db.collection('events').doc(id).get({
      success: async res => {
        const event = res.data;

        if (event.promoImage && event.promoImage.startsWith('cloud://')) {
          try {
            const tempRes = await this.cloud.getTempFileURL({
              fileList: [event.promoImage]
            });
            event.promoImage = tempRes.fileList[0].tempFileURL;
          } catch (err) {
            console.error('promoImage convert error:', err);
          }
        }

        if (event.promoMaterials && event.promoMaterials.length > 0) {
          const cloudUrls = event.promoMaterials.filter(u => u.startsWith('cloud://'));
          if (cloudUrls.length > 0) {
            try {
              const tempRes = await this.cloud.getTempFileURL({ fileList: cloudUrls });
              const urlMap = {};
              tempRes.fileList.forEach(f => { urlMap[f.fileID] = f.tempFileURL; });
              event.promoMaterials = event.promoMaterials.map(u => urlMap[u] || u);
            } catch (err) {
              console.error('promoMaterials convert error:', err);
            }
          }
        }

        this.setData({ event });
        wx.hideLoading();
        this.checkIfRegistered(id);
      },
      fail: err => {
        wx.hideLoading();
        console.error(err);
      }
    });
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
    // Проверяем авторизацию перед открытием модалки
    if (!app.globalData.openid) {
      this.setData({ requireAuth: true });
      return;
    }
    this.setData({ showTicketModal: true });
  },

  closeAuthModal: function() {
    this.setData({ requireAuth: false });
  },

  goToLogin: function() {
    this.setData({ requireAuth: false });
    wx.navigateTo({ url: '/pages/register/register' });
  },

  selectTicketType: function(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({ selectedTicketType: type });
  },

  closeTicketModal: function() {
    this.setData({
      showTicketModal: false,
      promoCodeInput: '',
      promoCodeValid: false,
      promoCodeError: '',
      verifiedPromoterName: '',
      verifiedPromoterId: '',
      selectedTicketType: ''
    });
  },

  onPromoCodeInput: function(e) {
    const val = e.detail.value.toUpperCase();
    this.setData({
      promoCodeInput: val,
      promoCodeValid: false,
      promoCodeError: '',
      verifiedPromoterName: '',
      verifiedPromoterId: ''
    });
  },

  verifyPromoCode: function() {
    const code = this.data.promoCodeInput.trim();
    if (!code) return;

    wx.showLoading({ title: 'Checking...', mask: true });
    const db = this.cloud.database();

    db.collection('promoters').where({
      promoCode: code,
      status: 'approved'
    }).get({
      success: res => {
        wx.hideLoading();
        if (res.data.length > 0) {
          const promoter = res.data[0];
          wx.vibrateShort();
          this.setData({
            promoCodeValid: true,
            promoCodeError: '',
            verifiedPromoterName: promoter.name,
            verifiedPromoterId: promoter._id
          });
        } else {
          this.setData({
            promoCodeValid: false,
            promoCodeError: 'Invalid promo code'
          });
        }
      },
      fail: () => {
        wx.hideLoading();
        this.setData({ promoCodeError: 'Error checking code' });
      }
    });
  },

  handleJoin: function(e) {
    const type = e.currentTarget.dataset.type || this.data.selectedTicketType;
    const openid = app.globalData.openid;

    this.setData({ showTicketModal: false });

    if (!openid) {
      wx.showModal({
        title: 'Login Required',
        content: 'Please go to "Me" tab and log in first.',
        showCancel: false
      });
      return;
    }

    // Проверяем, что промокод верифицирован (обязательное условие)
    if (!this.data.promoCodeValid) {
      wx.showToast({ 
        title: 'Введите и проверьте промокод', 
        icon: 'none' 
      });
      this.setData({ showTicketModal: true });
      return;
    }

    wx.showLoading({ title: 'Registering...' });
    const db = this.cloud.database();
    const eventId = this.data.event._id;
    const verifiedPromoterId = this.data.verifiedPromoterId;
    const verifiedPromoterName = this.data.verifiedPromoterName;

    db.collection('registrations').where({
      _openid: openid,
      eventId: eventId
    }).get({
      success: checkRes => {
        if (checkRes.data.length > 0) {
          wx.hideLoading();
          this.setData({ isRegistered: true });
          wx.showToast({ title: 'Already registered!', icon: 'none' });
          return;
        }

        const tryGuests = () => {
          db.collection('guests').where({ _openid: openid }).get({
            success: userRes => {
              if (userRes.data.length > 0) {
                registerUser(userRes.data[0]);
              } else {
                db.collection('promoters').where({ promoterId: openid }).get({
                  success: promoRes => {
                    if (promoRes.data.length > 0) {
                      registerUser(promoRes.data[0]);
                    } else {
                      wx.hideLoading();
                      wx.showModal({
                        title: 'Profile Empty',
                        content: 'Please set your name in "Me" tab first.',
                        showCancel: false
                      });
                    }
                  },
                  fail: err => {
                    wx.hideLoading();
                    console.error('Promoter lookup failed:', err);
                  }
                });
              }
            },
            fail: err => {
              wx.hideLoading();
              console.error('Guest lookup failed:', err);
            }
          });
        };

        const registerUser = (user) => {
          // Только с верифицированным промокодом
          addRegistration(user, verifiedPromoterId, verifiedPromoterName);
        };

        const addRegistration = (user, promoterId, promoterName) => {
          db.collection('registrations').add({
            data: {
              eventId,
              eventTitle: this.data.event.title,
              eventDate: this.data.event.date,
              guestName: user.nickName || user.name || '',
              guestAvatar: user.avatarUrl || '',
              promoterId,
              promoterName,
              ticketType: type,
              status: 'confirmed',
              createdAt: db.serverDate()
            },
            success: () => {
              wx.hideLoading();
              this.setData({ isRegistered: true });
              wx.vibrateShort();
              wx.showToast({ title: 'You\'re in! 🎉', icon: 'success' });
              setTimeout(() => {
                wx.switchTab({ url: '/pages/mytickets/mytickets' });
              }, 1500);
            },
            fail: err => {
              wx.hideLoading();
              console.error('Registration failed:', err);
            }
          });
        };

        tryGuests();
      },
      fail: err => {
        wx.hideLoading();
        console.error('Check duplicate failed:', err);
      }
    });
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
  }
});
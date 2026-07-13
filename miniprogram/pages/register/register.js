// pages/register/index.js
const app = getApp();

Page({
  data: {
    checking: true,
    step: 'phone', // 'phone' | 'profile'
    phone: '',
    nickName: '',
    promoInput: '',
    promoValid: false,
    promoError: '',
    submitting: false,
    verifiedPromoterId: '',
    verifiedPromoterName: ''
  },

  onLoad() {
    this._checkSession();
  },

  async _checkSession() {
    // If user explicitly logged out, show registration screen
    try {
      if (wx.getStorageSync('loggedOut') === '1') {
        wx.removeStorageSync('loggedOut');
        this.setData({ checking: false });
        return;
      }
    } catch(e) {}

    // Fast path: storage
    try {
      const stored = wx.getStorageSync('userInfo');
      if (stored && stored._id) {
        app.globalData.userInfo = stored;
        wx.reLaunch({ url: '/pages/feed/feed' });
        return;
      }
    } catch(e) {}

    // Fallback: direct DB query (auto-filtered by openid, no CF needed)
    const timer = setTimeout(() => this.setData({ checking: false }), 4000);
    app.getCloud(async (cloud) => {
      try {
        const db = cloud.database();
        const res = await db.collection('guests').limit(1).get();
        clearTimeout(timer);
        if (res.data && res.data.length > 0) {
          app.globalData.userInfo = res.data[0];
          try { wx.setStorageSync('userInfo', res.data[0]); } catch(e) {}
          wx.reLaunch({ url: '/pages/feed/feed' });
        } else {
          this.setData({ checking: false });
        }
      } catch(err) {
        clearTimeout(timer);
        console.error('[checkSession]', err);
        this.setData({ checking: false });
      }
    });
  },

  goBack() {
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages/feed/feed' }),
    });
  },

  // WeChat вернул code для получения телефона
  onGetPhoneNumber(e) {
    console.log('[onGetPhoneNumber] detail:', JSON.stringify(e.detail));
    if (e.detail.errno !== undefined && e.detail.errno !== 0) {
      console.warn('[onGetPhoneNumber] errno:', e.detail.errno);
      return;
    }
    if (!e.detail.code) {
      console.warn('[onGetPhoneNumber] no code in detail');
      return;
    }

    wx.showLoading({ title: 'Verifying...', mask: true });

    app.getCloud(async (cloud) => {
      try {
        const res = await cloud.callFunction({
          name: 'clientAuth',
          data: { action: 'getPhone', phoneCode: e.detail.code, cloudID: e.detail.cloudID },
        });
        wx.hideLoading();
        const { result } = res;
        if (result.success && result.phone) {
          const phone = result.phone;
          try {
            const db = cloud.database();
            const guestRes = await db.collection('guests').limit(1).get();
            if (guestRes.data && guestRes.data.length > 0) {
              app.globalData.userInfo = guestRes.data[0];
              try { wx.setStorageSync('userInfo', guestRes.data[0]); } catch(e) {}
              wx.reLaunch({ url: '/pages/feed/feed' });
              return;
            }
          } catch (e) {
            console.warn('[register] guest lookup failed:', e);
          }
          // Not registered yet — move to the in-page profile step.
          this.setData({ phone, step: 'profile' });
        } else {
          wx.showModal({
            title: 'Phone Error',
            content: (result.message || '?') + '\n' + (result.detail || ''),
            showCancel: false
          });
        }
      } catch (err) {
        wx.hideLoading();
        console.error('[onGetPhoneNumber] exception:', err);
        wx.showToast({ title: 'Connection error', icon: 'none' });
      }
    });
  },

  onNickNameInput(e) {
    this.setData({ nickName: e.detail.value });
  },

  onPromoInput(e) {
    const val = e.detail.value.toUpperCase().trim();
    this.setData({
      promoInput: val,
      promoValid: false,
      promoError: '',
      verifiedPromoterId: '',
      verifiedPromoterName: ''
    });
  },

  verifyPromoCode() {
    const code = this.data.promoInput;
    if (!code) return;

    wx.showLoading({ title: 'Verifying...', mask: true });

    app.getCloud((cloud) => {
      cloud.callFunction({
        name: 'clientAuth',
        data: { action: 'verifyPromoCode', promoCode: code }
      })
      .then(res => {
        wx.hideLoading();
        const result = res.result;
        if (result.success && result.valid) {
          wx.vibrateShort();
          this.setData({
            promoValid: true,
            promoError: '',
            verifiedPromoterId: result.promoterId,
            verifiedPromoterName: result.promoterName
          });
          this._doSubmit();
        } else {
          this.setData({ promoValid: false, promoError: result.message || 'Invalid promo code' });
        }
      })
      .catch(err => {
        wx.hideLoading();
        console.error('[verifyPromoCode] error:', err);
        this.setData({ promoValid: false, promoError: 'Connection error' });
      });
    });
  },

  async _doSubmit() {
    this.setData({ submitting: true });

    app.getCloud(async (cloud) => {
      try {
        const db = cloud.database();
        const profileData = {
          phone: this.data.phone,
          nickName: this.data.nickName,
          promoCode: this.data.promoInput,
          promoterId: this.data.verifiedPromoterId,
          promoterName: this.data.verifiedPromoterName,
          updatedAt: db.serverDate()
        };

        const guestRes = await db.collection('guests').where({ _openid: app.globalData.openid }).get();
        if (guestRes.data.length > 0) {
          await db.collection('guests').doc(guestRes.data[0]._id).update({ data: profileData });
        } else {
          await db.collection('guests').add({ data: { ...profileData, createdAt: db.serverDate() } });
        }

        try { wx.setStorageSync('userInfo', profileData); } catch(e) {}

        // Auto-register for event if user came from an event page
        let pendingEventId;
        try {
          pendingEventId = wx.getStorageSync('pendingEventId');
          if (pendingEventId) wx.removeStorageSync('pendingEventId');
        } catch(e) {}

        if (pendingEventId) {
          try {
            const eventRes = await db.collection('events').doc(pendingEventId).get();
            const event = eventRes.data;
            await db.collection('registrations').add({
              data: {
                eventId: pendingEventId,
                eventTitle: event.title || '',
                eventDate: event.date || '',
                guestName: this.data.nickName || '',
                promoCode: this.data.promoInput || '',
                promoterName: this.data.verifiedPromoterName || '',
                ticketType: 'Free Entry',
                status: 'confirmed',
                createdAt: db.serverDate()
              }
            });
            wx.vibrateShort();
            wx.showToast({ title: "You're in! 🎉", icon: 'success' });
            setTimeout(() => {
              wx.reLaunch({ url: '/pages/mytickets/mytickets' });
            }, 1500);
          } catch(err) {
            console.error('[pendingEvent] registration failed:', err);
            wx.reLaunch({ url: '/pages/feed/feed' });
          }
        } else {
          wx.reLaunch({ url: '/pages/feed/feed' });
        }
      } catch (err) {
        console.error('[_doSubmit] error:', err);
        this.setData({ submitting: false });
        wx.showModal({
          title: 'Error',
          content: 'Could not complete registration',
          showCancel: false
        });
      }
    });
  },

  onSubmit() {
    const { nickName, promoInput } = this.data;
    if (!nickName.trim()) {
      wx.showToast({ title: 'Enter your name', icon: 'none' });
      return;
    }
    if (!promoInput) {
      wx.showToast({ title: 'Enter invite code', icon: 'none' });
      return;
    }
    if (!this.data.promoValid) {
      this.verifyPromoCode();
      return;
    }
    this._doSubmit();
  }
});

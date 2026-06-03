// pages/register/index.js

Page({
  data: {
    showPrivacy: false,
    privacyAgreed: false,
    checking: true,
  },

  onLoad() {
    this._checkSession();
  },

  async _checkSession() {
    // Fast path: storage
    try {
      const stored = wx.getStorageSync('userInfo');
      if (stored && stored._id) {
        const app = getApp();
        app.globalData.userInfo = stored;
        wx.reLaunch({ url: '/pages/feed/feed' });
        return;
      }
    } catch(e) {}

    // Fallback: direct DB query (auto-filtered by openid, no CF needed)
    const app = getApp();
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

  // Нажали "Войти через WeChat"
  onLoginTap() {
    this.setData({ showPrivacy: true });
  },

  // Privacy → Отказ
  onDisagree() {
    this.setData({ showPrivacy: false });
  },

  onAgree() {
    this.setData({ showPrivacy: false, privacyAgreed: true });
  },

  noop() {},

  // WeChat вернул code для получения телефона
  onGetPhoneNumber(e) {
    console.log('[onGetPhoneNumber] detail:', JSON.stringify(e.detail));
    if (e.detail.errno !== undefined && e.detail.errno !== 0) {
      console.warn('[onGetPhoneNumber] errno:', e.detail.errno);
      wx.showToast({ title: 'Phone number required', icon: 'none' });
      this.setData({ privacyAgreed: false });
      return;
    }
    if (!e.detail.code) {
      console.warn('[onGetPhoneNumber] no code in detail');
      wx.showToast({ title: 'Could not get phone number', icon: 'none' });
      this.setData({ privacyAgreed: false });
      return;
    }

    wx.showLoading({ title: 'Verifying...', mask: true });

    const app = getApp();
    app.getCloud(async (cloud) => {
      try {
        console.log('[onGetPhoneNumber] calling clientAuth getPhone...');
        const res = await cloud.callFunction({
          name: 'clientAuth',
          data: { action: 'getPhone', phoneCode: e.detail.code, cloudID: e.detail.cloudID },
        });
        wx.hideLoading();
        console.log('[onGetPhoneNumber] cf result:', JSON.stringify(res.result));
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
          wx.navigateTo({
            url: `/pages/register/promo/promo?phone=${encodeURIComponent(phone)}`,
          });
        } else {
          wx.showModal({
            title: 'Phone Error',
            content: (result.message || '?') + '\n' + (result.detail || ''),
            showCancel: false
          });
          this.setData({ privacyAgreed: false });
        }
      } catch (err) {
        wx.hideLoading();
        console.error('[onGetPhoneNumber] exception:', err);
        wx.showToast({ title: 'Connection error', icon: 'none' });
        this.setData({ privacyAgreed: false });
      }
    });
  },
});
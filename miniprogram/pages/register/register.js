// pages/register/index.js
const app = getApp();
const auth = require('../../utils/auth.js');

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
    verifiedPromoterName: '',
    showPrivacyModal: false
  },

  onLoad() {
    this._checkSession();
  },

  _checkSession() {
    // Central auth check: respects the loggedOut flag (without consuming
    // it) and auto-recognizes a returning user whose guest record exists.
    // Safety timeout so the spinner can't hang if cloud never initializes.
    const timer = setTimeout(() => this.setData({ checking: false }), 4000);
    auth.getAuth((profile) => {
      clearTimeout(timer);
      if (profile) {
        wx.reLaunch({ url: '/pages/feed/feed' });
      } else {
        this.setData({ checking: false });
      }
    });
  },

  goBack() {
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages/feed/feed' }),
    });
  },

  // Privacy-authorization consent gate. app.js's onNeedPrivacyAuthorization
  // fires before getPhoneNumber (the only privacy-sensitive API this app
  // calls) and, finding this page on top, calls this to show the sheet.
  showPrivacyModal() {
    this.setData({ showPrivacyModal: true });
  },

  onAgreePrivacyAuthorization() {
    if (app.globalData.privacyResolve) {
      app.globalData.privacyResolve({ event: 'agree' });
      app.globalData.privacyResolve = null;
    }
    this.setData({ showPrivacyModal: false });
  },

  onDisagreePrivacyAuthorization() {
    if (app.globalData.privacyResolve) {
      app.globalData.privacyResolve({ event: 'disagree' });
      app.globalData.privacyResolve = null;
    }
    this.setData({ showPrivacyModal: false });
  },

  openPrivacyPolicy() {
    wx.navigateTo({ url: '/pages/legal/legal?doc=privacy' });
  },

  openTermsOfService() {
    wx.navigateTo({ url: '/pages/legal/legal?doc=terms' });
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
              // Existing guest signing back in — this clears the
              // loggedOut flag and refreshes the cached profile.
              auth.completeSignIn(guestRes.data[0]);
              this._afterSignIn(cloud, guestRes.data[0]);
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

        // Both queries are auto-filtered by _openid server-side.
        const guestRes = await db.collection('guests').limit(1).get();
        if (guestRes.data.length > 0) {
          await db.collection('guests').doc(guestRes.data[0]._id).update({ data: profileData });
        } else {
          await db.collection('guests').add({ data: { ...profileData, createdAt: db.serverDate() } });
        }

        // Re-read the saved doc so the cached profile carries the server
        // fields (_id/_openid) that queries and fast paths depend on.
        const savedRes = await db.collection('guests').limit(1).get();
        const profile = (savedRes.data && savedRes.data.length > 0) ? savedRes.data[0] : profileData;
        auth.completeSignIn(profile);

        await this._afterSignIn(cloud, profile);
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

  // Shared post-sign-in routing for both the existing-guest sign-in and
  // the fresh-signup flow. If the user came here from an event page
  // (pendingEventId), honor that intent: put them on the list — skipping
  // the add if a registration already exists (registrations queries are
  // auto-filtered by _openid, so any hit is this user's) — and land on
  // My List. Otherwise land on the feed.
  async _afterSignIn(cloud, profile) {
    let pendingEventId;
    try {
      pendingEventId = wx.getStorageSync('pendingEventId');
      if (pendingEventId) wx.removeStorageSync('pendingEventId');
    } catch(e) {}

    if (!pendingEventId) {
      wx.reLaunch({ url: '/pages/feed/feed' });
      return;
    }

    try {
      const db = cloud.database();
      const dup = await db.collection('registrations').where({ eventId: pendingEventId }).get();
      if (!dup.data || dup.data.length === 0) {
        const eventRes = await db.collection('events').doc(pendingEventId).get();
        const event = eventRes.data;
        await db.collection('registrations').add({
          data: {
            eventId: pendingEventId,
            eventTitle: event.title || '',
            eventDate: event.date || '',
            guestName: profile.nickName || '',
            promoCode: profile.promoCode || '',
            promoterName: profile.promoterName || '',
            ticketType: 'Free Entry',
            status: 'confirmed',
            createdAt: db.serverDate()
          }
        });
      }
      wx.vibrateShort();
      wx.showToast({ title: "You're in! 🎉", icon: 'success' });
      setTimeout(() => {
        wx.reLaunch({ url: '/pages/mytickets/mytickets' });
      }, 1500);
    } catch(err) {
      console.error('[pendingEvent] registration failed:', err);
      wx.reLaunch({ url: '/pages/feed/feed' });
    }
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

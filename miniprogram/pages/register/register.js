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
    showPrivacyModal: false,
    consentChecked: false,
    // 'wechat' — phone via WeChat's getPhoneNumber; 'manual' — typed by hand
    // (fallback for accounts bound to non-mainland numbers). The step swaps
    // its content between the two instead of stacking an expanding panel.
    signInMode: 'wechat',
    manualPhoneInput: '',
    manualPhoneError: ''
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

  toggleConsent() {
    this.setData({ consentChecked: !this.data.consentChecked });
  },

  // WeChat вернул code для получения телефона
  onGetPhoneNumber(e) {
    console.log('[onGetPhoneNumber] detail:', JSON.stringify(e.detail));
    const errMsg = e.detail.errMsg || '';
    // The user closed WeChat's own consent sheet — an intentional cancel, no
    // feedback needed.
    if (errMsg.indexOf('deny') !== -1) return;
    if ((e.detail.errno !== undefined && e.detail.errno !== 0) || !e.detail.code) {
      console.warn('[onGetPhoneNumber] errno:', e.detail.errno, 'errMsg:', errMsg);
      // Typical for accounts bound to a non-mainland number: WeChat's quick phone
      // verification is built on the mainland carriers' SMS infrastructure and
      // regularly returns no code at all for foreign-registered accounts. This
      // used to dead-end silently; now it routes to manual entry.
      wx.showModal({
        title: 'Phone unavailable',
        content: 'WeChat could not share a phone number for this account. You can enter your number manually instead.',
        confirmText: 'Enter manually',
        cancelText: 'Cancel',
        success: ({ confirm }) => { if (confirm) this.showManualPhone(); }
      });
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
          // One phone = one account: the number already belongs to a different
          // WeChat account. Block the signup and send them back to sign-in —
          // their original account signs in automatically on this page.
          if (result.taken) {
            wx.showModal({
              title: 'Number already registered',
              content: 'This phone number already has an account. Please sign in with the WeChat account you registered with.',
              showCancel: false
            });
            return;
          }
          await this._afterPhoneResolved(cloud, result.phone);
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

  // Resolves the session's openid, waiting for app.js's login round-trip when
  // the user out-typed it (slow network: the form can be complete before
  // globalData.openid lands — writing with a null openid was the "Could not
  // complete registration" dead end).
  _ensureOpenid() {
    return new Promise((resolve) => {
      if (app.globalData.openid) return resolve(app.globalData.openid)
      app.getOpenid((openid) => resolve(openid))
    })
  },

  // Shared continuation once a phone number is in hand (WeChat-verified or
  // manually entered): a returning guest signs straight back in — clearing the
  // loggedOut flag and refreshing the cached profile — while a new one moves
  // on to the in-page profile step.
  async _afterPhoneResolved(cloud, phone) {
    const openid = await this._ensureOpenid()
    if (!openid) {
      wx.showToast({ title: 'Connection error, try again', icon: 'none' })
      return
    }
    try {
      const db = cloud.database();
      const guestRes = await db.collection('guests').where({ _openid: openid }).limit(1).get();
      if (guestRes.data && guestRes.data.length > 0) {
        auth.completeSignIn(guestRes.data[0]);
        this._afterSignIn(cloud, guestRes.data[0]);
        return;
      }
    } catch (e) {
      console.warn('[register] guest lookup failed:', e);
    }
    this.setData({ phone, step: 'profile' });
  },

  // ─── Manual phone entry (fallback for foreign numbers) ───
  //
  // WeChat's getPhoneNumber component is mainland-carrier based and often
  // fails for accounts registered to a foreign number, so those users need a
  // way in that doesn't depend on it. Same storage, same flow — the number is
  // just self-reported instead of WeChat-verified.
  showManualPhone() {
    this.setData({ signInMode: 'manual', manualPhoneError: '' });
  },

  hideManualPhone() {
    this.setData({ signInMode: 'wechat', manualPhoneError: '' });
  },

  onManualPhoneInput(e) {
    this.setData({ manualPhoneInput: e.detail.value, manualPhoneError: '' });
  },

  submitManualPhone() {
    if (!this.data.consentChecked) return;
    // Cleanup pasted punctuation, then a minimal international check: optional
    // leading +, 6–15 digits. Stored as typed (plus kept) — the admin app's
    // phone matcher strips formatting when comparing.
    const raw = (this.data.manualPhoneInput || '').replace(/[\s()\-.]/g, '');
    if (!/^\+?\d{6,15}$/.test(raw)) {
      this.setData({ manualPhoneError: 'Enter a valid phone with country code, e.g. +852 9123 4567' });
      return;
    }

    wx.showLoading({ title: 'Checking...', mask: true });
    app.getCloud(async (cloud) => {
      try {
        // One phone = one account: same rule as the WeChat-verified path.
        // Server-side check (checkPhone) so the client can't skip it.
        const res = await cloud.callFunction({
          name: 'clientAuth',
          data: { action: 'checkPhone', phone: raw }
        });
        const result = res.result || {};
        if (!result.success) throw new Error(result.message || 'Check failed');
        if (result.taken) {
          wx.hideLoading();
          wx.showModal({
            title: 'Number already registered',
            content: 'This phone number already has an account. Please sign in with the WeChat account you registered with.',
            showCancel: false,
            // Back to the sign-in screen — the number belongs to an existing account.
            success: () => this.hideManualPhone()
          });
          return;
        }
        await this._afterPhoneResolved(cloud, raw);
        wx.hideLoading();
      } catch (err) {
        console.error('[submitManualPhone] exception:', err);
        wx.hideLoading();
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
    // The name/promo were validated in onSubmit BEFORE the async promo
    // verification; re-reading this.data here re-opens the race where the
    // type="nickname" input fires a spurious EMPTY bindinput on blur (the
    // WeChat nickname-suggestion quirk) during that window — which wrote
    // guest docs with nickName:"" at the door. Snapshot at validation time.
    const nickName = (this._validatedName !== undefined ? this._validatedName : this.data.nickName || '').trim()
    const promoCode = (this._validatedPromo !== undefined ? this._validatedPromo : this.data.promoInput || '').trim()
    if (!nickName || !promoCode) {
      this.setData({ submitting: false })
      wx.showToast({ title: 'Enter your name', icon: 'none' })
      return
    }
    this.setData({ submitting: true });

    app.getCloud(async (cloud) => {
      try {
        // Block writing until the openid is certain — a null here meant a
        // failed add and the generic "Could not complete registration" modal.
        const openid = await this._ensureOpenid()
        if (!openid) throw new Error('no openid')

        const db = cloud.database();
        const profileData = {
          phone: this.data.phone,
          nickName,
          promoCode,
          promoterId: this.data.verifiedPromoterId,
          promoterName: this.data.verifiedPromoterName,
          updatedAt: db.serverDate()
        };

        // Both queries are explicitly filtered by this session's openid.
        const guestRes = await db.collection('guests').where({ _openid: openid }).limit(1).get();
        if (guestRes.data.length > 0) {
          await db.collection('guests').doc(guestRes.data[0]._id).update({ data: profileData });
        } else {
          // New profile: the doc _id IS the openid, so the check-then-add race
          // (double-tap / retry — two requests both seeing zero docs and both
          // adding) is killed by the database itself: the second add fails on
          // the duplicate _id and falls into the update below. Legacy profiles
          // keep their random _ids; the where(_openid) lookup covers both.
          try {
            await db.collection('guests').add({ data: { _id: openid, ...profileData, createdAt: db.serverDate() } });
          } catch (dup) {
            await db.collection('guests').doc(openid).update({ data: profileData });
          }
        }

        // Re-read the saved doc so the cached profile carries the server
        // fields (_id/_openid) that queries and fast paths depend on.
        const savedRes = await db.collection('guests').where({ _openid: openid }).limit(1).get();
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
  // the add if a registration already exists (explicitly filtered by this
  // session's openid so only this user's registration can match) — and
  // land on My List. Otherwise land on the feed.
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
      // Server-side registration (clientAuth.submitRegistration): limits,
      // the timed free→paid switch and duplicate protection all live on the
      // server now — the direct client write is retired.
      const res = await cloud.callFunction({
        name: 'clientAuth',
        data: { action: 'submitRegistration', eventId: pendingEventId }
      });
      const r = (res && res.result) || {};
      if (!r.success) throw new Error(r.message || 'failed');
      if (r.code === 'EVENT_OVER') {
        wx.showToast({ title: 'Event has ended', icon: 'none' });
        setTimeout(() => wx.reLaunch({ url: '/pages/feed/feed' }), 1500);
        return;
      } else if (r.code === 'FREE_CLOSED_BY_TIME' || r.code === 'FREE_SOLD_OUT') {
        wx.showToast({ title: 'Free entry is closed', icon: 'none' });
      } else {
        // Success — ALREADY_REGISTERED is the same happy outcome here.
        wx.vibrateShort();
        wx.showToast({ title: "You're in! 🎉", icon: 'success' });
      }
      setTimeout(() => {
        app.globalData.guestTopTab = 'wallet';
        wx.switchTab({ url: '/pages/mytickets/mytickets' });
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
    // Snapshot the validated values: the async promo check below leaves a
    // window where the nickname input's blur quirk can blank this.data
    // (see _doSubmit).
    this._validatedName = nickName.trim()
    this._validatedPromo = promoInput.trim()
    if (!this.data.promoValid) {
      this.verifyPromoCode();
      return;
    }
    this._doSubmit();
  }
});

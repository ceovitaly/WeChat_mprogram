// pages/register/promo/promo.js
const app = getApp();

Page({
  data: {
    phone: '',
    nickName: '',
    promoInput: '',
    promoValid: false,
    promoError: '',
    submitting: false,
    verifiedPromoterId: '',
    verifiedPromoterName: ''
  },

  onLoad(options) {
    if (options.phone) {
      this.setData({ phone: decodeURIComponent(options.phone) });
    } else {
      wx.showModal({
        title: 'Error',
        content: 'Phone number not found. Please start registration again.',
        showCancel: false,
        success: () => { wx.navigateBack(); }
      });
    }
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
        wx.reLaunch({ url: '/pages/feed/feed' });
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

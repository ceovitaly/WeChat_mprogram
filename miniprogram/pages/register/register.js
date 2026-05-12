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
    const app = getApp();
    app.getCloud(async (cloud) => {
      try {
        const res = await cloud.callFunction({
          name: 'clientAuth',
          data: { action: 'getMe' },
        });
        const { result } = res;
        if (result.success && result.user) {
          app.globalData.userInfo = result.user;
          wx.switchTab({ url: '/pages/feed/index' });
        } else {
          this.setData({ checking: false });
        }
      } catch (err) {
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

  // Privacy → Принять → показываем кнопку с getPhoneNumber
  onAgree() {
    this.setData({ showPrivacy: false, privacyAgreed: true });
  },

  // WeChat вернул code для получения телефона
  onGetPhoneNumber(e) {
    if (e.detail.errno !== undefined && e.detail.errno !== 0) {
      wx.showToast({ title: 'Номер телефона обязателен', icon: 'none' });
      this.setData({ privacyAgreed: false });
      return;
    }
    if (!e.detail.code) {
      wx.showToast({ title: 'Не удалось получить номер', icon: 'none' });
      this.setData({ privacyAgreed: false });
      return;
    }

    wx.showLoading({ title: 'Проверяем...', mask: true });

    const app = getApp();
    app.getCloud(async (cloud) => {
      try {
        const res = await cloud.callFunction({
          name: 'clientAuth',
          data: { action: 'getPhone', phoneCode: e.detail.code },
        });
        wx.hideLoading();
        const { result } = res;
        if (result.success && result.phone) {
          // Перенаправляем на страницу ввода промокода
          wx.navigateTo({
            url: `/pages/register/promo/promo?phone=${encodeURIComponent(result.phone)}`,
          });
        } else {
          wx.showToast({ title: 'Не удалось получить номер', icon: 'none' });
          this.setData({ privacyAgreed: false });
        }
      } catch (err) {
        wx.hideLoading();
        console.error('[getPhone]', err);
        wx.showToast({ title: 'Ошибка соединения', icon: 'none' });
        this.setData({ privacyAgreed: false });
      }
    });
  },
});
// pages/register/promo/promo.js
const app = getApp();

Page({
  data: {
    phone: '',
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
        title: 'Ошибка',
        content: 'Номер телефона не найден. Пожалуйста, начните регистрацию заново.',
        showCancel: false,
        success: () => {
          wx.navigateBack();
        }
      });
    }
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

    wx.showLoading({ title: 'Проверка...', mask: true });

    app.getCloud((cloud) => {
      cloud.callFunction({
        name: 'clientAuth',
        data: { 
          action: 'verifyPromoCode',
          promoCode: code
        }
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
        } else {
          this.setData({
            promoValid: false,
            promoError: result.message || 'Неверный промокод'
          });
        }
      })
      .catch(err => {
        wx.hideLoading();
        console.error('[verifyPromoCode] error:', err);
        this.setData({
          promoValid: false,
          promoError: 'Ошибка соединения'
        });
      });
    });
  },

  onSubmit() {
    if (!this.data.promoValid) {
      this.verifyPromoCode();
      return;
    }

    this.setData({ submitting: true });

    // Сохраняем телефон и промокод в профиль пользователя
    app.getCloud((cloud) => {
      const db = cloud.database();
      
      // Находим профиль пользователя по openid
      db.collection('guests').where({
        _openid: app.globalData.openid
      }).get()
      .then(guestRes => {
        if (guestRes.data.length === 0) {
          wx.hideLoading();
          this.setData({ submitting: false });
          wx.showModal({
            title: 'Ошибка',
            content: 'Профиль пользователя не найден',
            showCancel: false
          });
          return;
        }

        const guest = guestRes.data[0];
        
        // Обновляем профиль с телефоном
        return db.collection('guests').doc(guest._id).update({
          data: {
            phone: this.data.phone,
            promoCode: this.data.promoInput,
            promoterId: this.data.verifiedPromoterId,
            promoterName: this.data.verifiedPromoterName,
            updatedAt: db.serverDate()
          }
        });
      })
      .then(() => {
        // После сохранения телефона и промокода перенаправляем на ленту
        wx.switchTab({ url: '/pages/feed/feed' });
      })
      .catch(err => {
        console.error('[onSubmit] error:', err);
        this.setData({ submitting: false });
        wx.showModal({
          title: 'Ошибка',
          content: 'Не удалось завершить регистрацию',
          showCancel: false
        });
      });
    });
  }
});

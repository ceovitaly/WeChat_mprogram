const app = getApp();

Page({
  data: {
    userInfo: null,
    hasUserInfo: false,
    showModal: false,
    tempAvatarUrl: ''
  },

  onLoad: function() {
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this.checkUserInDB();
    });
  },

  onShow: function() {
    if (this.data.hasUserInfo) {
      this.checkUserInDB();
    }
  },

  checkUserInDB: function() {
    const openid = app.globalData.openid;
    if (!openid) {
      setTimeout(() => this.checkUserInDB(), 500);
      return;
    }
    const db = this.cloud.database();
    db.collection('guests').where({ _openid: openid }).get({
      success: res => {
        if (res.data.length > 0) {
          this.setData({ userInfo: res.data[0], hasUserInfo: true });
        } else {
          this.setData({ showModal: true });
        }
      },
      fail: err => console.error("Check user error:", err)
    });
  },

  onChooseAvatar: function(e) {
    this.setData({ tempAvatarUrl: e.detail.avatarUrl });
  },

  saveProfile: function(e) {
    const nickName = e.detail.value.nickName;
    if (!nickName || !nickName.trim()) {
      wx.showToast({ title: 'Enter name', icon: 'none' });
      return;
    }
    wx.showLoading({ title: 'Saving...' });
    const avatarToUpload = this.data.tempAvatarUrl;
    if (avatarToUpload && !avatarToUpload.startsWith('http')) {
      this.cloud.uploadFile({
        cloudPath: `avatars/${Date.now()}.png`,
        filePath: avatarToUpload,
        success: res => { this.saveToDatabase(nickName.trim(), res.fileID); },
        fail: () => {
          wx.hideLoading();
          wx.showToast({ title: 'Upload failed', icon: 'none' });
        }
      });
    } else {
      this.saveToDatabase(nickName.trim(), avatarToUpload || '');
    }
  },

  saveToDatabase: function(nickName, avatarUrl) {
    const db = this.cloud.database();
    const openid = app.globalData.openid;
    db.collection('guests').where({ _openid: openid }).get({
      success: res => {
        if (res.data.length > 0) {
          db.collection('guests').doc(res.data[0]._id).update({
            data: { nickName, avatarUrl },
            success: () => {
              wx.hideLoading();
              this.setData({ showModal: false });
              this.checkUserInDB();
            },
            fail: err => {
              wx.hideLoading();
              console.error("Update failed:", err);
            }
          });
        } else {
          db.collection('guests').add({
            data: { nickName, avatarUrl, createdAt: db.serverDate() },
            success: () => {
              wx.hideLoading();
              this.setData({ showModal: false });
              this.checkUserInDB();
            },
            fail: err => {
              wx.hideLoading();
              console.error("Add failed:", err);
            }
          });
        }
      },
      fail: err => {
        wx.hideLoading();
        console.error("saveToDatabase check failed:", err);
      }
    });
  },

  scanQR: function() {
    wx.scanCode({
      onlyFromCamera: true,
      success: (res) => {
        const data = res.result;
        if (data.startsWith('promoter_invite:')) {
          const token = data.replace('promoter_invite:', '');
          this.applyPromoterRole(token);
        } else {
          wx.showToast({ title: 'Invalid QR', icon: 'none' });
        }
      },
      fail: () => {}
    });
  },

  applyPromoterRole: function(token) {
    wx.showLoading({ title: 'Applying...', mask: true });
    const openid = app.globalData.openid;
    this.cloud.callFunction({
      name: 'assignPromoter',
      data: { token, openid }
    }).then(res => {
      wx.hideLoading();
      if (res.result && res.result.success) {
        wx.vibrateShort();
        wx.showToast({ title: 'You are now a Promoter!', icon: 'success' });
        this.checkUserInDB();
      } else {
        wx.showToast({ title: res.result.message || 'Error', icon: 'none' });
      }
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: 'Error', icon: 'none' });
    });
  },

  goToTickets: function() {
    wx.switchTab({ url: '/pages/mytickets/mytickets' });
  },

  logout: function() {
    wx.showModal({
      title: 'Log Out',
      content: 'Confirm logout?',
      confirmColor: '#ff3b30',
      success: (res) => {
        if (res.confirm) {
          this.setData({
            userInfo: null,
            hasUserInfo: false,
            showModal: true,
            tempAvatarUrl: ''
          });
        }
      }
    });
  }
});
const app = getApp();

Page({
  data: {
    userInfo: null,
    loading: true,
    avatarLetter: '?',
    showNameEdit: false,
    editingName: ''
  },

  onLoad: function() {
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this._loadProfile();
    });
  },

  onShow: function() {
    if (this.cloud) this._loadProfile();
  },

  _loadProfile: function() {
    const openid = app.globalData.openid;
    if (!openid) {
      setTimeout(() => this._loadProfile(), 300);
      return;
    }
    const db = this.cloud.database();
    db.collection('guests').where({ _openid: openid }).get({
      success: res => {
        if (res.data.length > 0) {
          const u = res.data[0];
          const avatarLetter = (u.nickName || u.name || '?').charAt(0).toUpperCase();
          this.setData({ userInfo: u, avatarLetter, loading: false });
        } else {
          wx.reLaunch({ url: '/pages/register/register' });
        }
      },
      fail: () => {
        this.setData({ loading: false });
      }
    });
  },

  noop() {},

  openNameEdit() {
    const name = this.data.userInfo.nickName || this.data.userInfo.name || '';
    this.setData({ showNameEdit: true, editingName: name });
  },

  closeNameEdit() {
    this.setData({ showNameEdit: false, editingName: '' });
  },

  onNameInput(e) {
    this.setData({ editingName: e.detail.value });
  },

  saveNameEdit() {
    const name = this.data.editingName.trim();
    if (!name) {
      wx.showToast({ title: 'Enter a name', icon: 'none' });
      return;
    }
    wx.showLoading({ title: 'Saving...', mask: true });
    const db = this.cloud.database();
    db.collection('guests').doc(this.data.userInfo._id).update({
      data: { nickName: name, updatedAt: db.serverDate() }
    })
    .then(() => {
      wx.hideLoading();
      const userInfo = Object.assign({}, this.data.userInfo, { nickName: name });
      const avatarLetter = name.charAt(0).toUpperCase();
      this.setData({ showNameEdit: false, editingName: '', userInfo, avatarLetter });
      wx.vibrateShort({ type: 'medium' });
      wx.showToast({ title: 'Saved!', icon: 'success' });
    })
    .catch(() => {
      wx.hideLoading();
      wx.showToast({ title: 'Error saving', icon: 'none' });
    });
  },

  logout: function() {
    wx.showModal({
      title: 'Log Out',
      content: 'Confirm logout?',
      confirmColor: '#FF3B30',
      success: (res) => {
        if (res.confirm) {
          try { wx.removeStorageSync('userInfo'); } catch(e) {}
          const app = getApp();
          app.globalData.userInfo = null;
          wx.reLaunch({ url: '/pages/register/register' });
        }
      }
    });
  },

  goBack() {
    wx.navigateBack();
  }
});

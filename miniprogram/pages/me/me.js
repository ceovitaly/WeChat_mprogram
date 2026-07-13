const app = getApp();
const auth = require('../../utils/auth.js');

Page({
  data: {
    userInfo: null,
    loading: true,
    isAnonymous: false,
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
    // Central auth state instead of polling for openid: anonymous users
    // get an in-page signed-out state (no forced redirect to register).
    auth.getAuth((profile) => {
      if (!profile) {
        this.setData({ isAnonymous: true, userInfo: null, loading: false });
        return;
      }
      const avatarLetter = (profile.nickName || profile.name || '?').charAt(0).toUpperCase();
      this.setData({ isAnonymous: false, userInfo: profile, avatarLetter, loading: false });
    });
  },

  goSignIn: function() {
    wx.navigateTo({ url: '/pages/register/register' });
  },

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
      // Refresh the central auth cache so the feed header/badges pick up
      // the new name without an app restart.
      auth.completeSignIn(userInfo);
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
          auth.logout();
          // Land on the feed (the app's anonymous-friendly home) rather
          // than register, which would immediately re-prompt for sign-in.
          wx.reLaunch({ url: '/pages/feed/feed' });
        }
      }
    });
  },

  goBack() {
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages/feed/feed' }),
    });
  }
});

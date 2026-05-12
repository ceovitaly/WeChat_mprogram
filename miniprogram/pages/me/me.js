const app = getApp();

Page({
  data: {
    userInfo: null,
    hasUserInfo: false,
    showAuthButton: false,
    tempAvatarUrl: '',
    tempNickName: ''
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
  
  goBack: function() {
    wx.navigateBack({ delta: 1 });
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
          this.setData({ userInfo: res.data[0], hasUserInfo: true, showAuthButton: false });
        } else {
          this.setData({ showAuthButton: true });
        }
      },
      fail: err => console.error("Check user error:", err)
    });
  },

  onLogin: function() {
    wx.getUserProfile({
      desc: 'Complete your profile',
      success: (res) => {
        const userProfile = res.userInfo;
        this.setData({ 
          tempAvatarUrl: userProfile.avatarUrl,
          tempNickName: userProfile.nickName
        });
        this.saveToDatabase(userProfile.nickName, userProfile.avatarUrl);
      },
      fail: (err) => {
        console.error("Get user profile failed:", err);
        wx.showToast({ title: 'Authorization required', icon: 'none' });
      }
    });
  },

  saveToDatabase: function(nickName, avatarUrl) {
    wx.showLoading({ title: 'Saving...' });
    const db = this.cloud.database();
    const openid = app.globalData.openid;
    db.collection('guests').where({ _openid: openid }).get({
      success: res => {
        if (res.data.length > 0) {
          db.collection('guests').doc(res.data[0]._id).update({
            data: { nickName, avatarUrl },
            success: () => {
              wx.hideLoading();
              this.setData({ showAuthButton: false });
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
              this.setData({ showAuthButton: false });
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

  goToTickets: function() {
    wx.navigateTo({ url: '/pages/mytickets/mytickets' });
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
            showAuthButton: true,
            tempAvatarUrl: '',
            tempNickName: ''
          });
        }
      }
    });
  }
});

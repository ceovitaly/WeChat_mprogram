// Main — the admin hub: a menu into the sections that are no longer tabs
// (Team, Past Events, Stats, Reports). Sections that don't exist yet open
// stub pages; content arrives later.
Page({
  data: {
    userName: ''
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().updateTabs()
      this.getTabBar().setData({ selected: 2 })
    }
    const userInfo = getApp().globalData.userInfo
    this.setData({ userName: userInfo ? (userInfo.name || 'Admin') : 'Admin' })
  },

  goTo(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url })
  },

  confirmLogout() {
    wx.showModal({
      title: 'Log out',
      content: 'Are you sure you want to log out?',
      confirmText: 'Log out',
      confirmColor: '#FF3B30',
      cancelText: 'Cancel',
      success: ({ confirm }) => {
        if (confirm) getApp().logout()
      }
    })
  }
})

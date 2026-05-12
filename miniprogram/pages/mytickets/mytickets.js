const app = getApp();

Page({
  data: {
    tickets: [],
    isLoading: false
  },
  
  onLoad() {
    this.updateTabBar(1);
  },

  onShow() {
    this.updateTabBar(1);
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this.fetchTickets();
    });
  },

  updateTabBar(index) {
    const tabBar = this.getTabBar();
    if (tabBar && typeof tabBar.updateActive === 'function') {
      tabBar.updateActive(index);
    } else if (tabBar && tabBar.data.selected !== index) {
      tabBar.setData({ selected: index });
    }
  },

  fetchTickets: async function() {
    const openid = app.globalData.openid;
    if (!openid) return;
    if (!this.cloud) return;

    this.setData({ isLoading: true });
    try {
      const db = this.cloud.database();
      const res = await db.collection('registrations')
        .where({ _openid: openid })
        .orderBy('createdAt', 'desc')
        .get();
      this.setData({
        tickets: res.data || [],
        isLoading: false
      });
    } catch (err) {
      this.setData({ isLoading: false });
      console.error('Fetch tickets error:', err);
    }
  },

  onPullDownRefresh: async function() {
    await this.fetchTickets();
    wx.stopPullDownRefresh();
  }
});

const app = getApp();

Page({
  data: {
    tickets: [],
    isLoading: false
  },
  
  onLoad() {
    // Обновляем активную вкладку таб-бара
    this.updateTabBar(1);
  },

  onShow() {
    // Обновляем активную вкладку при возврате на страницу
    this.updateTabBar(1);
    
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this.fetchTickets();
    });
  },

  updateTabBar: function(index) {
    const tabBar = this.getTabBar();
    if (tabBar && tabBar.updateActive) {
      tabBar.updateActive(index);
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

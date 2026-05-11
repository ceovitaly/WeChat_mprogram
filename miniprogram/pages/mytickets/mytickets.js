const app = getApp();

Page({
  data: {
    tickets: [],
    isLoading: false
  },

  onShow() {
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this.fetchTickets();
    });
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
const app = getApp();

Page({
  data: {
    tickets: [],
    isLoading: false
  },
  
  onLoad() {
  },

  onShow() {
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this.fetchTickets();
    });
  },

  goBack: function() {
    wx.navigateBack({ delta: 1 });
  },

  goToPastEvents: function() {
    wx.navigateTo({ url: '/pages/pastevents/pastevents' });
  },

  fetchTickets: async function() {
    const openid = app.globalData.openid;
    if (!openid) return;
    if (!this.cloud) return;

    this.setData({ isLoading: true });
    try {
      const db = this.cloud.database();
      const now = new Date().getTime();
      
      const res = await db.collection('registrations')
        .where({ _openid: openid })
        .orderBy('createdAt', 'desc')
        .get();
      
      // Фильтруем только будущие и текущие события
      const upcomingTickets = (res.data || []).filter(ticket => {
        const eventDate = new Date(ticket.eventDate).getTime();
        return eventDate >= now;
      });
      
      this.setData({
        tickets: upcomingTickets,
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

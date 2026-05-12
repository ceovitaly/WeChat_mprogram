const app = getApp();

Page({
  data: {
    pastTickets: [],
    isLoading: false
  },
  
  onLoad() {
    // Обновляем активную вкладку таб-бара (индекс 1 - Tickets, но это отдельная страница)
    // Для_past events_ нет вкладки в таб-баре, поэтому не обновляем
  },

  onShow() {
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this.fetchPastTickets();
    });
  },

  fetchPastTickets: async function() {
    const openid = app.globalData.openid;
    if (!openid) return;
    if (!this.cloud) return;

    this.setData({ isLoading: true });
    try {
      const db = this.cloud.database();
      const now = new Date().getTime();
      
      // Получаем все регистрации пользователя
      const res = await db.collection('registrations')
        .where({ _openid: openid })
        .orderBy('createdAt', 'desc')
        .get();
      
      // Фильтруем прошедшие события
      const pastTickets = (res.data || []).filter(ticket => {
        const eventDate = new Date(ticket.eventDate).getTime();
        return eventDate < now;
      });
      
      this.setData({
        pastTickets: pastTickets,
        isLoading: false
      });
    } catch (err) {
      this.setData({ isLoading: false });
      console.error('Fetch past tickets error:', err);
    }
  },

  onPullDownRefresh: async function() {
    await this.fetchPastTickets();
    wx.stopPullDownRefresh();
  }
});

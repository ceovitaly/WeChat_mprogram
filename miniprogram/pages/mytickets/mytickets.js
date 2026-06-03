const app = getApp();

Page({
  data: {
    activeTickets: [],
    pastTickets: [],
    activeTab: 'active',
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
    if (!openid || !this.cloud) return;

    this.setData({ isLoading: true });
    try {
      const db = this.cloud.database();
      const res = await db.collection('registrations')
        .where({ _openid: openid })
        .orderBy('createdAt', 'desc')
        .get();

      const today = new Date().toISOString().split('T')[0];
      const active = [];
      const past = [];

      (res.data || []).forEach(ticket => {
        if (ticket.eventDate && ticket.eventDate < today) {
          past.push(ticket);
        } else {
          active.push(ticket);
        }
      });

      this.setData({
        activeTickets: active,
        pastTickets: past,
        isLoading: false
      });
    } catch (err) {
      this.setData({ isLoading: false });
      console.error('Fetch tickets error:', err);
    }
  },

  switchTab: function(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab });
  },

  goBack: function() {
    wx.navigateBack();
  },

  goToEvent: function(e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/event-detail/event-detail?id=' + id });
  },

  removeFromList: function(e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: 'Leave event?',
      content: 'Remove yourself from this event list?',
      confirmText: 'Leave',
      confirmColor: '#FF3B30',
      success: (res) => {
        if (!res.confirm) return;
        const db = this.cloud.database();
        db.collection('registrations').doc(id).remove({
          success: () => {
            wx.showToast({ title: 'Removed', icon: 'success' });
            this.fetchTickets();
          },
          fail: (err) => {
            console.error('Remove registration error:', err);
            wx.showToast({ title: 'Failed to remove', icon: 'none' });
          }
        });
      }
    });
  },

  onPullDownRefresh: async function() {
    await this.fetchTickets();
    wx.stopPullDownRefresh();
  }
});
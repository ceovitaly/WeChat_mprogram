const app = getApp();
const auth = require('../../utils/auth.js');

Page({
  data: {
    activeTickets: [],
    pastTickets: [],
    activeTab: 'active',
    isLoading: false,
    isAnonymous: false
  },

  onShow() {
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this.fetchTickets();
    });
  },

  fetchTickets: function() {
    this.setData({ isLoading: true });
    auth.getAuth((profile) => {
      if (!profile) {
        // Anonymous (logged out or no guest record): no tickets, show the
        // sign-in CTA instead of a false "No active tickets" empty state.
        this.setData({
          isAnonymous: true,
          activeTickets: [],
          pastTickets: [],
          isLoading: false
        });
        return;
      }
      if (!this.cloud) return;

      const db = this.cloud.database();
      db.collection('registrations')
        .where({ _openid: profile._openid })
        .orderBy('createdAt', 'desc')
        .get()
        .then(res => {
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
            isAnonymous: false,
            activeTickets: active,
            pastTickets: past,
            isLoading: false
          });
        })
        .catch(err => {
          this.setData({ isLoading: false });
          console.error('Fetch tickets error:', err);
        });
    });
  },

  goSignIn: function() {
    wx.navigateTo({ url: '/pages/register/register' });
  },

  switchTab: function(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab });
  },

  goBack: function() {
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages/feed/feed' }),
    });
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

  onPullDownRefresh: function() {
    this.fetchTickets();
    wx.stopPullDownRefresh();
  }
});
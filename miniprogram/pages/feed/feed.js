const app = getApp();

Page({
  data: {
    events: [],
    loading: true
  },

  onLoad: function() {
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this.fetchEvents();
    });
  },

  onPullDownRefresh: function() {
    this.fetchEvents();
  },

  fetchEvents: function() {
    if (!this.cloud) return;
    this.setData({ loading: true });
    const db = this.cloud.database();
    const _ = db.command;
    const today = new Date().toISOString().split('T')[0];
    db.collection('events')
      .where({ date: _.gte(today) })
      .orderBy('date', 'asc')
      .get({
        success: async res => {
          const events = res.data;
          // Собираем все cloud:// URL для конвертации
          const cloudUrls = events
            .map(e => e.promoImage)
            .filter(url => url && url.startsWith('cloud://'));

          if (cloudUrls.length > 0) {
            try {
              const tempRes = await this.cloud.getTempFileURL({ fileList: cloudUrls });
              const urlMap = {};
              tempRes.fileList.forEach(f => {
                urlMap[f.fileID] = f.tempFileURL;
              });
              events.forEach(e => {
                if (e.promoImage && urlMap[e.promoImage]) {
                  e.promoImage = urlMap[e.promoImage];
                }
              });
            } catch (err) {
              console.error('getTempFileURL error:', err);
            }
          }

          this.setData({ events, loading: false });
          wx.stopPullDownRefresh();
        },
        fail: err => {
          console.error("Load events error:", err);
          this.setData({ loading: false });
          wx.showToast({ title: 'Error loading data', icon: 'none' });
        }
      });
  },

  goToDetail: function(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/event-detail/event-detail?id=${id}` });
  }
});
const app = getApp();

Page({
  data: {
    events: [],
    loading: true,
    lastUpdateTime: null
  },
  
  onLoad: function() {
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this.loadEventsFromCacheOrFetch();
    });
    this.updateTabBar(0);
  },

  onShow: function() {
    this.updateTabBar(0);
    // Проверяем наличие новых данных при возврате на страницу
    if (!this.data.loading && this.data.lastUpdateTime) {
      const now = Date.now();
      // Если прошло больше 5 минут, обновляем данные
      if (now - this.data.lastUpdateTime > 5 * 60 * 1000) {
        this.fetchEvents();
      }
    }
  },

  updateTabBar(index) {
    const tabBar = this.getTabBar();
    if (tabBar && typeof tabBar.updateActive === 'function') {
      tabBar.updateActive(index);
    } else if (tabBar && tabBar.data.selected !== index) {
      tabBar.setData({ selected: index });
    }
  },
  
  onPullDownRefresh: function() {
    this.fetchEvents(true);
  },

  loadEventsFromCacheOrFetch: function() {
    // Пробуем загрузить из кэша
    try {
      const cached = wx.getStorageSync('events_cache');
      const cacheTime = wx.getStorageSync('events_cache_time');
      
      if (cached && cacheTime) {
        const now = Date.now();
        // Кэш действителен 10 минут
        if (now - cacheTime < 10 * 60 * 1000) {
          this.setData({ 
            events: JSON.parse(cached), 
            loading: false,
            lastUpdateTime: cacheTime
          });
          // Всё равно делаем фоновое обновление
          this.fetchEvents();
          return;
        }
      }
    } catch (e) {
      console.warn('Cache read error:', e);
    }
    
    // Если кэша нет или он устарел - загружаем из облака
    this.fetchEvents();
  },

  fetchEvents: function(force = false) {
    if (!this.cloud) return;
    
    if (!force && !this.data.loading) return; // Не загружаем если уже есть данные
    
    this.setData({ loading: true });
    const db = this.cloud.database();
    const _ = db.command;
    const today = new Date().toISOString().split('T')[0];
    
    db.collection('events')
      .where({ date: _.gte(today) })
      .orderBy('date', 'asc')
      .limit(50)
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

          this.setData({ 
            events, 
            loading: false,
            lastUpdateTime: Date.now()
          });
          
          // Сохраняем в кэш
          try {
            wx.setStorageSync('events_cache', JSON.stringify(events));
            wx.setStorageSync('events_cache_time', Date.now());
          } catch (e) {
            console.warn('Cache write error:', e);
          }
          
          wx.stopPullDownRefresh();
        },
        fail: err => {
          console.error("Load events error:", err);
          this.setData({ loading: false });
          
          // Пробуем показать кэш даже если он старый
          try {
            const cached = wx.getStorageSync('events_cache');
            if (cached) {
              this.setData({ events: JSON.parse(cached), loading: false });
            }
          } catch (e) {}
          
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

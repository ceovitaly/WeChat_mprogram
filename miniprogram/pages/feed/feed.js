const app = getApp();

Page({
  data: {
    events: [],
    loading: true,
    lastUpdateTime: null,
    hasLoadedOnce: false // Флаг: данные уже загружены хотя бы раз
  },
  
  onLoad: function() {
    // Обновляем активную вкладку таб-бара
    this.updateTabBar(0);
    
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this.loadEventsFromCacheOrFetch();
    });
  },

  onShow: function() {
    // Обновляем активную вкладку при возврате на страницу
    this.updateTabBar(0);
    
    // УБРАЛИ автоматическую проверку и загрузку данных при каждом возврате!
    // Это устраняет моргание и дергание интерфейса.
    // Обновление теперь происходит ТОЛЬКО при свайпе вниз (onPullDownRefresh)
    // или если данные вообще никогда не загружались (hasLoadedOnce === false)
    
    if (!this.data.hasLoadedOnce && !this.data.loading) {
      // Если вдруг данные так и не загрузились в onLoad (редкий кейс), пробуем снова
      this.fetchEvents(true);
    }
  },
  
  updateTabBar: function(index) {
    const tabBar = this.getTabBar();
    if (tabBar && tabBar.updateActive) {
      tabBar.updateActive(index);
    }
  },
  
  onPullDownRefresh: function() {
    // Ручное обновление по свайпу вниз - единственный способ обновить данные
    this.fetchEvents(true);
  },

  loadEventsFromCacheOrFetch: function() {
    // Пробуем загрузить из кэша для мгновенного отображения
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
            lastUpdateTime: cacheTime,
            hasLoadedOnce: true
          });
          // Тихое фоновое обновление (не блокирует UI)
          this.fetchEvents(false);
          return;
        }
      }
    } catch (e) {
      console.warn('Cache read error:', e);
    }
    
    // Если кэша нет или он устарел - загружаем из облака
    this.fetchEvents(true);
  },

  fetchEvents: function(showLoadingIndicator = true) {
    if (!this.cloud) return;
    
    // Если показываем индикатор загрузки и данные уже есть - пропускаем, чтобы не моргало
    if (showLoadingIndicator && this.data.events.length > 0 && !this.data.loading) {
       // Это фоновое обновление, просто делаем запрос без изменения UI
       this._doFetchEvents(false);
       return;
    }
    
    if (showLoadingIndicator) {
      this.setData({ loading: true });
    }
    
    this._doFetchEvents(showLoadingIndicator);
  },
  
  _doFetchEvents: function(showLoadingIndicator) {
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

          const updateData = { 
            events, 
            lastUpdateTime: Date.now(),
            hasLoadedOnce: true
          };
          
          if (showLoadingIndicator) {
            updateData.loading = false;
          }
          
          this.setData(updateData);
          
          // Сохраняем в кэш
          try {
            wx.setStorageSync('events_cache', JSON.stringify(events));
            wx.setStorageSync('events_cache_time', Date.now());
          } catch (e) {
            console.warn('Cache write error:', e);
          }
          
          if (showLoadingIndicator) {
            wx.stopPullDownRefresh();
          }
        },
        fail: err => {
          console.error("Load events error:", err);
          
          if (showLoadingIndicator) {
            this.setData({ loading: false });
            wx.stopPullDownRefresh();
            
            // Пробуем показать кэш даже если он старый
            try {
              const cached = wx.getStorageSync('events_cache');
              if (cached) {
                this.setData({ events: JSON.parse(cached) });
              }
            } catch (e) {}
            
            wx.showToast({ title: 'Error loading data', icon: 'none' });
          }
        }
      });
  },

  goToDetail: function(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/event-detail/event-detail?id=${id}` });
  }
});

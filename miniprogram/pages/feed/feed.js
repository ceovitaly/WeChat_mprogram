const app = getApp();

Page({
  data: {
    events: [],
    featuredEvents: [],
    filteredEvents: [],
    dateList: [],
    currentDate: '',
    loading: true,
    userInfo: null,
    lastUpdateTime: null,
    hasLoadedOnce: false,
    statusBarHeight: 0,
    showCalendar: false,
    currentMonth: new Date().getMonth(),
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  },
  
  onLoad: function() {
    // Получаем высоту статусной строки для кастомного хедера
    const systemInfo = wx.getSystemInfoSync();
    this.setData({ 
      statusBarHeight: systemInfo.statusBarHeight || 20
    });
    
    // Загружаем информацию о пользователе
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo) {
      this.setData({ userInfo });
    }
    
    // Генерируем список дат на 7 дней вперед
    this.generateDateList();
    
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this.loadEventsFromCacheOrFetch();
    });
  },

  onShow: function() {
    // Обновляем информацию о пользователе при возврате на страницу
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo) {
      this.setData({ userInfo });
    }
    
    if (!this.data.hasLoadedOnce && !this.data.loading) {
      this.fetchEvents(true);
    }
  },
  
  onPullDownRefresh: function() {
    this.fetchEvents(true);
  },

  generateDateList: function() {
    const today = new Date();
    const dateList = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      
      const dateStr = date.toISOString().split('T')[0];
      const dayName = dayNames[date.getDay()];
      const dayNum = date.getDate();
      
      dateList.push({
        dateStr,
        dayName,
        dayNum,
        fullDate: date
      });
    }
    
    // Устанавливаем текущую дату как сегодня
    const currentDate = dateList[0].dateStr;
    
    this.setData({ dateList, currentDate });
    this.filterEventsByDate(currentDate);
  },

  selectDate: function(e) {
    const { date, fullDate } = e.currentTarget.dataset;
    this.setData({ currentDate: date });
    this.filterEventsByDate(date);
  },

  filterEventsByDate: function(dateStr) {
    const allEvents = this.data.events;
    
    if (!dateStr) {
      // Если дата не выбрана, показываем все события
      this.setData({ 
        filteredEvents: allEvents,
        featuredEvents: allEvents.slice(0, 5) // Первые 5 как избранные
      });
      return;
    }
    
    // Фильтруем события по выбранной дате
    const filtered = allEvents.filter(event => {
      return event.date === dateStr;
    });
    
    // Сортируем по времени
    filtered.sort((a, b) => {
      const timeA = a.time || '00:00';
      const timeB = b.time || '00:00';
      return timeA.localeCompare(timeB);
    });
    
    this.setData({ 
      filteredEvents: filtered,
      featuredEvents: filtered.slice(0, 5) // Первые 5 как избранные для этой даты
    });
  },

  loadEventsFromCacheOrFetch: function() {
    try {
      const cached = wx.getStorageSync('events_cache');
      const cacheTime = wx.getStorageSync('events_cache_time');
      
      if (cached && cacheTime) {
        const now = Date.now();
        if (now - cacheTime < 10 * 60 * 1000) {
          const events = JSON.parse(cached);
          this.setData({ 
            events,
            loading: false,
            lastUpdateTime: cacheTime,
            hasLoadedOnce: true
          });
          this.filterEventsByDate(this.data.currentDate);
          this.fetchEvents(false);
          return;
        }
      }
    } catch (e) {
      console.warn('Cache read error:', e);
    }
    
    this.fetchEvents(true);
  },

  fetchEvents: function(showLoadingIndicator = true) {
    if (!this.cloud) return;
    
    if (showLoadingIndicator && this.data.events.length > 0 && !this.data.loading) {
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
          
          // Применяем фильтрацию по текущей дате
          this.filterEventsByDate(this.data.currentDate);
          
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
            
            try {
              const cached = wx.getStorageSync('events_cache');
              if (cached) {
                const events = JSON.parse(cached);
                this.setData({ events });
                this.filterEventsByDate(this.data.currentDate);
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
  },

  goToTickets: function() {
    wx.navigateTo({ url: '/pages/mytickets/mytickets' });
  },

  goToProfile: function() {
    wx.navigateTo({ url: '/pages/me/me' });
  },
  
  goToPastEvents: function() {
    wx.navigateTo({ url: '/pages/pastevents/pastevents' });
  },
  
  // Calendar functions
  openCalendar: function() {
    this.setData({ showCalendar: true });
  },
  
  closeCalendar: function() {
    this.setData({ showCalendar: false });
  },
  
  selectMonth: function(e) {
    const month = e.currentTarget.dataset.month;
    this.setData({ currentMonth: month, showCalendar: false });
    
    // Фильтрация событий по выбранному месяцу
    this.filterEventsByMonth(month);
    
    wx.showToast({
      title: `Selected: ${this.data.months[month]}`,
      icon: 'success',
      duration: 1500
    });
  },
  
  filterEventsByMonth: function(month) {
    const allEvents = this.data.events;
    const today = new Date();
    const year = today.getFullYear();
    
    // Фильтруем события по выбранному месяцу
    const filtered = allEvents.filter(event => {
      const eventDate = new Date(event.date);
      return eventDate.getMonth() === month && eventDate.getFullYear() >= year;
    });
    
    // Сортируем по дате
    filtered.sort((a, b) => {
      return new Date(a.date) - new Date(b.date);
    });
    
    this.setData({ 
      filteredEvents: filtered,
      featuredEvents: filtered.slice(0, 5)
    });
  },
  
  noop: function() {}
});

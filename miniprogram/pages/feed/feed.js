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
    // Filter states
    selectedDate: '',
    selectedLocation: '',
    selectedPrice: '',
    uniqueLocations: [],
    filterOpen: ''
  },

  onLoad: function() {
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
  },

  // Compact filter toggle functions
  toggleFilter: function(e) {
    const type = e.currentTarget.dataset.type;
    const currentOpen = this.data.filterOpen;
    
    // Close if same filter is tapped again, otherwise open the new one
    this.setData({
      filterOpen: currentOpen === type ? '' : type
    });
  },

  selectFilter: function(e) {
    const type = e.currentTarget.dataset.type;
    const value = e.currentTarget.dataset.value || '';
    
    const updateData = {};
    if (type === 'date') {
      updateData.selectedDate = value;
    } else if (type === 'location') {
      updateData.selectedLocation = value;
    } else if (type === 'price') {
      updateData.selectedPrice = value;
    }
    
    updateData.filterOpen = '';
    this.setData(updateData);
    this.applyFilters();
  },

  clearFilters: function() {
    this.setData({
      selectedDate: '',
      selectedLocation: '',
      selectedPrice: '',
      filterOpen: ''
    });
    this.applyFilters();
  },

  applyFilters: function() {
    let filtered = [...this.data.events];

    // Filter by date
    if (this.data.selectedDate) {
      filtered = filtered.filter(event => event.date === this.data.selectedDate);
    }

    // Filter by location
    if (this.data.selectedLocation) {
      filtered = filtered.filter(event =>
        event.venue && event.venue.includes(this.data.selectedLocation)
      );
    }

    // Filter by price
    if (this.data.selectedPrice) {
      filtered = filtered.filter(event => {
        const price = parseFloat(event.price) || 0;
        switch (this.data.selectedPrice) {
          case 'free':
            return price === 0;
          case 'low':
            return price > 0 && price < 20;
          case 'medium':
            return price >= 20 && price <= 50;
          case 'high':
            return price > 50;
          default:
            return true;
        }
      });
    }

    // Sort by date and time
    filtered.sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return (a.time || '00:00').localeCompare(b.time || '00:00');
    });

    this.setData({
      filteredEvents: filtered,
      featuredEvents: filtered.slice(0, 5)
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

          // Extract unique locations for filter
          const uniqueLocations = [...new Set(events.map(e => e.venue).filter(v => v))];
          this.setData({ uniqueLocations });

          // Apply filters on initial load
          this.applyFilters();

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

                // Extract unique locations for filter
                const uniqueLocations = [...new Set(events.map(e => e.venue).filter(v => v))];
                this.setData({ uniqueLocations });

                this.applyFilters();
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
  }
});

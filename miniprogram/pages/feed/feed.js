const app = getApp();

Page({
  data: {
    events: [],
    filteredEvents: [],
    dateList: [],
    currentDate: '',
    loading: true,
    userInfo: null,
    lastUpdateTime: null,
    hasLoadedOnce: false,
    selectedDate: '',
    searchKeyword: '',
    showCalendar: false,
    currentMonth: '',
    calendarDays: []
  },

  onLoad: function() {
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo) {
      this.setData({ userInfo });
    }
    this.generateDateList();
    this.initCalendar();
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this.loadEventsFromCacheOrFetch();
    });
  },

  onShow: function() {
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
      dateList.push({ dateStr, dayName, dayNum, fullDate: date });
    }
    this.setData({ dateList, currentDate: dateList[0].dateStr });
  },

  initCalendar: function() {
    const now = new Date();
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const currentMonth = monthNames[now.getMonth()] + ' ' + now.getFullYear();
    
    const year = now.getFullYear();
    const month = now.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startingDay = firstDay.getDay();
    const totalDays = lastDay.getDate();
    const today = new Date();
    
    const calendarDays = [];
    
    // Empty cells for days before the first day of the month
    for (let i = 0; i < startingDay; i++) {
      calendarDays.push({ day: '', isEmpty: true, date: '' });
    }
    
    // Days of the month
    for (let day = 1; day <= totalDays; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
      calendarDays.push({
        day: day,
        date: dateStr,
        isToday: isToday,
        isEmpty: false
      });
    }
    
    this.setData({ currentMonth, calendarDays });
  },

  toggleCalendar: function() {
    this.setData({ showCalendar: !this.data.showCalendar });
  },

  stopPropagation: function() {
    // Prevent closing when clicking inside the modal
  },

  selectDate: function(e) {
    const date = e.currentTarget.dataset.date;
    if (!date) return;
    this.setData({ selectedDate: date, showCalendar: false });
    this.applyFilters();
  },

  applyFilters: function() {
    let filtered = [...this.data.events];
    if (this.data.selectedDate) {
      filtered = filtered.filter(event => event.date === this.data.selectedDate);
    }
    if (this.data.searchKeyword) {
      const keyword = this.data.searchKeyword.toLowerCase();
      filtered = filtered.filter(event => 
        (event.title && event.title.toLowerCase().includes(keyword)) ||
        (event.venue && event.venue.toLowerCase().includes(keyword)) ||
        (event.description && event.description.toLowerCase().includes(keyword))
      );
    }
    filtered.sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return (a.time || '00:00').localeCompare(b.time || '00:00');
    });
    this.setData({ filteredEvents: filtered });
  },

  onSearchInput: function(e) {
    this.setData({ searchKeyword: e.detail.value });
    this.applyFilters();
  },

  onSearchConfirm: function(e) {
    this.setData({ searchKeyword: e.detail.value });
    this.applyFilters();
  },

  loadEventsFromCacheOrFetch: function() {
    try {
      const cached = wx.getStorageSync('events_cache');
      const cacheTime = wx.getStorageSync('events_cache_time');
      if (cached && cacheTime) {
        const now = Date.now();
        if (now - cacheTime < 10 * 60 * 1000) {
          const events = JSON.parse(cached);
          this.setData({ events, loading: false, lastUpdateTime: cacheTime, hasLoadedOnce: true });
          this.applyFilters();
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
          const cloudUrls = events.map(e => e.promoImage).filter(url => url && url.startsWith('cloud://'));

          if (cloudUrls.length > 0) {
            try {
              const tempRes = await this.cloud.getTempFileURL({ fileList: cloudUrls });
              const urlMap = {};
              tempRes.fileList.forEach(f => { urlMap[f.fileID] = f.tempFileURL; });
              events.forEach(e => {
                if (e.promoImage && urlMap[e.promoImage]) {
                  e.promoImage = urlMap[e.promoImage];
                }
              });
            } catch (err) {
              console.error('getTempFileURL error:', err);
            }
          }

          const updateData = { events, lastUpdateTime: Date.now(), hasLoadedOnce: true };
          if (showLoadingIndicator) {
            updateData.loading = false;
          }
          this.setData(updateData);
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

const app = getApp();

Page({
  data: {
    events: [],
    filteredEvents: [],
    loading: true,
    refreshing: false,
    userInfo: null,
    userInitial: '?',
    selectedDate: '',
    searchKeyword: '',
    showCalendar: false,
    currentMonth: '',
    calendarYear: 0,
    calendarMonth: 0,
    calendarDays: [],
    weekdays: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'],
    todayNum: '',
    todayMonth: '',
    selectedDateNum: '',
    selectedDateMonth: '',
    eventDates: [],
    myRegistrationIds: [],
    cardImgHeight: 600
  },

  onLoad: function() {
    // Calculate card image height so the full card fits on screen.
    // Header ~130px + WeChat bars ~56px + card extras (venue+info+buttons+padding) ~200px
    var info = wx.getWindowInfo();
    var availPx = info.windowHeight - 56 - 130 - 200;
    var maxPx = Math.max(availPx, 220); // never smaller than 220px
    // Convert px → rpx (750rpx = screen width)
    var maxRpx = Math.round(maxPx * 750 / info.windowWidth);
    // Cap at 4:5 ratio (937rpx at 750rpx width) so large screens keep portrait look
    this.setData({ cardImgHeight: Math.min(maxRpx, 937) });

    var today = new Date();
    var monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    this.setData({
      todayNum: today.getDate(),
      todayMonth: monthShort[today.getMonth()]
    });

    var userInfo = wx.getStorageSync('userInfo') || app.globalData.userInfo;
    if (userInfo) {
      var initial = (userInfo.nickName || userInfo.name || '')[0] || '?';
      initial = initial.toUpperCase();
      this.setData({ userInfo: userInfo, userInitial: initial });
    }

    this.initCalendar(today.getFullYear(), today.getMonth());

    app.getCloud(function(cloud) {
      this.cloud = cloud;
      this.loadEventsFromCacheOrFetch();
      this.loadMyRegistrations();
    }.bind(this));
  },

  onShow: function() {
    var userInfo = wx.getStorageSync('userInfo') || app.globalData.userInfo;
    if (userInfo) {
      var initial = (userInfo.nickName || userInfo.name || '')[0] || '?';
      initial = initial.toUpperCase();
      this.setData({ userInfo: userInfo, userInitial: initial });
    }
    if (this.cloud) this.loadMyRegistrations();
  },

  // ===== CALENDAR =====

  initCalendar: function(year, month) {
    var monthNames = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
    var firstDay = new Date(year, month, 1).getDay();
    var totalDays = new Date(year, month + 1, 0).getDate();
    var today = new Date();
    var calendarDays = [];
    var self = this;

    for (var i = 0; i < firstDay; i++) {
      calendarDays.push({ day: '', isEmpty: true, date: '' });
    }

    for (var d = 1; d <= totalDays; d++) {
      var mo = String(month + 1).padStart(2, '0');
      var dy = String(d).padStart(2, '0');
      var dateStr = year + '-' + mo + '-' + dy;
      var isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;
      var hasEvent = self.data.eventDates.indexOf(dateStr) !== -1;
      calendarDays.push({ day: d, date: dateStr, isToday: isToday, isEmpty: false, hasEvent: hasEvent });
    }

    this.setData({
      currentMonth: monthNames[month] + ' ' + year,
      calendarYear: year,
      calendarMonth: month,
      calendarDays: calendarDays
    });
  },

  prevMonth: function() {
    var year = this.data.calendarYear;
    var month = this.data.calendarMonth - 1;
    if (month < 0) { month = 11; year--; }
    this.initCalendar(year, month);
  },

  nextMonth: function() {
    var year = this.data.calendarYear;
    var month = this.data.calendarMonth + 1;
    if (month > 11) { month = 0; year++; }
    this.initCalendar(year, month);
  },

  toggleCalendar: function() {
    this.setData({ showCalendar: !this.data.showCalendar });
  },

  selectDate: function(e) {
    var date = e.currentTarget.dataset.date;
    if (!date) return;
    wx.vibrateShort({ type: 'light' });
    var parts = date.split('-');
    var monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var num = parseInt(parts[2], 10);
    var mon = monthShort[parseInt(parts[1], 10) - 1];
    this.setData({ selectedDate: date, showCalendar: false, selectedDateNum: num, selectedDateMonth: mon });
    this.applyFilters();
  },

  clearDateFilter: function() {
    this.setData({ selectedDate: '', showCalendar: false, selectedDateNum: '', selectedDateMonth: '' });
    this.applyFilters();
  },

  clearAllFilters: function() {
    this.setData({ selectedDate: '', searchKeyword: '', selectedDateNum: '', selectedDateMonth: '' });
    this.applyFilters();
  },

  noop: function() {},

  // ===== SEARCH =====

  onSearchInput: function(e) {
    this.setData({ searchKeyword: e.detail.value });
    this.applyFilters();
  },

  onSearch: function(e) {
    this.setData({ searchKeyword: e.detail.value });
    this.applyFilters();
  },

  clearSearch: function() {
    this.setData({ searchKeyword: '' });
    this.applyFilters();
  },

  // ===== FILTERS =====

  applyFilters: function() {
    var filtered = this.data.events.slice();

    if (this.data.selectedDate) {
      filtered = filtered.filter(function(e) {
        return e.date === this.data.selectedDate;
      }.bind(this));
    } else {
      // Default: show today and future, with 5 AM cutoff (night events stay visible until 5 AM)
      var now = new Date();
      if (now.getHours() < 5) now.setDate(now.getDate() - 1);
      var today = now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0');
      filtered = filtered.filter(function(e) { return e.date >= today; });
    }

    if (this.data.searchKeyword) {
      var kw = this.data.searchKeyword.toLowerCase();
      filtered = filtered.filter(function(e) {
        return (e.title && e.title.toLowerCase().indexOf(kw) !== -1) ||
               (e.venueName && e.venueName.toLowerCase().indexOf(kw) !== -1);
      });
    }

    filtered.sort(function(a, b) {
      var dc = a.date.localeCompare(b.date);
      return dc !== 0 ? dc : (a.time || '').localeCompare(b.time || '');
    });

    this.setData({ filteredEvents: filtered });

    var regIds = this.data.myRegistrationIds;
    if (regIds && regIds.length > 0) {
      var marked = filtered.map(function(e) {
        return Object.assign({}, e, { isRegistered: regIds.indexOf(e._id) !== -1 });
      });
      this.setData({ filteredEvents: marked });
    }
  },

  // ===== REGISTRATIONS =====

  loadMyRegistrations: function() {
    var self = this;
    var doLoad = function(openid) {
      if (!openid || !self.cloud) return;
      var db = self.cloud.database();
      db.collection('registrations').where({ _openid: openid }).field({ eventId: true }).get({
        success: function(res) {
          var ids = res.data.map(function(r) { return r.eventId; });
          self.setData({ myRegistrationIds: ids });
          self.applyFilters();
        },
        fail: function(err) { console.error('[feed] loadMyRegistrations failed:', err); }
      });
    };
    if (app.globalData.openid) {
      doLoad(app.globalData.openid);
    } else {
      app.getOpenid(doLoad);
    }
  },

  // ===== DATA LOADING =====

  loadEventsFromCacheOrFetch: function() {
    try {
      var cached = wx.getStorageSync('events_cache');
      var cacheTime = wx.getStorageSync('events_cache_time');
      var age = Date.now() - cacheTime;
      if (cached && cacheTime && age < 10 * 60 * 1000) {
        var events = JSON.parse(cached);
        var self = this;
        self.resolveImages(events).then(function(resolvedEvents) {
          self.processEvents(resolvedEvents);
          self.setData({ events: resolvedEvents, loading: false });
          self.applyFilters();
        });
        // Background refresh only if cache is older than 2 minutes
        if (age > 2 * 60 * 1000) {
          self.fetchEvents(false);
        }
        return;
      }
    } catch (e) {}
    this.fetchEvents(true);
  },

  fetchEvents: function(showLoading) {
    if (showLoading === undefined) showLoading = true;
    if (!this.cloud) return;
    if (showLoading) this.setData({ loading: true });

    var self = this;
    var db = this.cloud.database();
    var _ = db.command;

    // Fetch from 14 days ago so past-date calendar filter works
    var fetchFrom = new Date();
    fetchFrom.setDate(fetchFrom.getDate() - 14);
    var fetchFromStr = fetchFrom.toISOString().split('T')[0];

    db.collection('events')
      .where({ date: _.gte(fetchFromStr) })
      .orderBy('date', 'asc')
      .limit(100)
      .get()
      .then(function(res) {
        var events = res.data;
        return self.resolveImages(events);
      })
      .then(function(events) {
        self.processEvents(events);
        self.setData({ events: events, loading: false, refreshing: false });
        self.applyFilters();
        try {
          wx.setStorageSync('events_cache', JSON.stringify(events));
          wx.setStorageSync('events_cache_time', Date.now());
        } catch (e) {}
      })
      .catch(function(err) {
        console.error('fetchEvents error:', err);
        self.setData({ loading: false, refreshing: false });
        wx.showToast({ title: 'Failed to load events', icon: 'none' });
      });
  },

  resolveImages: function(events) {
    var self = this;
    var allCloudUrls = [];

    events.forEach(function(event) {
      // Normalize: prefer promoImages, fallback to images
      if (!event.promoImages || !Array.isArray(event.promoImages) || event.promoImages.length === 0) {
        if (event.images && Array.isArray(event.images) && event.images.length > 0) {
          event.promoImages = event.images;
        } else if (event.promoImage) {
          event.promoImages = [event.promoImage];
        } else if (event.coverImage) {
          event.promoImages = [event.coverImage];
        } else {
          event.promoImages = [];
        }
      }
      event.promoImages.forEach(function(url) {
        if (url && url.indexOf('cloud://') === 0) allCloudUrls.push(url);
      });
      if (event.coverImage && event.coverImage.indexOf('cloud://') === 0) allCloudUrls.push(event.coverImage);
    });

    if (allCloudUrls.length === 0) return Promise.resolve(events);

    console.log('[images] resolving', allCloudUrls.length, 'cloud URLs:', allCloudUrls);

    return self.cloud.callFunction({
      name: 'clientAuth',
      data: { action: 'resolveImages', fileList: allCloudUrls }
    }).then(function(res) {
        var urlMap = res.result.urlMap || {};

        events.forEach(function(event) {
          event.promoImages = event.promoImages.map(function(url) {
            return urlMap[url] || url;
          });
        });

        return events;
      })
      .catch(function(err) {
        console.error('resolveImages error:', err);
        return events;
      });
  },

  processEvents: function(events) {
    var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var eventDates = [];

    events.forEach(function(event) {
      if (event.date) {
        var parts = event.date.split('-');
        if (parts.length === 3) {
          var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
          event.displayDate = dayNames[d.getDay()] + ', ' + d.getDate() + ' ' + monthNames[d.getMonth()];
        } else {
          event.displayDate = event.date;
        }
        event.displayDatetime = event.displayDate + (event.startTime ? '  ·  ' + event.startTime : '');
        eventDates.push(event.date);
      }

      if (!event.promoImages || !Array.isArray(event.promoImages)) {
        event.promoImages = event.promoImage ? [event.promoImage] : [];
      }
    });

    this.setData({ eventDates: eventDates });
    this.initCalendar(this.data.calendarYear, this.data.calendarMonth);
  },

  onPullDownRefresh: function() {
    this.setData({ refreshing: true });
    this.fetchEvents(false);
  },

  onReachBottom: function() {},

  // ===== NAVIGATION =====

  previewImage: function(e) {
    var url = e.currentTarget.dataset.url;
    var urls = e.currentTarget.dataset.urls;
    if (!url) return;
    wx.previewImage({ current: url, urls: urls && urls.length ? urls : [url] });
  },

  goToDetail: function(e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/event-detail/event-detail?id=' + id });
  },

  goToTicketDirect: function(e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/event-detail/event-detail?id=' + id + '&autoTicket=1' });
  },

  goToTickets: function() {
    wx.navigateTo({ url: '/pages/mytickets/mytickets' });
  },

  goToProfile: function() {
    wx.navigateTo({ url: '/pages/me/me' });
  },

stopPropagation: function() {},

  onShareAppMessage: function() {
    return {
      title: 'Check out upcoming events on The List',
      path: '/pages/feed/feed'
    };
  }
});
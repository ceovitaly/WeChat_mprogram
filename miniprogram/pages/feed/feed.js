const app = getApp();
const auth = require('../../utils/auth.js');
const { resolveEventImages } = require('../../utils/cloud.js');

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
    cardImgHeight: 600,
    headerPadTop: 96,      // px; corrected from the capsule rect in onLoad
    refresherThreshold: 90, // px; corrected from the status bar in onLoad
    headerHidden: false,
    scrolled: false
  },

  onLoad: function() {
    // Which card images have finished loading, keyed by event _id. Lives
    // outside data so applyFilters() rebuilding filteredEvents doesn't
    // reset the flags (which would re-fade already-visible images).
    this._imgLoaded = {};

    var info = wx.getWindowInfo();

    // The header is one full-width row now, so it must start below the
    // floating WeChat capsule (custom navigation) — measure it, with a
    // status-bar fallback.
    var padTop = 0;
    try {
      var menu = wx.getMenuButtonBoundingClientRect();
      if (menu && menu.bottom) padTop = menu.bottom + 12;
    } catch (e) {}
    if (!padTop) padTop = (info.statusBarHeight || 44) + 48;

    // Header total height: capsule clearance + 40px row + 8px bottom pad.
    // Used by the collapse logic (never hide while the header's own slot
    // is still on screen) and the card-height math below.
    var headerPx = padTop + 48;
    this._hideMinTop = headerPx + 24;
    this._lastTop = 0;
    this._scrollDir = 0;
    this._dirAnchor = 0;

    // Calculate card image height so the full card fits on screen.
    // Header + card extras (title + CTA + padding) ~190px
    var availPx = info.windowHeight - headerPx - 190;
    var maxPx = Math.max(availPx, 220); // never smaller than 220px
    // Convert px → rpx (750rpx = screen width)
    var maxRpx = Math.round(maxPx * 750 / info.windowWidth);
    // Cap at 4:5 ratio (937rpx at 750rpx width) so large screens keep portrait look
    this.setData({
      cardImgHeight: Math.min(maxRpx, 937),
      headerPadTop: padTop,
      // Pull-to-refresh spinner sits at the bottom of this area, i.e.
      // just below the status bar / notch.
      refresherThreshold: (info.statusBarHeight || 20) + 56
    });

    var today = new Date();
    var monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    this.setData({
      todayNum: today.getDate(),
      todayMonth: monthShort[today.getMonth()]
    });

    this.refreshAuthUI();

    this.initCalendar(today.getFullYear(), today.getMonth());

    app.getCloud(function(cloud) {
      this.cloud = cloud;
      this.loadEventsFromCacheOrFetch();
      this.loadMyRegistrations();
    }.bind(this));
  },

  onShow: function() {
    this.refreshAuthUI();
    this.loadMyRegistrations();
  },

  // Header identity pill and card badges both derive from the central
  // auth state so they can never disagree (no more split-brain between
  // the cached userInfo and openid-based queries).
  refreshAuthUI: function() {
    var self = this;
    auth.getAuth(function(profile) {
      if (profile) {
        var initial = ((profile.nickName || profile.name || '')[0] || '?').toUpperCase();
        self.setData({ userInfo: profile, userInitial: initial });
      } else {
        self.setData({ userInfo: null, userInitial: '?' });
      }
    });
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

    // Per-card stagger delay for the entrance animation (see .event-card
    // in feed.wxss). Capped so long lists don't keep piling on delay —
    // cards past the cap all share the same (max) delay.
    var maxStaggerIndex = 9;
    var staggerStepMs = 60;
    var loadedMap = this._imgLoaded || {};
    filtered.forEach(function(e, i) {
      e.animDelay = Math.min(i, maxStaggerIndex) * staggerStepMs;
      // Carry the image fade-in state across list rebuilds (see onLoad)
      e.imgLoaded = !!loadedMap[e._id];
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
    auth.getAuth(function(profile) {
      if (!profile) {
        // Anonymous: no "You're on the list" badges anywhere.
        self.setData({ myRegistrationIds: [] });
        self.applyFilters();
        return;
      }
      if (!self.cloud) return;
      var db = self.cloud.database();
      db.collection('registrations').where({ _openid: profile._openid }).field({ eventId: true }).get({
        success: function(res) {
          var ids = res.data.map(function(r) { return r.eventId; });
          self.setData({ myRegistrationIds: ids });
          self.applyFilters();
        },
        fail: function(err) { console.error('[feed] loadMyRegistrations failed:', err); }
      });
    });
  },

  // ===== DATA LOADING =====

  loadEventsFromCacheOrFetch: function() {
    try {
      var cached = wx.getStorageSync('events_cache');
      var cacheTime = wx.getStorageSync('events_cache_time');
      var age = Date.now() - cacheTime;
      if (cached && cacheTime && age < 10 * 60 * 1000) {
        var events = this.normalizeEventImages(JSON.parse(cached));
        var self = this;
        resolveEventImages(events).then(function(resolvedEvents) {
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
        var events = self.normalizeEventImages(res.data);
        return resolveEventImages(events);
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

  // Normalize each event's images to a canonical `promoImages` array
  // (preferring existing promoImages, then images, then promoImage/coverImage)
  // before cloud:// URLs are resolved. This is feed-specific: the feed card
  // only ever renders promoImages[0], so other pages don't need this shape.
  normalizeEventImages: function(events) {
    events.forEach(function(event) {
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
    });
    return events;
  },

  processEvents: function(events) {
    var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var monthShort = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    var dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var eventDates = [];

    events.forEach(function(event) {
      // Chip fields default empty: the card's date chip hides via wx:if
      // when the date is missing/unparseable.
      event.chipDay = '';
      event.chipMonth = '';
      if (event.date) {
        var parts = event.date.split('-');
        if (parts.length === 3) {
          var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
          event.displayDate = dayNames[d.getDay()] + ', ' + d.getDate() + ' ' + monthNames[d.getMonth()];
          // Compact form for the card's date chip (image overlay)
          event.chipDay = d.getDate();
          event.chipMonth = monthShort[d.getMonth()];
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

  // Fade a card image in once loaded (see .card-img in feed.wxss). The
  // per-id map is authoritative; the setData only patches the item that
  // is still at the same index (the list may have been re-filtered
  // between render and load — applyFilters re-derives the flag then).
  onCardImgLoad: function(e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    if (!this._imgLoaded) this._imgLoaded = {};
    if (this._imgLoaded[id]) return;
    this._imgLoaded[id] = true;
    var idx = e.currentTarget.dataset.index;
    var item = this.data.filteredEvents[idx];
    if (item && item._id === id && !item.imgLoaded) {
      var patch = {};
      patch['filteredEvents[' + idx + '].imgLoaded'] = true;
      this.setData(patch);
    }
  },

  onPullDownRefresh: function() {
    this.setData({ refreshing: true });
    this.fetchEvents(false);
  },

  onReachBottom: function() {},

  // Collapse-on-scroll for the sticky header. Fires on every scroll frame,
  // so it must stay cheap: setData happens ONLY when one of the two
  // booleans actually flips. Hysteresis: direction changes are tracked
  // against an anchor point, and the header only reacts after ~10px of
  // travel in one direction (so slow creeping scrolls still count, but
  // jitter doesn't). It never hides while its own slot could still be on
  // screen (scrollTop < header height + margin), and any scroll-up
  // reveals it.
  onFeedScroll: function(e) {
    var top = e.detail.scrollTop;

    var scrolled = top > 8;
    if (scrolled !== this.data.scrolled) this.setData({ scrolled: scrolled });

    var delta = top - this._lastTop;
    this._lastTop = top;
    if (delta === 0) return;

    var dir = delta > 0 ? 1 : -1;
    if (dir !== this._scrollDir) {
      this._scrollDir = dir;
      this._dirAnchor = top - delta;
    }
    if (Math.abs(top - this._dirAnchor) < 10) return;

    var hidden;
    if (top < this._hideMinTop) hidden = false;
    else hidden = dir === 1;
    if (hidden !== this.data.headerHidden) this.setData({ headerHidden: hidden });
  },

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
    // Signed-in users get their profile; anonymous users go to sign-in.
    auth.getAuth(function(profile) {
      wx.navigateTo({ url: profile ? '/pages/me/me' : '/pages/register/register' });
    });
  },

stopPropagation: function() {},

  onShareAppMessage: function() {
    return {
      title: 'Check out upcoming events on The List',
      path: '/pages/feed/feed'
    };
  }
});
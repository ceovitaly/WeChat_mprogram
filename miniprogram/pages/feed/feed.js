const app = getApp();
const auth = require('../../utils/auth.js');
const { resolveEventImages } = require('../../utils/cloud.js');
const tabDots = require('../../utils/tab-dots.js');

Page({
  data: {
    events: [],
    filteredEvents: [],
    paidEvents: [],
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
    navPadTop: 48,          // px; distance to the capsule's top edge — corrected in onLoad
    navBarHeight: 32,       // px; icon row height, matches the capsule's own height — corrected in onLoad
    navSegRowWidth: 175,    // px; segmented control width, clear of the capsule — corrected in onLoad
    refresherThreshold: 50, // px; corrected from the status bar in onLoad
    // Pre-trigger pull-to-refresh dot feedback (onRefresherPulling below).
    // One inline transform/opacity style string per dot, staggered; reset
    // to '' (baseline CSS look, see .refresh-dot in feed.wxss) once the
    // pull ends (release-without-trigger or refresh-complete).
    dotStyles: ['', '', ''],
    // Card-specific press-spring state (Task 2) — the _id of the single
    // event-card currently pressed, or '' when none. Compared per-item in
    // the wx:for (feed.wxml) rather than a flat boolean so unrelated cards
    // never move together.
    pressedCardId: '',
    // Header always stays visible now — no hide/reveal state at all.
    scrolled: false,
    // Content-first redesign: no permanent header row anymore — Profile
    // and Tickets nav-bar buttons navigate directly (goToProfile/
    // goToTickets), and an expand-down search panel, closed by default.
    showSearchPanel: false,
    showPaidEvents: false
  },

  onLoad: function() {
    var info = wx.getWindowInfo();

    // The nav-bar's icon row must occupy the SAME vertical band as the
    // floating WeChat capsule (custom navigation) — not a new band below
    // it — so the icons land at the same height as the capsule's own
    // icons. navPadTop clears down to where the capsule starts;
    // navBarHeight is the icon row's own height, matching the capsule's
    // height exactly so a centered icon row's center coincides with the
    // capsule's center. Falls back to the status bar height / a sane
    // default if the capsule rect API is unavailable.
    var navPadTop = 0;
    var navBarHeight = 0;
    var menu = null;
    try {
      menu = wx.getMenuButtonBoundingClientRect();
      if (menu && menu.top) {
        navPadTop = menu.top;
        navBarHeight = menu.height || 32;
      }
    } catch (e) {}
    if (!navPadTop) navPadTop = info.statusBarHeight || 44;
    if (!navBarHeight) navBarHeight = 32;

    // The segmented control should stretch to fill essentially all the
    // horizontal space between .feed-nav's own left padding and the
    // WeChat capsule's left edge, with a small buffer gap so the two stay
    // visually distinct (never touching/merging with the capsule).
    // .feed-nav's CSS padding-left is 24rpx (design-width-relative) — convert
    // to real px (same unit as menu.left/info.windowWidth) before the
    // subtraction. Falls back to a rough estimate if the capsule rect API
    // is unavailable, matching the fallback style used for navPadTop/
    // navBarHeight above.
    var leftPaddingPx = 24 * info.windowWidth / 750;
    var navSegRowBufferPx = 12;
    var navSegRowWidth;
    if (menu && menu.left) {
      navSegRowWidth = menu.left - leftPaddingPx - navSegRowBufferPx;
    } else {
      navSegRowWidth = info.windowWidth - leftPaddingPx - 200;
    }

    // Nav-bar total footprint: capsule clearance + the icon row's own
    // height + a little bottom breathing room. Used by the card-height
    // math below — a slimmer nav-bar means more of this goes to cards,
    // which is the whole point of this redesign.
    var headerPx = navPadTop + navBarHeight + 12;

    // Calculate card image height so the full card fits on screen.
    // Nav-bar + card extras (title + CTA + padding) ~190px
    var availPx = info.windowHeight - headerPx - 190;
    var maxPx = Math.max(availPx, 220); // never smaller than 220px
    // Convert px → rpx (750rpx = screen width)
    var maxRpx = Math.round(maxPx * 750 / info.windowWidth);
    // Cap at 4:5 ratio (937rpx at 750rpx width) so large screens keep portrait look
    this.setData({
      cardImgHeight: Math.min(maxRpx, 937),
      navPadTop: navPadTop,
      navBarHeight: navBarHeight,
      navSegRowWidth: navSegRowWidth,
      // Pull-to-refresh spinner sits at the bottom of this area, i.e.
      // just below the status bar / notch.
      refresherThreshold: (info.statusBarHeight || 20) + 20
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
    this.syncRequestedTopTab();
    this.refreshAuthUI();
    this.loadMyRegistrations();
  },

  onHide: function() {
    this.clearNewEventLabels(this.data.showPaidEvents ? 'events' : 'feed');
  },

  syncRequestedTopTab: function() {
    var requested = app.globalData.guestTopTab;
    var showPaidEvents = requested === 'events';
    app.globalData.guestTopTab = showPaidEvents ? 'events' : 'feed';
    if (showPaidEvents !== this.data.showPaidEvents) {
      this.setData({ showPaidEvents: showPaidEvents });
    }
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
        tabDots.updateProfileDot(profile);
      } else {
        self.setData({ userInfo: null, userInitial: '?' });
        tabDots.updateProfileDot(null);
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
    filtered.forEach(function(e, i) {
      e.animDelay = Math.min(i, maxStaggerIndex) * staggerStepMs;
    });

    var regIds = this.data.myRegistrationIds;
    var dotCollections = this.getNotificationEventCollections();
    var newFeedIds = this.rememberNewEventIds(
      '_sessionNewFeedIds',
      tabDots.getUnseenEventIds(dotCollections.feed, 'feed')
    );
    var newPaidIds = this.rememberNewEventIds(
      '_sessionNewPaidIds',
      tabDots.getUnseenEventIds(dotCollections.paid, 'events')
    );
    var paidEvents = filtered.filter(function(e) {
      return e.isPaid === true || e.hasPaidPackages === true;
    }).map(function(e) {
      return Object.assign({}, e, {
        isRegistered: !!(regIds && regIds.indexOf(e._id) !== -1),
        isNew: newPaidIds.indexOf(e._id) !== -1
      });
    });
    var marked = filtered.map(function(e) {
      return Object.assign({}, e, {
        isRegistered: !!(regIds && regIds.indexOf(e._id) !== -1),
        isNew: newFeedIds.indexOf(e._id) !== -1
      });
    });
    this.setData({ filteredEvents: marked, paidEvents: paidEvents });

    tabDots.updateEventDots(
      dotCollections.feed,
      dotCollections.paid,
      app.globalData.guestTopTab || 'feed',
      this._eventsReady === true
    );
    tabDots.updateWalletDot(dotCollections.feed.some(function(event) {
      return !!(regIds && regIds.indexOf(event._id) !== -1);
    }));
  },

  rememberNewEventIds: function(key, ids) {
    var remembered = this[key] || [];
    (ids || []).forEach(function(id) {
      if (remembered.indexOf(id) === -1) remembered.push(id);
    });
    this[key] = remembered;
    return remembered;
  },

  // Keep notification state independent from temporary search/date filters.
  getNotificationEventCollections: function() {
    var now = new Date();
    if (now.getHours() < 5) now.setDate(now.getDate() - 1);
    var today = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0');
    var feed = this.data.events.filter(function(event) {
      return event.date && event.date >= today;
    });
    var paid = feed.filter(function(event) {
      return event.isPaid === true || event.hasPaidPackages === true;
    });
    return { feed: feed, paid: paid };
  },

  // ===== REGISTRATIONS =====

  loadMyRegistrations: function() {
    var self = this;
    auth.getAuth(function(profile) {
      if (!profile) {
        // Anonymous: no "You're on the list" badges anywhere.
        self.setData({ myRegistrationIds: [] });
        tabDots.updateWalletDot(false);
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
      var cachedEvents = cached ? JSON.parse(cached) : null;
      // Never let a recently cached empty/error result suppress a real fetch.
      if (Array.isArray(cachedEvents) && cachedEvents.length > 0 && cacheTime && age < 10 * 60 * 1000) {
        var events = this.normalizeEventImages(cachedEvents);
        // Content first: cards must not wait for cloud image URL resolution.
        this.renderEvents(events, false);
        this.enrichEventImages(events);
        this.fetchEvents(false);
        return;
      }
    } catch (e) {
      console.error('[feed] cache access error:', e);
    }
    this.fetchEvents(true);
  },

  fetchEvents: function(showLoading) {
    if (showLoading === undefined) showLoading = true;
    if (!this.cloud) return;
    if (showLoading) this.setData({ loading: true });

    var self = this;

    // Fetch from 14 days ago so past-date calendar filter works
    var fetchFrom = new Date();
    fetchFrom.setDate(fetchFrom.getDate() - 14);
    var fetchFromStr = fetchFrom.toISOString().split('T')[0];

    this.cloud.callFunction({
      name: 'clientAuth',
      data: { action: 'getEvents', dateFrom: fetchFromStr }
    })
      .then(function(res) {
        var result = (res && res.result) || {};
        if (!result.success || !Array.isArray(result.data)) {
          throw new Error(result.message || 'Invalid events response');
        }
        var events = self.normalizeEventImages(result.data);
        self.renderEvents(events, true);
        self.enrichEventImages(events);
      })
      .catch(function(err) {
        // Compatibility fallback for DevTools/environments where the updated
        // clientAuth bundle has not been uploaded yet. The cloud function is
        // primary because client-side DB queries have a lower document cap.
        console.warn('[feed] clientAuth getEvents failed, using DB fallback:', err);
        self.fetchEventsDirect(fetchFromStr).catch(function(fallbackErr) {
          console.error('fetchEvents error:', fallbackErr);
          self.setData({ loading: false, refreshing: false });
          wx.showToast({ title: 'Failed to load events', icon: 'none' });
        });
      });
  },

  fetchEventsDirect: function(fetchFromStr) {
    var self = this;
    var db = this.cloud.database();
    var _ = db.command;
    return db.collection('events')
      .where({ date: _.gte(fetchFromStr) })
      .orderBy('date', 'asc')
      .limit(100)
      .get()
      .then(function(res) {
        var events = self.normalizeEventImages((res && res.data) || []);
        self.renderEvents(events, true);
        self.enrichEventImages(events);
      });
  },

  // Render event data immediately, before optional cloud:// image enrichment.
  // A slow/misconfigured image resolver must never leave the feed empty.
  renderEvents: function(events, updateCache) {
    this.processEvents(events);
    this.setData({ events: events, loading: false, refreshing: false });
    this._eventsReady = true;
    this.applyFilters();
    if (updateCache) {
      try {
        wx.setStorageSync('events_cache', JSON.stringify(events));
        wx.setStorageSync('events_cache_time', Date.now());
      } catch (e) {}
    }
  },

  // Enrich the already-visible cards in the background. Match by _id so a
  // delayed response cannot reorder or replace a newer event fetch.
  enrichEventImages: function(events) {
    var self = this;
    resolveEventImages(events).then(function(resolvedEvents) {
      var byId = {};
      (resolvedEvents || []).forEach(function(event) { if (event && event._id) byId[event._id] = event; });
      var merged = self.data.events.map(function(event) {
        return byId[event._id] ? Object.assign({}, event, byId[event._id]) : event;
      });
      self.processEvents(merged);
      self.setData({ events: merged });
      self.applyFilters();
      try {
        wx.setStorageSync('events_cache', JSON.stringify(merged));
        wx.setStorageSync('events_cache_time', Date.now());
      } catch (e) {}
    }).catch(function(err) {
      console.error('[feed] image enrichment failed:', err);
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

  onPullDownRefresh: function() {
    // The dots' pre-trigger progress styles no longer matter once the
    // actual refresh animation (refresh-dot-active, feed.wxss) takes over;
    // reset them so nothing lingers once refreshing flips back to false.
    this.setData({ refreshing: true, dotStyles: ['', '', ''] });
    this.fetchEvents(false);
  },

  onReachBottom: function() {},

  // ===== PULL-TO-REFRESH DOT FEEDBACK (Task 1) =====
  //
  // Plain (non-worklet) handler for scroll-view's bindrefresherpulling,
  // which fires continuously while the user is dragging down, before
  // refresher-triggered becomes true. e.detail.dy is the current pull
  // distance in px. Confidence note: a worklet:bindrefresherpulling
  // binding was considered but not used here — whether that exact
  // attribute accepts a worklet binding the same way worklet:onscroll did
  // in an earlier (since-reverted) attempt this session could not be
  // verified without live DevTools, so this plain setData path was chosen
  // deliberately as the option that cannot crash the page.
  onRefresherPulling: function(e) {
    if (this.data.refreshing) return; // bounce animation already owns the dots
    var dy = (e.detail && e.detail.dy) || 0;
    var threshold = this.data.refresherThreshold || 50;
    var progress = dy / threshold;
    if (progress < 0) progress = 0;
    if (progress > 1) progress = 1;

    // Staggered bands so the three dots don't all pop in at once: dot 1
    // ramps 0→0.6, dot 2 0.2→0.8, dot 3 0.4→1.0 of the overall pull.
    var bands = [[0, 0.6], [0.2, 0.8], [0.4, 1.0]];
    var styles = bands.map(function(band) {
      var lo = band[0], hi = band[1];
      var p = (progress - lo) / (hi - lo);
      if (p < 0) p = 0;
      if (p > 1) p = 1;
      var scale = (0.4 + p * 0.6).toFixed(3);   // 0.4 -> 1.0
      var opacity = (0.25 + p * 0.75).toFixed(3); // 0.25 -> 1.0
      return 'transform: scale(' + scale + '); opacity: ' + opacity + ';';
    });

    this.setData({ dotStyles: styles });
  },

  // Fires when the user releases the pull without crossing the refresh
  // threshold (no refresh triggered) — snap the dots back to baseline
  // rather than leaving them stuck at whatever progress they reached.
  onRefresherRestore: function() {
    this.setData({ dotStyles: ['', '', ''] });
  },

  // ===== CARD PRESS-SPRING FEEDBACK (Task 2) =====
  //
  // Plain touch handlers (no worklet) toggling pressedCardId via setData;
  // the actual spring-overshoot feel comes from the CSS transition on
  // .event-card / .event-card--pressed (feed.wxss), using the same
  // cubic-bezier(0.34, 1.56, 0.64, 1) curve already trusted elsewhere in
  // this app. This is the CSS-bezier-fallback tier — chosen over a
  // worklet-driven touch approach because it's guaranteed to work without
  // live DevTools verification.
  onCardTouchStart: function(e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    this.setData({ pressedCardId: id });
  },

  onCardTouchEnd: function() {
    if (!this.data.pressedCardId) return;
    this.setData({ pressedCardId: '' });
  },

  // Header stays fully visible at all times now — this only owns the
  // `scrolled` boolean (the header's box-shadow boundary), plus closing
  // the search panel if it's open when the user starts scrolling. Fires
  // continuously during scrolling, so both checks are batched into a
  // single setData call per invocation (built conditionally) rather than
  // one setData per flag — two separate calls here would hurt scroll
  // performance.
  onFeedScroll: function(e) {
    var top = e.detail.scrollTop;
    var scrolled = top > 8;
    var patch = {};
    var hasPatch = false;
    if (scrolled !== this.data.scrolled) { patch.scrolled = scrolled; hasPatch = true; }
    if (this.data.showSearchPanel) { patch.showSearchPanel = false; hasPatch = true; }
    if (hasPatch) this.setData(patch);
  },

  // ===== SEARCH PANEL =====

  toggleSearchPanel: function() {
    this.setData({ showSearchPanel: !this.data.showSearchPanel });
  },

  togglePaidEvents: function() {
    this.setFeedTab(this.data.showPaidEvents ? 'feed' : 'events');
  },

  onAppTabChange: function(e) {
    this.setFeedTab(e.detail.tab);
  },

  showFeedFromEmpty: function() {
    this.setFeedTab('feed');
  },

  setFeedTab: function(tab) {
    var showPaidEvents = tab === 'events';
    if (showPaidEvents !== this.data.showPaidEvents) {
      this.clearNewEventLabels(this.data.showPaidEvents ? 'events' : 'feed');
    }
    app.globalData.guestTopTab = showPaidEvents ? 'events' : 'feed';
    if (showPaidEvents !== this.data.showPaidEvents) {
      this.setData({ showPaidEvents: showPaidEvents });
    }
    var dotCollections = this.getNotificationEventCollections();
    tabDots.markEventTabSeen(showPaidEvents ? 'events' : 'feed', dotCollections.feed, dotCollections.paid);
  },

  clearNewEventLabels: function(tab) {
    if (tab === 'events') {
      this._sessionNewPaidIds = [];
      if ((this.data.paidEvents || []).some(function(event) { return event.isNew; })) {
        this.setData({ paidEvents: this.data.paidEvents.map(function(event) {
          return Object.assign({}, event, { isNew: false });
        }) });
      }
      return;
    }

    this._sessionNewFeedIds = [];
    if ((this.data.filteredEvents || []).some(function(event) { return event.isNew; })) {
      this.setData({ filteredEvents: this.data.filteredEvents.map(function(event) {
        return Object.assign({}, event, { isNew: false });
      }) });
    }
  },

  // Broader "interacting with other elements should hide the search bar"
  // case: a plain tap on a card (no scroll distance) never fires
  // bindscroll, so this closes the panel on the very first touch anywhere
  // in the scrollable feed content. bindtouchstart (not catchtouchstart)
  // lets the touch keep propagating normally — tapping a card while the
  // panel happens to be open both closes the panel AND still triggers the
  // card's own tap/navigation.
  onFeedTouchStart: function() {
    if (this.data.showSearchPanel) this.setData({ showSearchPanel: false });
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
    app.globalData.guestTopTab = 'wallet';
    wx.switchTab({ url: '/pages/mytickets/mytickets' });
  },

  goToProfile: function() {
    app.globalData.guestTopTab = 'profile';
    wx.switchTab({ url: '/pages/me/me' });
  },

stopPropagation: function() {},

  onShareAppMessage: function() {
    return {
      title: 'Check out upcoming events on The List',
      path: '/pages/feed/feed'
    };
  }
});
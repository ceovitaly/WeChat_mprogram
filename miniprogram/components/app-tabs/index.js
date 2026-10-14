const app = getApp();
const tabDots = require('../../utils/tab-dots.js');

Component({
  properties: {
    activeTab: { type: String, value: 'feed' },
    scrolled: { type: Boolean, value: false }
  },

  data: {
    navPadTop: 48,
    navBarHeight: 32,
    navRowWidth: 175,
    dots: { feed: false, wallet: false, events: false, profile: false }
  },

  lifetimes: {
    attached() {
      this.updateLayout();
      this._unsubscribeDots = tabDots.subscribe((dots) => this.setData({ dots }));
    },
    detached() {
      if (this._unsubscribeDots) this._unsubscribeDots();
    }
  },

  methods: {
    updateLayout() {
      const info = wx.getWindowInfo();
      let menu = null;
      let navPadTop = info.statusBarHeight || 44;
      let navBarHeight = 32;

      try {
        menu = wx.getMenuButtonBoundingClientRect();
        if (menu && menu.top) {
          navPadTop = menu.top;
          navBarHeight = menu.height || 32;
        }
      } catch (e) {}

      const leftPaddingPx = 24 * info.windowWidth / 750;
      const navRowWidth = menu && menu.left
        ? menu.left - leftPaddingPx - 12
        : info.windowWidth - leftPaddingPx - 100;

      this.setData({
        navPadTop,
        navBarHeight,
        navRowWidth: Math.max(navRowWidth, 190)
      });
    },

    onTabTap(e) {
      const tab = e.currentTarget.dataset.tab;
      if (!tab) return;

      app.globalData.guestTopTab = tab;
      const pages = getCurrentPages();
      const current = pages.length ? pages[pages.length - 1].route : '';

      if (tab === 'feed' || tab === 'events') {
        if (current === 'pages/feed/feed') {
          this.triggerEvent('change', { tab });
          return;
        }
        wx.switchTab({ url: '/pages/feed/feed' });
        return;
      }

      const route = tab === 'wallet'
        ? '/pages/mytickets/mytickets'
        : '/pages/me/me';
      if (current === route.slice(1)) return;
      wx.switchTab({ url: route });
    }
  }
});

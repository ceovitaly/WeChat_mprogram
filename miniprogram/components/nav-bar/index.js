/**
 * Capsule-aligned custom navigation bar.
 *
 * Lives in the MAIN package (not packageAdmin) because both main-package
 * and subpackage pages use it — reference it as
 * "/components/nav-bar/index" from every usingComponents.
 *
 * Every page that uses this MUST set "navigationStyle": "custom" in its
 * own .json, otherwise the system bar is drawn on top of it.
 *
 * The whole point is that the bar's content row occupies the SAME
 * horizontal band as the floating WeChat capsule ("···⊙", top-right)
 * rather than a fresh band below it — that reclaims a full nav-bar's
 * worth of vertical space. See _measure() for the math.
 */
Component({
  options: {
    multipleSlots: true
  },

  properties: {
    // Page title. Rendered in the capsule band, left-aligned by default.
    title: {
      type: String,
      value: ''
    },
    // Render the back chevron on the left.
    showBack: {
      type: Boolean,
      value: false
    },
    // Optional colour override for the back chevron (counter flows use
    // red for "leave this venue"). Defaults to admin blue.
    backColor: {
      type: String,
      value: ''
    },
    // 'left' (default) or 'center'.
    align: {
      type: String,
      value: 'left'
    },
    // Tapping back calls wx.navigateBack() itself. Custom-component
    // consumers can't be detected from here, so defaulting this to true
    // guarantees no page can ever trap the user by forgetting to bind
    // the `back` event. Set auto-back="{{false}}" when the page needs to
    // do something else (confirm dialog, step-back within a page, ...)
    // and handle bind:back instead.
    autoBack: {
      type: Boolean,
      value: true
    }
  },

  data: {
    // px. Fallbacks only — corrected in _measure() on attach.
    navPadTop: 44,
    navBarHeight: 32,
    rowWidth: 0
  },

  lifetimes: {
    attached: function () {
      this._measure();
    }
  },

  methods: {
    _measure: function () {
      var info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();

      // Vertical: padding-top clears down to where the capsule STARTS
      // (menu.top), and the content row's own height equals the
      // capsule's height — so a vertically centred row shares the
      // capsule's centre line exactly. Using menu.bottom here instead
      // pushes the row below the capsule; that is a real bug, not a
      // style choice.
      var menu = null;
      var navPadTop = 0;
      var navBarHeight = 0;
      try {
        menu = wx.getMenuButtonBoundingClientRect();
        if (menu && menu.top) {
          navPadTop = menu.top;
          navBarHeight = menu.height || 32;
        }
      } catch (e) {}
      if (!navPadTop) navPadTop = info.statusBarHeight || 44;
      if (!navBarHeight) navBarHeight = 32;

      // Horizontal: stretch the content row from the container's own
      // 24rpx left padding to just short of the capsule's left edge, so
      // right-aligned actions never slide underneath it. The CSS padding
      // is design-width-relative (rpx) — convert to real px before
      // subtracting from menu.left / windowWidth.
      var leftPaddingPx = 24 * info.windowWidth / 750;
      var bufferPx = 12;
      var rowWidth;
      if (menu && menu.left) {
        rowWidth = menu.left - leftPaddingPx - bufferPx;
      } else {
        rowWidth = info.windowWidth - leftPaddingPx - 200;
      }

      this.setData({
        navPadTop: navPadTop,
        navBarHeight: navBarHeight,
        rowWidth: rowWidth
      });
    },

    onBackTap: function () {
      this.triggerEvent('back');
      if (this.data.autoBack) {
        wx.navigateBack();
      }
    }
  }
});

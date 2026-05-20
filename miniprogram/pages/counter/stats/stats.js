Page({
  data: {},

  onShow() {
    this._syncTabBar()
  },

  _syncTabBar() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().updateTabs()
      this.getTabBar().setData({ selected: 1 })
    }
  }
})
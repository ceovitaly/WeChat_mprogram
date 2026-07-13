Component({
  properties: {
    title: {
      type: String,
      value: ''
    }
  },

  methods: {
    // Doesn't call wx.navigateBack() itself — just emits `back` so the
    // host page's existing handler (which already calls wx.navigateBack())
    // keeps deciding what happens, preserving prior per-page behavior.
    onBackTap() {
      this.triggerEvent('back');
    }
  }
});

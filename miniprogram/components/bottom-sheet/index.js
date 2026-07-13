Component({
  properties: {
    show: {
      type: Boolean,
      value: false
    },
    // 'bottom' (default): sheet anchored to the bottom edge, full width,
    // rounded top corners only — used by event-detail's ticket sheet and
    // me's name-edit sheet.
    // 'center': fixed-width card centered on screen — used by feed's
    // calendar picker, which is a compact dialog rather than a
    // bottom-anchored sheet. Kept as its own variant instead of forcing
    // the calendar into a bottom-anchored layout, to avoid an unrequested
    // visual change to it.
    position: {
      type: String,
      value: 'bottom'
    }
  },

  methods: {
    onMaskTap() {
      this.triggerEvent('close');
    },
    // Stops taps on the sheet content from bubbling to the mask's
    // bindtap (which would otherwise close the sheet).
    noop() {}
  }
});

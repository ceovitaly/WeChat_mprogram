/**
 * <bottom-sheet> — shared modal / bottom-sheet shell.
 *
 * Replaces the hand-rolled `.modal-overlay` + `.modal` pair that was
 * copy-pasted into event-edit, staff, promoters and guests.
 *
 * API is deliberately identical to the guest app's
 * `components/bottom-sheet/` so the two apps stay conceptually the same.
 *
 * Properties
 *   show     {Boolean} whether the sheet is mounted (uses wx:if, so the
 *                      contents are destroyed when hidden — same as the
 *                      `wx:if="{{showModal}}"` the pages used before).
 *   position {String}  'bottom' (default) — anchored to the bottom edge,
 *                      rounded top corners, respects the bottom safe area.
 *                      'top' — anchored to the TOP of the screen, rounded
 *                      bottom corners, respects the top safe area. Used by
 *                      event-edit's rich-text description editor so the
 *                      on-screen keyboard can never cover the toolbar.
 *
 * Events
 *   bind:close  fired when the user taps the dimmed mask. Host pages wire
 *               this to the same no-argument handler they previously used
 *               as the overlay's catchtap (closeModal / closeAddModal /
 *               closeActions / closeDescEditor / closePromoterSheet).
 *
 * Slot content is rendered in the HOST PAGE's scope, so `.modal-header`,
 * `.modal-body`, `.modal-footer` etc. resolve from app.wxss / the page's
 * own wxss, not from this component's wxss.
 *
 * NOTE: there is intentionally NO entrance animation. The admin sheets
 * have never had one, and this refactor must not change how anything
 * renders. If one is ever added it must be opacity-only — the guest app
 * found on real devices (not reproducible in the simulator) that a
 * transform-based animation on the sheet shell visually detaches native
 * <input>/<textarea> children rendered inside the slot.
 */
Component({
  properties: {
    show: {
      type: Boolean,
      value: false
    },
    position: {
      type: String,
      value: 'bottom'
    }
  },

  methods: {
    onMaskTap() {
      this.triggerEvent('close');
    },
    // Stops taps on the sheet body from bubbling to the mask's bindtap
    // (which would otherwise close the sheet). Replaces each page's own
    // `stopPropagation` / `noop` handler on the inner `.modal` view.
    noop() {}
  }
});

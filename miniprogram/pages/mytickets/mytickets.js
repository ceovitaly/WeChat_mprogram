const app = getApp();
const auth = require('../../utils/auth.js');
const { callFunction } = require('../../utils/cloud.js');
const pay = require('../../utils/pay.js');

Page({
  data: {
    activeTickets: [],
    pastTickets: [],
    pendingOrders: [],
    activeTab: 'active',
    isLoading: false,
    isAnonymous: false,
    detailTicket: null
  },

  onShow() {
    app.globalData.guestTopTab = 'wallet';
    app.getCloud((cloud) => {
      this.cloud = cloud;
      this.fetchTickets();
    });
  },

  fetchTickets: function() {
    this.setData({ isLoading: true });
    auth.getAuth((profile) => {
      if (!profile) {
        // Anonymous (logged out or no guest record): no tickets, show the
        // sign-in CTA instead of a false "No active tickets" empty state.
        this.setData({
          isAnonymous: true,
          activeTickets: [],
          pastTickets: [],
          pendingOrders: [],
          isLoading: false
        });
        return;
      }
      if (!this.cloud) return;

      const db = this.cloud.database();
      db.collection('registrations')
        .where({ _openid: profile._openid })
        .orderBy('createdAt', 'desc')
        // limit(1000): unbounded client .get() truncates to 20, so a guest with more
        // than 20 registrations silently lost their older tickets.
        .limit(1000)
        .get()
        .then(res => {
          const today = new Date().toISOString().split('T')[0];
          const active = [];
          const past = [];

          (res.data || []).forEach(ticket => {
            if (ticket.eventDate && ticket.eventDate < today) {
              past.push(ticket);
            } else {
              active.push(ticket);
            }
          });

          this.setData({
            isAnonymous: false,
            activeTickets: active,
            pastTickets: past,
            isLoading: false
          });
          this._enrichTickets(active);
          this.fetchPendingOrders();
        })
        .catch(err => {
          this.setData({ isLoading: false });
          console.error('Fetch tickets error:', err);
        });
    });
  },

  // Ticket detail line: the registration stores only the ticket NAME; what's
  // included (description) and the price live on the event's ticket/package
  // definition. One field-limited query for the active tickets' events, then
  // each card gets ticketName / ticketDesc / priceText. Failure is silent —
  // the cards just keep the base rows they already render.
  _enrichTickets: function(active) {
    if (!active.length || !this.cloud) return;
    const db = this.cloud.database();
    const ids = [];
    active.forEach(t => { if (t.eventId && ids.indexOf(t.eventId) === -1) ids.push(t.eventId); });
    if (!ids.length) return;

    const _ = db.command;
    db.collection('events')
      .where({ _id: _.in(ids) })
      .field({ title: true, venueName: true, tickets: true, paidPackages: true })
      .limit(ids.length)
      .get()
      .then(res => {
        const byEvent = {};
        (res.data || []).forEach(e => { byEvent[e._id] = e; });
        const patch = {};
        active.forEach((t, i) => {
          const ev = byEvent[t.eventId];
          if (!ev) return;
          let def = null;
          const pools = [].concat(ev.tickets || [], ev.paidPackages || []);
          if (t.ticketId) def = pools.find(p => p && p.id === t.ticketId) || null;
          // Ticket definition gone (edited away after purchase): fall back to
          // the name snapshot on the registration itself.
          const name = (def && def.name) || (t.ticketType && t.ticketType !== 'free' ? t.ticketType : 'Guest list');
          const desc = (def && def.description) ? String(def.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
          // The badge already says FREE — the price row only matters for paid.
          let priceText = '';
          if (t.paid) {
            priceText = '¥ ' + ((t.paidAmountFen || (def && def.price ? Math.round(def.price * 100) : 0)) / 100);
          } else {
            priceText = 'Free';
          }
          patch['activeTickets[' + i + '].ticketName'] = name;
          patch['activeTickets[' + i + '].ticketDesc'] = desc;
          patch['activeTickets[' + i + '].priceText'] = priceText;
          if (ev.venueName) patch['activeTickets[' + i + '].venueName'] = ev.venueName;
        });
        if (Object.keys(patch).length) this.setData(patch);
      })
      .catch(err => console.error('[mytickets] enrich failed:', err));
  },

  goSignIn: function() {
    wx.navigateTo({ url: '/pages/register/register' });
  },

  // Unpaid orders (10-minute server TTL; stale ones the server closes itself).
  // Every displayed pending order is also silently re-confirmed against
  // WeChat Pay: if the guest actually paid but the confirm chain died
  // earlier (app closed, network), the server issues the ticket right here
  // and the page refreshes — no lost paid tickets. _reconciling bounds the
  // fetch→confirm→fetch loop to one extra round.
  fetchPendingOrders: function() {
    callFunction('payments', { action: 'getMyOrders' })
      .then(res => {
        const pending = (res && res.success && res.data || []).filter(o => o.status === 'pending');
        this.setData({ pendingOrders: pending });
        if (pending.length === 0 || this._reconciling) return;
        this._reconciling = true;
        Promise.all(pending.map(o => pay.confirmOrder(o._id).catch(() => null)))
          .then(results => {
            this._reconciling = false;
            if (results.some(r => r && (r.status === 'paid' || r.status === 'closed'))) {
              this.fetchTickets();
            }
          })
          .catch(() => { this._reconciling = false; });
      })
      .catch(err => console.error('Fetch orders error:', err));
  },

  // Re-run the pay flow for a pending order. FIRST the server is asked for
  // the truth about the existing order — a guest who already paid (but whose
  // confirmation never landed) must never be charged again. Only a genuinely
  // unpaid order goes on to a fresh createOrder → requestPayment.
  completePayment: function(e) {
    const { eventId, ticketId, orderId } = e.currentTarget.dataset;
    if (!eventId || !ticketId) return;
    wx.showLoading({ title: 'Checking...', mask: true });
    (orderId ? pay.confirmOrder(orderId) : Promise.resolve({ status: 'pending' }))
      .then(chk => {
        if (chk && chk.status === 'paid') {
          wx.hideLoading();
          wx.showToast({ title: 'Already paid', icon: 'none' });
          this.fetchTickets();
          return;
        }
        return this._startPayment(eventId, ticketId);
      })
      .catch(() => {
        wx.hideLoading();
        wx.showToast({ title: 'Connection error', icon: 'none' });
      });
  },

  _startPayment: function(eventId, ticketId) {
    wx.showLoading({ title: 'Preparing...', mask: true });
    return pay.createOrder(eventId, ticketId)
      .then(res => {
        wx.hideLoading();
        if (res.status === 'paid') { this.fetchTickets(); return; }
        if (res.status === 'not_configured') {
          wx.showToast({ title: 'Payments coming soon', icon: 'none' });
          return;
        }
        if (res.status !== 'params') {
          wx.showToast({ title: res.message || 'Order failed', icon: 'none' });
          return;
        }
        pay.requestPayment(res.payment)
          .then(() => {
            wx.showLoading({ title: 'Confirming...', mask: true });
            return pay.confirmOrder(res.orderId).then(() => {
              wx.hideLoading();
              this.fetchTickets();
            });
          })
          .catch(() => {
            wx.hideLoading();
            wx.showToast({ title: 'Payment cancelled', icon: 'none' });
          });
      })
      .catch(() => {
        wx.hideLoading();
        wx.showToast({ title: 'Connection error', icon: 'none' });
      });
  },

  switchTab: function(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab });
  },

  goToEvent: function(e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/event-detail/event-detail?id=' + id });
  },

  // ─── Ticket detail popup ────────────────────────────────────────────────
  // Tap on an active ticket card opens a small window: date, venue, event
  // title, then the ticket block and a scan button. Tapping the backdrop
  // (mask) or Close dismisses it; tapping inside must not leak to the mask.
  openTicketDetail: function(e) {
    const i = e.currentTarget.dataset.index;
    const t = this.data.activeTickets[i];
    if (!t) return;
    this.setData({ detailTicket: t });
  },

  closeTicketDetail: function() {
    this.setData({ detailTicket: null });
  },

  // Scan straight from the popup: close the window first so the system
  // scanner face isn't stacked on top of the overlay, then run the same
  // proven wx.scanCode flow as the page-level button.
  scanFromDetail: function() {
    this.setData({ detailTicket: null });
    this.openScanner();
  },

  stopPropagation: function() {},

  // removeFromList was removed by design: tickets are never deleted from
  // the guest side anymore (no-refund policy; a free registration is
  // upgraded in place when a paid ticket is bought instead).

  // ─── Door check-in scan ─────────────────────────────────────────────────
  //
  // Scan → the server stamps the arrival mark (arrivedAt/checkedInAt) plus
  // scannedAt on the caller's own registration → a success toast, nothing in
  // between. The counter's tap stays available as the manual fallback.
  openScanner() {
    wx.scanCode({
      onlyFromCamera: true,
      success: (res) => this._confirmScan(res.result),
      fail: () => {} // user closed the camera — nothing to explain
    })
  },

  async _confirmScan(token) {
    wx.showLoading({ title: 'Checking...', mask: true })
    try {
      const res = await this.cloud.callFunction({
        name: 'clientAuth',
        data: { action: 'confirmArrival', token }
      })
      wx.hideLoading()
      const result = res.result || {}
      if (!result.success) throw new Error(result.message || 'Failed')
      if (result.invalid) {
        const messages = {
          expired: 'The code has rotated. Please scan the new one.',
          not_registered: 'You are not on the guest list of this event.'
        }
        wx.showModal({
          title: 'Cannot check in',
          content: messages[result.reason] || 'This is not a valid check-in code.',
          showCancel: false
        })
        return
      }
      // Repeat scan (or the counter already marked this guest) — the server
      // refuses nothing, it just reports the repeat.
      if (result.already) {
        wx.vibrateShort({ type: 'light' })
        wx.showToast({ title: "You're already checked in", icon: 'none', duration: 2500 })
        return
      }
      wx.vibrateShort({ type: 'medium' })
      wx.showToast({ title: "You're checked in", icon: 'success', duration: 2500 })
    } catch (err) {
      wx.hideLoading()
      console.error('[scan] confirm failed:', err)
      wx.showToast({ title: 'Connection error', icon: 'none' })
    }
  },

  onPullDownRefresh: function() {
    this.fetchTickets();
    wx.stopPullDownRefresh();
  }
});
const app = getApp();
const auth = require('../../utils/auth.js');
const { callFunction } = require('../../utils/cloud.js');
const pay = require('../../utils/pay.js');
const tabDots = require('../../utils/tab-dots.js');

function ticketEndTime(ticket, event) {
  const date = (event && event.date) || ticket.eventDate;
  const explicitEnd = (event && event.endDate) || ticket.eventEndDate;
  const parts = String(explicitEnd || date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return null;
  const end = String((event && event.endTime) || ticket.eventEndTime || '').match(/^(\d{1,2}):(\d{2})$/);
  const start = String((event && event.startTime) || ticket.eventStartTime || '').match(/^(\d{1,2}):(\d{2})$/);
  const day = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  if (!end || Number(end[1]) > 23 || Number(end[2]) > 59) {
    // Legacy snapshots without an end time remain valid until local midnight.
    day.setDate(day.getDate() + 1);
    return day.getTime();
  }
  day.setHours(Number(end[1]), Number(end[2]), 0, 0);
  // A 22:00–04:00 event ends the following morning, not at its start date's midnight.
  if (!explicitEnd && start && Number(end[1]) * 60 + Number(end[2]) <= Number(start[1]) * 60 + Number(start[2])) {
    day.setDate(day.getDate() + 1);
  }
  return day.getTime();
}

Page({
  data: {
    activeTickets: [],
    pastTickets: [],
    visibleTickets: [],
    activeTab: 'active',
    isLoading: false,
    isAnonymous: false,
    detailTicket: null
  },

  onShow() {
    this._walletVisible = true;
    app.globalData.guestTopTab = 'wallet';
    app.getCloud((cloud) => {
      if (!this._walletVisible) return;
      this.cloud = cloud;
      this.fetchTickets();
    });
  },

  onHide() {
    this._walletVisible = false;
    this._ticketRequestId = (this._ticketRequestId || 0) + 1;
    clearTimeout(this._expiryTimer);
  },

  onUnload() {
    this.onHide();
  },

  fetchTickets: function() {
    const requestId = this._ticketRequestId = (this._ticketRequestId || 0) + 1;
    this.setData({ isLoading: true, detailTicket: null });
    auth.getAuth(async (profile) => {
      if (requestId !== this._ticketRequestId) return;
      if (!profile) {
        this._walletTickets = [];
        this._walletOwner = null;
        clearTimeout(this._expiryTimer);
        this.setData({
          isAnonymous: true,
          activeTickets: [],
          pastTickets: [],
          visibleTickets: [],
          isLoading: false
        });
        tabDots.updateWalletDot(false);
        return;
      }
      if (this._walletOwner !== profile._openid) {
        this._walletOwner = profile._openid;
        this._walletTickets = [];
        this.setData({ activeTickets: [], pastTickets: [], visibleTickets: [] });
      }
      if (!this.cloud) {
        this.setData({ isLoading: false });
        return;
      }
      try {
        await this._loadIssuedTickets(profile, requestId);
        if (requestId !== this._ticketRequestId) return;
        // Recover server-confirmed purchases silently, never render orders as tickets.
        const refreshed = await this._reconcilePaidOrders(requestId);
        if (refreshed && requestId === this._ticketRequestId) {
          await this._loadIssuedTickets(profile, requestId);
        }
      } catch (err) {
        if (requestId === this._ticketRequestId) this.setData({ isLoading: false });
        console.error('[mytickets] fetch failed:', err);
      }
    });
  },

  _loadIssuedTickets: async function(profile, requestId) {
    const db = this.cloud.database();
    const res = await db.collection('registrations')
      .where({ _openid: profile._openid })
      .orderBy('createdAt', 'desc')
      .limit(1000)
      .get();
    if (requestId !== this._ticketRequestId) return;
    const issued = (res.data || []).filter(ticket => ticket.paid === true && ticket.eventId &&
      ticket.refunded !== true && !['pending', 'refunded', 'cancelled'].includes(ticket.status) &&
      !['pending', 'refunded', 'cancelled'].includes(ticket.paymentStatus));
    const byEvent = await this._loadTicketEvents(issued);
    if (requestId !== this._ticketRequestId) return;
    this._walletTickets = issued.map(ticket => {
      const event = byEvent[ticket.eventId];
      const pools = event ? [].concat(event.tickets || [], event.paidPackages || []) : [];
      const definition = pools.find(item => item && item.id === ticket.ticketId);
      const snapshot = ticket.paidAmountFen != null ? ticket.paidAmountFen : ticket.amountFen;
      const amount = snapshot != null && snapshot !== '' ? Number(snapshot) : NaN;
      const description = ticket.ticketDesc || ticket.ticketDescription || (definition && definition.description) || '';
      return Object.assign({}, ticket, {
        eventTitle: (event && event.title) || ticket.eventTitle || 'Event',
        eventDate: (event && event.date) || ticket.eventDate || '',
        venueName: (event && event.venueName) || ticket.venueName || '',
        ticketName: (ticket.ticketType && ticket.ticketType !== 'free' ? ticket.ticketType : '') ||
          ticket.ticketName || (definition && definition.name) || 'Ticket',
        ticketDesc: String(description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        priceText: Number.isFinite(amount) && amount >= 0 ? '¥ ' + (amount / 100).toFixed(2) : 'Paid',
        _eventEndAt: ticketEndTime(ticket, event),
        _eventMissing: Object.prototype.hasOwnProperty.call(byEvent, ticket.eventId) && !event
      });
    });
    this.setData({ isAnonymous: false, isLoading: false });
    this._applyTicketLists();
  },

  _loadTicketEvents: async function(tickets) {
    const db = this.cloud.database();
    const ids = [];
    tickets.forEach(ticket => { if (ids.indexOf(ticket.eventId) === -1) ids.push(ticket.eventId); });
    const byEvent = {};
    for (let offset = 0; offset < ids.length; offset += 20) {
      const batch = ids.slice(offset, offset + 20);
      try {
        const res = await db.collection('events')
          .where({ _id: db.command.in(batch) })
          .field({ title: true, venueName: true, date: true, startTime: true, endTime: true,
            endDate: true, tickets: true, paidPackages: true })
          .limit(batch.length)
          .get();
        batch.forEach(id => { byEvent[id] = null; });
        (res.data || []).forEach(event => { byEvent[event._id] = event; });
      } catch (err) {
        // A temporary lookup failure must not masquerade as a deleted event.
        console.error('[mytickets] event lookup failed:', err);
      }
    }
    return byEvent;
  },

  _applyTicketLists: function() {
    const now = Date.now();
    const active = [];
    const past = [];
    (this._walletTickets || []).forEach(ticket => {
      const row = Object.assign({}, ticket, {
        isPast: ticket._eventMissing || (ticket._eventEndAt != null && now >= ticket._eventEndAt)
      });
      (row.isPast ? past : active).push(row);
    });
    const opened = this.data.detailTicket;
    const detail = opened ? active.concat(past).find(ticket => ticket._id === opened._id) || null : null;
    this.setData({
      activeTickets: active,
      pastTickets: past,
      visibleTickets: this.data.activeTab === 'past' ? past : active,
      detailTicket: detail
    });
    tabDots.updateWalletDot(active.length > 0);
    clearTimeout(this._expiryTimer);
    if (!this._walletVisible) return;
    const endings = active.map(ticket => ticket._eventEndAt).filter(time => time != null && time > now);
    if (endings.length) {
      this._expiryTimer = setTimeout(() => this._applyTicketLists(),
        Math.min(60000, Math.max(1, Math.min.apply(null, endings) - now + 10)));
    }
  },

  _reconcilePaidOrders: async function(requestId) {
    try {
      const res = await callFunction('payments', { action: 'getMyOrders' });
      if (!res || !res.success || requestId !== this._ticketRequestId) return false;
      const unsettled = (res.data || []).filter(order => order._id && order.status === 'pending');
      // These are internal transaction states, never a Wallet section or a Pay CTA.
      // Confirmation only queries the provider; it cannot initiate another charge.
      for (let offset = 0; offset < unsettled.length; offset += 4) {
        if (requestId !== this._ticketRequestId) return false;
        await Promise.all(unsettled.slice(offset, offset + 4)
          .map(order => pay.confirmOrder(order._id, 0).catch(() => null)));
      }
      // getMyOrders can repair an already-paid registration without any pending
      // orders. Re-read issued tickets after that repair as well.
      return true;
    } catch (err) {
      console.error('[mytickets] payment reconciliation failed:', err);
      return false;
    }
  },

  goSignIn: function() {
    wx.navigateTo({ url: '/pages/register/register' });
  },

  goToFeed: function() {
    app.globalData.guestTopTab = 'feed';
    wx.switchTab({ url: '/pages/feed/feed' });
  },

  switchTab: function(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab !== 'active' && tab !== 'past') return;
    this.setData({ activeTab: tab, detailTicket: null });
    this._applyTicketLists();
  },

  goToEvent: function(e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/event-detail/event-detail?id=' + id });
  },

  // ─── Ticket detail popup ────────────────────────────────────────────────
  // Either tab uses the same ticket card and detail window: date, venue, event
  // title, then the ticket block and a scan button. Tapping the backdrop
  // (mask) or Close dismisses it; tapping inside must not leak to the mask.
  openTicketDetail: function(e) {
    const i = e.currentTarget.dataset.index;
    const t = this.data.visibleTickets[i];
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
    const ticket = this.data.detailTicket;
    if (!ticket) return;
    if (ticket.isPast || (ticket._eventEndAt != null && Date.now() >= ticket._eventEndAt)) {
      this._applyTicketLists();
      wx.showToast({ title: 'This event has ended', icon: 'none' });
      return;
    }
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
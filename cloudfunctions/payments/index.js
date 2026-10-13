const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const crypto = require('crypto');
const https = require('https');
const { loadPaymentConfig, isPaymentConfigured } = require('./paymentConfig');

// ─── WeChat Pay v3 gateway (direct API) ─────────────────────────────────────
// Credentials live in this function's env vars (DevTools cloud console):
// WXPAY_APPID, WXPAY_MCHID, WXPAY_SERIAL, WXPAY_PRIVATE_KEY (full PEM;
// "\n" escapes are normalized), and WXPAY_NOTIFY_URL. Order confirmation still
// queries WeChat Pay as a recovery path, but order creation is refused unless a
// real HTTPS notification endpoint is configured.
const WXPAY_HOST = 'api.mch.weixin.qq.com';

function wxpayConfig() {
  return loadPaymentConfig(process.env);
}

function buildAuthHeader(method, urlPath, bodyStr, cfg) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const signStr = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${bodyStr}\n`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signStr)
    .sign(cfg.privateKey, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchid}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${cfg.serial}"`;
}

function wxpayRequest(method, urlPath, bodyObj) {
  const cfg = wxpayConfig();
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'yue-payments/1.0',
      Authorization: buildAuthHeader(method, urlPath, bodyStr, cfg)
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(
      { hostname: WXPAY_HOST, path: urlPath, method, headers, timeout: 10000 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (e) { /* non-JSON body */ }
          resolve({ status: res.statusCode, data: parsed || data });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('WeChat Pay API timeout')));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// WeChat Pay rejects the whole request with 请求内容传入了非UTF8参数 when the
// description carries characters its gateway can't digest (the middle dot,
// emoji, fancy punctuation). Keep only letters/digits/basic punctuation
// and collapse everything else to spaces, then trim.
function safeDescription(order) {
  const raw = (order.eventTitle || 'Ticket') + ' - ' + (order.ticketName || '');
  const cleaned = raw.replace(/[^\p{L}\p{N}\s\-()]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/\s*-\s*$/, '');
  return (cleaned || 'Ticket').slice(0, 120);
}

const GATEWAY = {
  get configured() {
    return isPaymentConfigured(process.env);
  },
  // order → { params: { timeStamp, nonceStr, package, signType, paySign } }
  // or { error } — the caller treats a missing .params as GATEWAY_ERROR.
  async createPayment(order) {
    const cfg = wxpayConfig();
    const description = safeDescription(order);
    const res = await wxpayRequest('POST', '/v3/pay/transactions/jsapi', {
      appid: cfg.appid,             // pairs with payer.openid — both are guest-app values
      mchid: cfg.mchid,
      description,
      out_trade_no: order.outTradeNo,
      notify_url: cfg.notifyUrl,
      amount: { total: order.amountFen, currency: 'CNY' },
      payer: { openid: order.openid }
    });
    if (res.status !== 200 || !res.data || !res.data.prepay_id) {
      console.error('[payments] jsapi order failed:', res.status,
        typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 500) : String(res.data).slice(0, 200));
      return { error: (res.data && res.data.message) || ('HTTP ' + res.status) };
    }
    const prepayId = res.data.prepay_id;
    const timeStamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const packageStr = `prepay_id=${prepayId}`;
    const paySign = crypto
      .createSign('RSA-SHA256')
      .update(`${cfg.appid}\n${timeStamp}\n${nonceStr}\n${packageStr}\n`)
      .sign(cfg.privateKey, 'base64');
    return { params: { timeStamp, nonceStr, package: packageStr, signType: 'RSA', paySign } };
  },
  // order → { tradeState: 'SUCCESS' | 'NOTPAY' | 'CLOSED' | ... } (+ transactionId)
  async queryOrder(order) {
    const cfg = wxpayConfig();
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(order.outTradeNo)}?mchid=${cfg.mchid}`;
    const res = await wxpayRequest('GET', path, null);
    if (res.status === 404) return { tradeState: 'NOTPAY' }; // never created / expired on WeChat side
    if (res.status !== 200 || !res.data || !res.data.trade_state) {
      console.error('[payments] query failed:', res.status,
        typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 500) : String(res.data).slice(0, 200));
      return { tradeState: 'UNKNOWN' };
    }
    return { tradeState: res.data.trade_state, transactionId: res.data.transaction_id || '' };
  },
  // Best-effort close on WeChat's side (order expired unpaid).
  async closeOrder(order) {
    const cfg = wxpayConfig();
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(order.outTradeNo)}/close`;
    const res = await wxpayRequest('POST', path, { mchid: cfg.mchid });
    return res.status === 204 || res.status === 200;
  }
};

// WeChat caps out_trade_no at 32 chars — our deterministic orderId
// (eventId_openid) is far longer, so each WeChat order gets a short unique
// trade number stored on the order doc.
function newOutTradeNo() {
  return 'y' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Unpaid orders die after 10 minutes (platform convention — the integration
// guide closes orders at the 10-minute mark).
const ORDER_TTL_MS = 10 * 60 * 1000;

// The orders collection may not exist yet on first call — createCollection is
// idempotent enough for our purposes (a race just yields a caught error).
async function ensureOrdersCollection() {
  try { await db.createCollection('orders'); } catch (e) { /* already exists */ }
}

// A ticket/package definition on the event doc. paidPackages items got stable
// ids from the admin editor (see event-edit.js onSave); event.tickets items
// have carried ids all along. Both lists are searched so either shape works.
function findTicket(eventDoc, ticketId) {
  if (!ticketId || !eventDoc) return null;
  const tickets = Array.isArray(eventDoc.tickets) ? eventDoc.tickets : [];
  const hit = tickets.find(t => t && t.id === ticketId);
  if (hit) return { kind: 'ticket', ticket: hit };
  const pkgs = Array.isArray(eventDoc.paidPackages) ? eventDoc.paidPackages : [];
  const pkg = pkgs.find(p => p && p.id === ticketId);
  if (pkg) return { kind: 'package', ticket: pkg };
  return null;
}

// Issues the registration for a paid order. The deterministic _id is the SAME
// one the free flow writes client-side (eventId_openid), so a callback and a
// client confirm racing each other collapse into one registration. The
// existing doc is read FIRST and written add-or-update accordingly — no
// error-string sniffing: the old add-then-catch-duplicate path silently lost
// paid tickets when the duplicate error text didn't match the pattern.
// Free → paid upgrades in place; already-paid is an idempotent no-op.
async function issuePaidRegistration(order) {
  const regId = order.eventId + '_' + order.openid;
  const paidPatch = {
    ticketId: order.ticketId || '',
    ticketType: order.ticketName || '',
    status: 'confirmed',
    paid: true,
    orderId: order._id,
    paidAmountFen: order.amountFen || 0,
    upgradedAt: db.serverDate()
  };
  try {
    const existingRes = await db.collection('registrations').doc(regId).get().catch(() => null);
    const existing = existingRes && existingRes.data;
    if (existing) {
      if (existing.paid) return false; // idempotent: nothing to change
      await db.collection('registrations').doc(regId).update({ data: paidPatch });
      return true; // free → paid upgrade: counter unchanged
    }
    await db.collection('registrations').add({
      data: {
        _id: regId,
        eventId: order.eventId,
        eventTitle: order.eventTitle || '',
        eventDate: order.eventDate || '',
        guestName: order.guestName || '',
        guestAvatar: order.guestAvatar || '',
        guestPhone: order.guestPhone || '',
        promoCode: order.promoCode || '',
        promoterId: order.promoterId || '',
        promoterName: order.promoterName || '',
        ticketType: order.ticketName || '',
        status: 'confirmed',
        paid: true,
        orderId: order._id,
        paidAmountFen: order.amountFen || 0,
        createdAt: db.serverDate()
      }
    });
    // New registration → bump the event's stored guest counter (the read side
    // is attachGuestCounts in manageApplications).
    await db.collection('events').doc(order.eventId).update({
      data: { guestCount: db.command.inc(1), guestCountSyncedAt: db.serverDate() }
    }).catch(() => {});
    return true;
  } catch (err) {
    console.error('[payments] issue registration failed:', err && (err.errMsg || err.message));
    return false;
  }
}

// Self-heal for the lost-ticket bug: paid orders whose registration never got
// the paid flag (issued before the fix above). Runs on the caller's own
// orders whenever they touch payments (createOrder / getMyOrders) — the
// first app open after the fix re-issues every lost ticket silently.
async function healPaidOrders(openid) {
  try {
    const res = await db.collection('orders')
      .where({ _openid: openid, status: 'paid' })
      .limit(20)
      .get();
    for (const order of (res.data || [])) {
      const regRes = await db.collection('registrations')
        .doc(order.eventId + '_' + order.openid)
        .get().catch(() => null);
      const reg = regRes && regRes.data;
      if (reg && reg.paid) continue;
      const issued = await issuePaidRegistration(order);
      if (issued) console.log('[payments] healed paid order:', order._id);
    }
  } catch (e) { /* non-fatal */ }
}

async function markOrderPaid(order, transactionId) {
  const patch = { status: 'paid', updatedAt: db.serverDate() };
  if (transactionId) patch.transactionId = transactionId;
  patch.paidAtMs = Date.now();
  await db.collection('orders').doc(order._id).update({ data: patch });
  const issued = await issuePaidRegistration({ ...order, status: 'paid' });
  return issued;
}

// Lazy expiry: any of the caller's pending orders past its TTL is resolved
// before the caller sees or creates anything. Without a payment callback the
// local "pending" status is NOT authoritative — every expiry first asks
// WeChat Pay for the real state: SUCCESS pays out the ticket right here,
// terminal failures close, still-unpaid orders are closed on WeChat's side
// too, and mid-payment (USERPAYING) / unknown states stay pending for the
// next touch. Without gateway credentials nothing is closed on guesswork.
async function closeStalePendingOrders(openid) {
  try {
    const res = await db.collection('orders')
      .where({ _openid: openid, status: 'pending', expireAtMs: db.command.lt(Date.now()) })
      .limit(10)
      .get();
    for (const order of (res.data || [])) {
      if (!order.outTradeNo || !GATEWAY.configured) continue;
      const gw = await GATEWAY.queryOrder(order).catch(() => null);
      if (!gw || gw.tradeState === 'UNKNOWN' || gw.tradeState === 'USERPAYING') continue;
      if (gw.tradeState === 'SUCCESS') {
        await markOrderPaid(order, gw.transactionId || '').catch((e) =>
          console.error('[payments] late markPaid failed:', e && e.message));
      } else {
        if (gw.tradeState === 'NOTPAY') {
          await GATEWAY.closeOrder(order).catch(() => { /* best effort */ });
        }
        await db.collection('orders').doc(order._id).update({
          data: { status: 'closed', updatedAt: db.serverDate() }
        }).catch(() => {});
      }
    }
  } catch (e) { /* non-fatal */ }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  // Cross-appid pattern shared with clientAuth: calls from the guest app
  // carry the real caller in FROM_OPENID; OPENID covers same-appid callers.
  const openid = wxContext.FROM_OPENID || wxContext.OPENID;
  const { action } = event;

  try {
    if (!openid) return { success: false, message: 'No caller identity' };
    await ensureOrdersCollection();

    // CREATE (or re-open) AN ORDER — guest-facing.
    // The amount is computed ONLY from the server-side event doc; the client
    // never sends a price. One active order per (event, guest): _id is
    // deterministic, re-invoking with the same ticket reuses the pending
    // order, with a different ticket (or a stale one) closes the old first.
    if (action === 'createOrder') {
      const { eventId, ticketId } = event;
      if (!eventId || !ticketId) return { success: false, message: 'Missing eventId or ticketId' };

      await closeStalePendingOrders(openid);
      await healPaidOrders(openid);

      // Already registered? A PAID registration means there is nothing left
      // to sell. A FREE one is upgradable: the guest may buy a paid ticket
      // (selection below must then be a priced one — a free re-pick just
      // re-confirms their existing ticket).
      const regDoc = await db.collection('registrations').doc(eventId + '_' + openid).get().catch(() => null);
      const regData = regDoc && regDoc.data;
      const hasFreeReg = !!(regData && !regData.paid);
      if (regData && regData.paid) {
        return { success: true, code: 'ALREADY_REGISTERED' };
      }

      const eventRes = await db.collection('events').doc(eventId).get().catch(() => null);
      const eventDoc = eventRes && eventRes.data;
      if (!eventDoc) return { success: false, message: 'Event not found' };

      // No sales for ended/closed events — the guest UI blocks the sheet,
      // this is the enforcement behind it (night rule: an endTime before
      // noon belongs to the next morning).
      const evEnded = () => {
        if (eventDoc.isClosed) return true;
        if (!eventDoc.date || !eventDoc.endTime) return false;
        try {
          const [y, m, d] = String(eventDoc.date).split('-').map(Number);
          const [h, min] = String(eventDoc.endTime).split(':').map(Number);
          const dt = new Date(y, m - 1, d, h, min || 0, 0, 0);
          if (h < 12) dt.setDate(dt.getDate() + 1);
          return !isNaN(dt.getTime()) && Date.now() > dt.getTime();
        } catch (e) { return false; }
      };
      if (evEnded()) {
        return { success: false, code: 'EVENT_OVER', message: 'This event is already over' };
      }

      const found = findTicket(eventDoc, ticketId);
      if (!found) return { success: false, message: 'Ticket not found' };
      const priceYuan = Number(found.ticket.price) || 0;
      if (priceYuan <= 0) {
        // Free selection is only meaningful once; an existing free
        // registration makes this a no-op success for the client.
        return hasFreeReg
          ? { success: true, code: 'ALREADY_REGISTERED' }
          : { success: false, message: 'This ticket is not for sale' };
      }
      const amountFen = Math.round(priceYuan * 100);

      // Per-ticket sales cap (Quantity in the admin editor): issued paid
      // registrations count against it — upgrades included, they hold the
      // same ticket. 0/absent = unlimited.
      const quantity = Number(found.ticket.quantity) || 0;
      if (quantity > 0) {
        const soldRes = await db.collection('registrations')
          .where({ eventId, ticketId, paid: true }).count();
        if ((soldRes.total || 0) >= quantity) {
          return { success: false, code: 'TICKET_SOLD_OUT', message: 'This ticket is sold out' };
        }
      }

      const guestRes = await db.collection('guests').where({ _openid: openid }).limit(1).get();
      const guest = (guestRes.data && guestRes.data[0]) || {};

      const orderId = eventId + '_' + openid;
      const now = Date.now();
      const existing = await db.collection('orders').doc(orderId).get().catch(() => null);
      const existingDoc = existing && existing.data;

      if (existingDoc && existingDoc.status === 'paid') {
        return { success: true, code: 'ALREADY_REGISTERED' };
      }

      // No credentials yet → no orders either: a pending order that can never
      // be paid would sit in the guest's My Tickets forever. Checked before
      // the upsert below (once configured, persist-then-createPayment stays
      // the order: a pending order without params is recoverable by a retry).
      if (!GATEWAY.configured) {
        return { success: false, code: 'PAYMENTS_NOT_CONFIGURED', message: 'Payments are not configured yet' };
      }

      const orderData = {
        openid,
        eventId,
        eventTitle: eventDoc.title || '',
        eventDate: eventDoc.date || '',
        ticketId,
        ticketKind: found.kind,
        ticketName: found.ticket.name || '',
        amountFen,
        guestName: guest.nickName || guest.name || '',
        guestAvatar: guest.avatarUrl || '',
        guestPhone: guest.phone || '',
        promoCode: guest.promoCode || '',
        promoterId: guest.promoterId || '',
        promoterName: guest.promoterName || '',
        status: 'pending',
        outTradeNo: newOutTradeNo(),
        expireAtMs: now + ORDER_TTL_MS,
        transactionId: '',
        createdAt: existingDoc ? existingDoc.createdAt : db.serverDate(),
        updatedAt: db.serverDate()
      };

      // Persist first, then ask the gateway — a pending order without params
      // is recoverable by a retry; params without an order are not.
      if (existingDoc) {
        await db.collection('orders').doc(orderId).update({ data: orderData });
      } else {
        await db.collection('orders').add({ data: { _id: orderId, ...orderData } });
      }

      const pay = await GATEWAY.createPayment({ ...orderData, _id: orderId });
      if (!pay || !pay.params) {
        return {
          success: false,
          code: 'GATEWAY_ERROR',
          message: pay && pay.error ? String(pay.error).slice(0, 200) : 'Payment could not be created'
        };
      }
      return { success: true, orderId, amountFen, payment: pay.params };
    }

    // CONFIRM AN ORDER — guest-facing, called right after wx.requestPayment
    // reports success. The client's word is NOT enough: this action asks the
    // gateway for the authoritative state and only then issues the ticket.
    // (The payment callback remains the second, independent path — see
    // handlePaidCallback.)
    if (action === 'confirmOrder') {
      const orderId = event.orderId || (event.eventId ? event.eventId + '_' + openid : '');
      if (!orderId) return { success: false, message: 'Missing orderId' };

      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => null);
      const order = orderRes && orderRes.data;
      if (!order || order.openid !== openid) {
        return { success: false, message: 'Order not found' };
      }
      if (order.status === 'paid') {
        return { success: true, status: 'paid' };
      }
      if (order.status !== 'pending') {
        return { success: true, status: order.status };
      }
      if (!GATEWAY.configured) {
        return { success: false, code: 'PAYMENTS_NOT_CONFIGURED', message: 'Payments are not configured yet' };
      }
      // A pending order without a WeChat trade number predates the gateway —
      // nothing to query, nothing that can ever be paid.
      if (!order.outTradeNo) {
        await db.collection('orders').doc(orderId).update({
          data: { status: 'closed', updatedAt: db.serverDate() }
        });
        return { success: true, status: 'closed' };
      }

      const gw = await GATEWAY.queryOrder(order);
      const tradeState = gw && gw.tradeState;
      if (tradeState === 'SUCCESS') {
        const issued = await markOrderPaid(order, gw.transactionId || '');
        return { success: true, status: 'paid', registrationIssued: issued };
      }
      if (tradeState === 'CLOSED' || tradeState === 'REVOKED' || tradeState === 'PAYERROR') {
        await db.collection('orders').doc(orderId).update({
          data: { status: 'closed', updatedAt: db.serverDate() }
        });
        return { success: true, status: 'closed' };
      }
      // NOTPAY / USERPAYING (mid-payment) / UNKNOWN (query hiccup) — the
      // caller may poll again.
      return { success: true, status: 'pending' };
    }

    // MY ORDERS — guest-facing. Pending orders feed the "complete payment"
    // strip in My Tickets; everything else is history (no refunds by design).
    if (action === 'getMyOrders') {
      await closeStalePendingOrders(openid);
      await healPaidOrders(openid);
      const res = await db.collection('orders')
        .where({ _openid: openid })
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();
      const SAFE = ['_id', 'eventId', 'eventTitle', 'eventDate', 'ticketId', 'ticketName',
        'amountFen', 'status', 'expireAtMs', 'createdAt']; // no outTradeNo — internal
      const data = (res.data || []).map(o => {
        const safe = {};
        SAFE.forEach(k => { if (o[k] !== undefined) safe[k] = o[k]; });
        return safe;
      });
      return { success: true, data };
    }

    // PAYMENT CALLBACK — called by the Integration Center's generated
    // function (its orderService handler), not by clients. Guarded by a
    // shared secret in the PAY_CALLBACK_SECRET env var of THIS function; it
    // is set together with the gateway config in console step 3. Idempotent:
    // a WeChat retry for an already-paid order is a no-op success.
    if (action === 'handlePaidCallback') {
      const cfg = wxpayConfig();
      if (event.secret !== cfg.callbackSecret) {
        return { success: false, message: 'Unauthorized callback' };
      }
      const outTradeNo = event.outTradeNo;
      if (!outTradeNo) return { success: false, message: 'Missing outTradeNo' };

      const orderRes = await db.collection('orders')
        .where({ outTradeNo })
        .limit(1)
        .get()
        .catch(() => null);
      const order = orderRes && orderRes.data && orderRes.data[0];
      if (!order) return { success: false, message: 'Order not found' };
      if (order.status === 'paid') return { success: true, status: 'paid' };

      await markOrderPaid(order, event.transactionId || '');
      return { success: true, status: 'paid' };
    }

    // GATEWAY STATUS — diagnostics. Never returns secret values, only which
    // env vars the function actually sees (values may need a cold start or a
    // redeploy to appear).
    if (action === 'gatewayStatus') {
      const c = wxpayConfig();
      return {
        success: true,
        configured: GATEWAY.configured,
        mchid: c.mchid || 'missing',
        serialSet: !!c.serial,
        keySet: c.privateKey.includes('BEGIN PRIVATE KEY')
      };
    }

    return { success: false, message: 'Unknown action' };
  } catch (err) {
    console.error('[payments] error:', err);
    return { success: false, message: err.message || String(err) };
  }
};

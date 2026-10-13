// Paid-ticket flow, shared by event-detail and mytickets.
//
// All server contact goes through the `payments` cloud function (same
// cross-appid callFunction channel as every other guest call). The function
// owns the order lifecycle; this module only:
//   1. createOrder  — asks the server for wx.requestPayment params
//   2. requestPayment — the one WeChat-native step
//   3. confirmOrder — server asks WeChat for the authoritative state and
//      issues the ticket (the client's "success" alone proves nothing).
//
// Until the merchant gateway is configured the server returns
// PAYMENTS_NOT_CONFIGURED and every entry point degrades to a clear toast —
// free registrations are completely unaffected.
const { callFunction } = require('./cloud');

// Resolves to:
//   { status: 'params', orderId, amountFen, payment } — ready for wx.requestPayment
//   { status: 'paid' }      — already registered/paid, nothing to do
//   { status: 'not_configured' } | { status: 'error', message }
async function createOrder(eventId, ticketId) {
  let res
  try {
    res = await callFunction('payments', { action: 'createOrder', eventId, ticketId })
  } catch (err) {
    console.error('[pay] createOrder error:', err)
    return { status: 'error', message: 'Connection error' }
  }
  if (!res) return { status: 'error', message: 'No response' }
  if (res.code === 'ALREADY_REGISTERED') return { status: 'paid' }
  if (res.code === 'PAYMENTS_NOT_CONFIGURED') return { status: 'not_configured' }
  if (!res.success) return { status: 'error', message: res.message || 'Order failed' }
  return { status: 'params', orderId: res.orderId, amountFen: res.amountFen, payment: res.payment }
}

// Wraps wx.requestPayment in a promise — resolves on the password-confirmed
// success, rejects on cancel/failure (the pending order stays retryable).
function requestPayment(payment) {
  return new Promise((resolve, reject) => {
    wx.requestPayment({
      timeStamp: payment.timeStamp,
      nonceStr: payment.nonceStr,
      package: payment.package,
      signType: payment.signType || 'RSA',
      paySign: payment.paySign,
      success: resolve,
      fail: reject
    })
  })
}

// Polls confirmOrder a few times (payment → WeChat's record being queryable
// can lag a beat). Resolves { status: 'paid' } | { status: 'pending' } | error.
async function confirmOrder(orderId, attempts) {
  const tries = attempts == null ? 3 : attempts
  for (let i = 0; i <= tries; i++) {
    let res
    try {
      res = await callFunction('payments', { action: 'confirmOrder', orderId })
    } catch (err) {
      console.error('[pay] confirmOrder error:', err)
    }
    if (res && res.success && res.status === 'paid') return { status: 'paid' }
    if (res && res.success && res.status === 'closed') return { status: 'closed' }
    if (i < tries) await new Promise(r => setTimeout(r, 1500))
  }
  return { status: 'pending' }
}

module.exports = { createOrder, requestPayment, confirmOrder }

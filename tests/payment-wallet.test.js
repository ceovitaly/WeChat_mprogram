'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const paymentFile = process.env.PAYMENTS_TEST_SOURCE || path.join(__dirname, '../cloudfunctions/payments/index.js')
const source = fs.readFileSync(paymentFile, 'utf8')
const owner = 'fixture-guest'
const eventId = 'fixture-event'
const registrationId = `${eventId}_${owner}`

function fixtureOrder(patch = {}) {
  return {
    _id: registrationId,
    openid: owner,
    eventId,
    eventTitle: 'Fixture event',
    eventDate: '2099-01-01',
    ticketId: 'fixture-ticket',
    ticketName: 'Fixture admission',
    amountFen: 100,
    status: 'pending',
    outTradeNo: 'fixture-trade',
    expireAtMs: Number.MAX_SAFE_INTEGER,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...patch
  }
}

function harness(options = {}) {
  const tables = {
    orders: (options.orders || [fixtureOrder()]).map(x => ({ ...x })),
    registrations: (options.registrations || []).map(x => ({ ...x })),
    events: [{ _id: eventId, guestCount: 0, ...(options.event || {}) }],
    guests: []
  }
  const calls = { gatewayQueries: 0, paymentRequests: 0 }
  const apply = (row, data) => {
    for (const [key, value] of Object.entries(data)) {
      row[key] = value && value.fixtureIncrement !== undefined
        ? (row[key] || 0) + value.fixtureIncrement
        : value
    }
  }
  const matches = (row, query) => Object.entries(query).every(([key, value]) =>
    value && value.fixtureLessThan !== undefined ? row[key] < value.fixtureLessThan : row[key] === value)
  const db = {
    command: { inc: n => ({ fixtureIncrement: n }), lt: n => ({ fixtureLessThan: n }) },
    serverDate: () => new Date('2026-01-01T00:00:00Z'),
    createCollection: async () => {},
    collection(name) {
      const records = tables[name] || []
      return {
        doc(id) {
          return {
            get: async () => ({ data: records.find(x => x._id === id) || null }),
            update: async ({ data }) => {
              if (name === 'registrations' && options.failRegistrationWrites) throw new Error('Fixture registration write failed')
              const row = records.find(x => x._id === id)
              if (!row) throw new Error('Fixture document missing')
              apply(row, data)
              return { stats: { updated: 1 } }
            }
          }
        },
        add: async ({ data }) => {
          if (name === 'registrations' && options.failRegistrationWrites) throw new Error('Fixture registration write failed')
          if (records.some(x => x._id === data._id)) throw new Error('Fixture duplicate document')
          // Server-side inserts intentionally do not auto-inject _openid.
          records.push({ ...data })
          return { _id: data._id }
        },
        where(query) {
          let limit = Infinity
          let sort
          const chain = {
            limit(n) { limit = n; return chain },
            orderBy(key, direction) { sort = { key, direction }; return chain },
            count: async () => ({ total: records.filter(row => matches(row, query)).length }),
            get: async () => {
              const found = records.filter(row => matches(row, query))
              if (sort) found.sort((a,b) => (a[sort.key] > b[sort.key] ? 1 : a[sort.key] < b[sort.key] ? -1 : 0) * (sort.direction === 'desc' ? -1 : 1))
              return { data: found.slice(0, limit) }
            }
          }
          return chain
        }
      }
    }
  }
  const sandbox = {
    exports: {},
    console: { log() {}, error() {} },
    process: { env: {} },
    gateway: {
      async queryOrder() { calls.gatewayQueries++; return options.gatewayResult || { tradeState: 'SUCCESS', transactionId: 'fixture-transaction' } },
      async createPayment() {
        calls.paymentRequests++
        if (options.allowPaymentParams) return { params: { fixtureOnly: true } }
        throw new Error('Fixture forbids payment creation')
      },
      async closeOrder() { return true }
    },
    require(name) {
      if (name === 'wx-server-sdk') return {
        init() {}, DYNAMIC_CURRENT_ENV: 'fixture-environment', database: () => db,
        getWXContext: () => options.wxContext || ({ FROM_OPENID: options.caller || owner })
      }
      if (name === './paymentConfig') return {
        loadPaymentConfig: () => ({ callbackSecret: 'fixture-only-callback-secret-not-a-real-credential' }),
        isPaymentConfigured: () => options.configured !== false
      }
      return require(name)
    }
  }
  sandbox.fixtureGatewayConfigured = options.configured !== false
  vm.runInNewContext(source + '\nObject.defineProperty(GATEWAY, "configured", { get: () => fixtureGatewayConfigured }); GATEWAY.queryOrder = gateway.queryOrder; GATEWAY.createPayment = gateway.createPayment; GATEWAY.closeOrder = gateway.closeOrder;', sandbox, { filename: paymentFile })
  return { tables, calls, invoke: data => sandbox.exports.main(data, {}) }
}

test('new orders keep the authenticated server owner without granting client ownership', async () => {
  const h = harness({
    orders: [], allowPaymentParams: true,
    wxContext: { FROM_OPENID: owner, OPENID: 'fixture-resource-app-identity' },
    event: { paidPackages: [{ id: 'fixture-ticket', name: 'Fixture admission', price: 1 }] }
  })
  const result = await h.invoke({
    action: 'createOrder', eventId, ticketId: 'fixture-ticket',
    openid: 'fixture-attacker', _openid: 'fixture-attacker', amountFen: 1
  })
  assert.equal(result.success, true)
  assert.equal(h.tables.orders.length, 1)
  assert.equal(h.tables.orders[0].openid, owner)
  assert.equal(Object.hasOwn(h.tables.orders[0], '_openid'), false)
  assert.equal(h.tables.orders[0].amountFen, 100)
  assert.equal(h.calls.paymentRequests, 1)
})

test('confirmed payment creates a ticket visible to the unchanged Wallet owner query', async () => {
  const h = harness()
  const result = await h.invoke({ action: 'confirmOrder', orderId: registrationId })
  assert.equal(result.status, 'paid')
  assert.equal(h.tables.orders[0].status, 'paid')
  const visible = h.tables.registrations.filter(r => r._openid === owner)
  assert.equal(visible.length, 1)
  assert.equal(visible[0].ticketId, 'fixture-ticket')
  assert.equal(visible[0].paid, true)
  assert.equal(h.calls.paymentRequests, 0)
})

test('opening orders repairs an existing paid ticket whose legacy owner field is missing', async () => {
  const h = harness({
    orders: [fixtureOrder({ status: 'paid', transactionId: 'fixture-transaction' })],
    registrations: [{
      _id: registrationId, eventId, paid: true, orderId: registrationId,
      ticketType: 'Original ticket snapshot', paidAmountFen: 100,
      createdAt: new Date('2026-01-01T00:00:00Z')
    }]
  })
  const result = await h.invoke({ action: 'getMyOrders' })
  assert.equal(result.success, true)
  assert.equal(result.data.length, 1)
  assert.equal(result.data[0].status, 'paid')
  assert.equal(h.tables.registrations[0]._openid, owner)
  assert.equal(h.tables.registrations[0].ticketId, 'fixture-ticket')
  assert.equal(h.tables.registrations[0].ticketType, 'Original ticket snapshot')
  assert.equal(h.tables.registrations[0].paidAmountFen, 100)
  assert.equal(h.tables.events[0].guestCount, 0)
  assert.equal(h.calls.paymentRequests, 0)
})

test('confirming an already paid order restores its missing ticket without charging again', async () => {
  const h = harness({ orders: [fixtureOrder({ status: 'paid', transactionId: 'fixture-transaction' })] })
  const first = await h.invoke({ action: 'confirmOrder', orderId: registrationId })
  const second = await h.invoke({ action: 'confirmOrder', orderId: registrationId })
  assert.equal(first.status, 'paid')
  assert.equal(first.registrationIssued, true)
  assert.equal(second.status, 'paid')
  assert.equal(h.tables.registrations.length, 1)
  assert.equal(h.tables.registrations[0]._openid, owner)
  assert.equal(h.tables.events[0].guestCount, 1)
  assert.equal(h.calls.paymentRequests, 0)
})

test('pending and other guests orders cannot produce a ticket during Wallet recovery', async () => {
  const other = fixtureOrder({ _id: 'fixture-other-order', openid: 'fixture-other-guest', status: 'paid' })
  const h = harness({ orders: [fixtureOrder(), other] })
  const result = await h.invoke({ action: 'getMyOrders' })
  assert.equal(result.success, true)
  assert.equal(result.data.length, 1)
  assert.equal(result.data[0]._id, registrationId)
  assert.equal(h.tables.registrations.length, 0)
  const denied = await h.invoke({ action: 'confirmOrder', orderId: other._id })
  assert.equal(denied.success, false)
  assert.equal(h.calls.gatewayQueries, 0)
  assert.equal(h.calls.paymentRequests, 0)
})

test('recovery never transfers an existing ticket from a different owner', async () => {
  const h = harness({
    orders: [fixtureOrder({ status: 'paid', transactionId: 'fixture-transaction' })],
    registrations: [{ _id: registrationId, eventId, paid: true, _openid: 'fixture-other-guest' }]
  })
  await h.invoke({ action: 'getMyOrders' })
  assert.equal(h.tables.registrations.length, 1)
  assert.equal(h.tables.registrations[0]._openid, 'fixture-other-guest')
  assert.equal(h.tables.events[0].guestCount, 0)
})

test('repeated recovery recreates one missing paid ticket even after ordinary event closure', async () => {
  const h = harness({ orders: [fixtureOrder({ status: 'paid', transactionId: 'fixture-transaction' })], event: { isClosed: true } })
  await h.invoke({ action: 'getMyOrders' })
  await h.invoke({ action: 'getMyOrders' })
  assert.equal(h.tables.registrations.length, 1)
  assert.equal(h.tables.registrations[0]._openid, owner)
  assert.equal(h.tables.events[0].guestCount, 1)
  assert.equal(h.calls.paymentRequests, 0)
})

test('recovery does not recreate registrations while the event is being deleted', async () => {
  const h = harness({ orders: [fixtureOrder({ status: 'paid', transactionId: 'fixture-transaction' })], event: { deleting: true } })
  await h.invoke({ action: 'getMyOrders' })
  assert.equal(h.tables.registrations.length, 0)
  assert.equal(h.tables.orders[0].status, 'paid')
  assert.equal(h.calls.paymentRequests, 0)
})

test('historical paid status alone cannot recover a ticket when the gateway reports a refund', async () => {
  const h = harness({
    orders: [fixtureOrder({ status: 'paid', transactionId: 'fixture-transaction' })],
    gatewayResult: { tradeState: 'REFUND', transactionId: 'fixture-transaction' }
  })
  await h.invoke({ action: 'getMyOrders' })
  const result = await h.invoke({ action: 'confirmOrder', orderId: registrationId })
  assert.equal(h.tables.registrations.length, 0)
  assert.equal(result.registrationIssued, false)
  assert.equal(h.tables.orders[0].status, 'paid') // reconciliation must not invent a new payment state
  assert.equal(h.calls.paymentRequests, 0)
})

test('unsuccessful gateway confirmation cannot create a ticket', async () => {
  const h = harness({ gatewayResult: { tradeState: 'NOTPAY' } })
  const result = await h.invoke({ action: 'confirmOrder', orderId: registrationId })
  assert.equal(result.status, 'pending')
  assert.equal(h.tables.registrations.length, 0)
  assert.equal(h.tables.orders[0].status, 'pending')
})

test('historical recovery rejects incomplete or inconsistent gateway evidence', async t => {
  const cases = [
    { name: 'missing transaction ID', options: { gatewayResult: { tradeState: 'SUCCESS' } } },
    { name: 'different transaction ID', options: { gatewayResult: { tradeState: 'SUCCESS', transactionId: 'fixture-other-transaction' } } },
    { name: 'gateway unavailable', options: { gatewayResult: { tradeState: 'UNKNOWN' } } },
    { name: 'missing configuration', options: { configured: false } },
    { name: 'missing trade number', order: { outTradeNo: '' }, options: {} }
  ]
  for (const item of cases) {
    await t.test(item.name, async () => {
      const h = harness({ orders: [fixtureOrder({ status: 'paid', transactionId: 'fixture-transaction', ...item.order })], ...item.options })
      await h.invoke({ action: 'getMyOrders' })
      const result = await h.invoke({ action: 'confirmOrder', orderId: registrationId })
      assert.equal(result.registrationIssued, false)
      assert.equal(h.tables.registrations.length, 0)
      assert.equal(h.tables.orders[0].status, 'paid')
      assert.equal(h.calls.paymentRequests, 0)
    })
  }
})

test('healthy owned paid tickets need no gateway lookup', async () => {
  const h = harness({
    configured: false,
    orders: [fixtureOrder({ status: 'paid' })],
    registrations: [{ _id: registrationId, eventId, _openid: owner, paid: true, ticketId: 'fixture-ticket' }]
  })
  await h.invoke({ action: 'getMyOrders' })
  const result = await h.invoke({ action: 'confirmOrder', orderId: registrationId })
  assert.equal(result.registrationIssued, true)
  assert.equal(h.calls.gatewayQueries, 0)
  assert.equal(h.tables.registrations.length, 1)
})

test('free tickets upgrade in place without counting a second registration', async () => {
  const h = harness({ registrations: [{ _id: registrationId, eventId, _openid: owner, paid: false, ticketType: 'Free' }] })
  await h.invoke({ action: 'confirmOrder', orderId: registrationId })
  assert.equal(h.tables.registrations.length, 1)
  assert.equal(h.tables.registrations[0].paid, true)
  assert.equal(h.tables.registrations[0].ticketId, 'fixture-ticket')
  assert.equal(h.tables.registrations[0].paidAmountFen, 100)
  assert.equal(h.tables.events[0].guestCount, 0)
})

test('same-app callers also receive tickets with the correct owner', async () => {
  const h = harness({ wxContext: { OPENID: owner } })
  await h.invoke({ action: 'confirmOrder', orderId: registrationId })
  assert.equal(h.tables.registrations[0]._openid, owner)
})

test('concurrent confirms do not create duplicate tickets or count another guest', async () => {
  const h = harness()
  const results = await Promise.all([
    h.invoke({ action: 'confirmOrder', orderId: registrationId }),
    h.invoke({ action: 'confirmOrder', orderId: registrationId })
  ])
  assert.equal(results.every(r => r.status === 'paid'), true)
  assert.equal(h.tables.registrations.length, 1)
  assert.equal(h.tables.registrations[0]._openid, owner)
  assert.equal(h.tables.events[0].guestCount, 1)
})

test('a failed ticket write remains recoverable without another payment', async () => {
  const options = { failRegistrationWrites: true }
  const h = harness(options)
  const result = await h.invoke({ action: 'confirmOrder', orderId: registrationId })
  assert.equal(result.registrationIssued, false)
  assert.equal(h.tables.orders[0].status, 'paid')
  assert.equal(h.tables.registrations.length, 0)
  options.failRegistrationWrites = false
  await h.invoke({ action: 'getMyOrders' })
  assert.equal(h.tables.registrations.length, 1)
  assert.equal(h.tables.registrations[0]._openid, owner)
  assert.equal(h.tables.events[0].guestCount, 1)
  assert.equal(h.calls.paymentRequests, 0)
})

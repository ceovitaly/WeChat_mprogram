'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const directory = path.join(__dirname, '../miniprogram/pages/event-detail')
const source = fs.readFileSync(path.join(directory, 'event-detail.js'), 'utf8')
const template = fs.readFileSync(path.join(directory, 'event-detail.wxml'), 'utf8')

async function loadEvent(event) {
  let definition
  vm.runInNewContext(source, {
    getApp: () => ({}),
    Page: value => { definition = value },
    require: name => {
      if (name === '../../utils/auth.js' || name === '../../utils/pay.js') return {}
      if (name === '../../utils/cloud.js') return { resolveEventImages: async () => {} }
      throw new Error('Unexpected dependency: ' + name)
    },
    wx: { showLoading() {}, hideLoading() {}, setNavigationBarTitle() {} },
    console
  })
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) { Object.assign(this.data, update) }
  })
  for (const name of ['loadVenueInfo', 'loadVenuePhotos', 'checkIfRegistered', 'loadRelatedEvents', '_loadAvailability']) {
    page[name] = () => {}
  }
  page.data.hasProfile = true
  let pending
  page.cloud = { database: () => ({
    collection(name) {
      assert.equal(name, 'events')
      return { doc: () => ({ get({ success }) {
        pending = Promise.resolve(success({ data: Object.assign({}, event) }))
      } }) }
    }
  }) }
  page.getEventDetails('event_fixture')
  await pending
  return page
}

function render(content, data) {
  const value = content.trim()
  const binding = value.match(/^\{\{([\s\S]*)\}\}$/)
  return binding ? vm.runInNewContext(binding[1], data) : value
}

function expectLabels(page, paid) {
  const title = template.match(/<text class="modal-title">([\s\S]*?)<\/text>/)
  const button = template.match(/<button\b[^>]*bindtap="openTicketModal"[^>]*>[\s\S]*?<text>([\s\S]*?)<\/text>/)
  assert.ok(title, 'Ticket sheet title must remain present')
  assert.ok(button, 'Main action must still open the ticket sheet')
  assert.equal(render(title[1], page.data), paid ? 'TICKETS AVAILABLE NOW' : 'ADD ME ON GUESTS LIST')
  assert.equal(render(button[1], page.data), paid ? 'GET THE TICKET' : 'Get on list')
}

test('paid event details show ticket labels before choosing a package', async () => {
  const page = await loadEvent({ isFree: false, paidPackages: [{ id: 'vip', name: 'VIP', price: 180 }] })
  expectLabels(page, true)
  page.openTicketModal()
  expectLabels(page, true)
})

test('legacy priced tickets and paid-event flags use ticket labels', async () => {
  for (const event of [
    { tickets: [{ id: 'entry', price: '120' }] },
    { isPaid: true },
    { hasPaidPackages: true }
  ]) {
    expectLabels(await loadEvent(event), true)
  }
})

test('free entry keeps guest-list copy without changing the selection handler', async () => {
  const page = await loadEvent({ isFree: true })
  expectLabels(page, false)
  page.openTicketModal()
  assert.equal(page.data.selectedTicketId, 'free')
  expectLabels(page, false)
})

test('mixed event copy follows paid-package and free-ticket selections', async () => {
  const page = await loadEvent({ isFree: true, paidPackages: [{ id: 'vip', name: 'VIP', price: 180 }] })
  page.openTicketModal()
  expectLabels(page, false)
  page.selectPackage({ currentTarget: { dataset: { idx: 0, pkgId: 'vip', name: 'VIP', price: 180 } } })
  expectLabels(page, true)
  page.selectTicket({ currentTarget: { dataset: { id: 'free', name: 'Free Entry', price: 0 } } })
  expectLabels(page, false)
})

test('legacy ticket selection and directly opened packages show paid copy', async () => {
  const page = await loadEvent({ isFree: true, paidPackages: [{ id: 'vip', name: 'VIP', price: 180 }] })
  page.selectTicket({ currentTarget: { dataset: { id: 'entry', name: 'Entry', price: '120' } } })
  expectLabels(page, true)
  page.closeTicketModal()
  page.openPackageFromList({ currentTarget: { dataset: { idx: 0 } } })
  assert.equal(page.data.showTicketModal, true)
  expectLabels(page, true)
})

test('external-link paid packages keep ticket copy even without an in-app price', async () => {
  const page = await loadEvent({ paidPackages: [{ id: 'external', price: 0, paymentLink: 'https://example.invalid/pay' }] })
  expectLabels(page, true)
  page.selectPackage({ currentTarget: { dataset: { idx: 0, pkgId: 'external', price: 0, link: 'https://example.invalid/pay' } } })
  expectLabels(page, true)
})

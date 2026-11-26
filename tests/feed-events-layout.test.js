'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const mini = path.join(root, 'miniprogram')
const read = rel => fs.readFileSync(path.join(mini, rel), 'utf8')
const { splitVisibleEvents } = require('../miniprogram/utils/event-visibility.js')

test('mixed free-and-paid events appear in both Main and Events', () => {
  const free = { _id: 'free', hasFreeEntry: true, isPaid: false }
  const mixed = { _id: 'mixed', hasFreeEntry: true, hasPaidPackages: true }
  const paid = { _id: 'paid', hasFreeEntry: false, hasPaidPackages: true }
  const legacyPaid = { _id: 'legacy-paid', hasFreeEntry: false, isPaid: true }
  const hiddenMixed = { _id: 'hidden-mixed', eventsOnly: true, hasFreeEntry: true, isPaid: true }

  const visible = splitVisibleEvents([free, mixed, paid, legacyPaid, hiddenMixed, null])
  assert.deepEqual(visible.main.map(item => item._id), ['free', 'mixed'])
  assert.deepEqual(visible.events.map(item => item._id), ['mixed', 'paid', 'legacy-paid', 'hidden-mixed'])
})

test('navigation uses text-only Main, Wallet, Events and Profile tabs', () => {
  const wxml = read('components/app-tabs/index.wxml')
  for (const label of ['Main', 'Wallet', 'Events', 'Profile']) {
    assert.match(wxml, new RegExp('>' + label + '<'))
  }
  assert.doesNotMatch(wxml, />Feed</)
  assert.doesNotMatch(wxml, /app-tab-icon|icon--(?:home|list|calendar|user)/)
})

test('Events tiles share the rounded full gap before dividing into two columns', () => {
  const wxml = read('pages/feed/feed.wxml')
  const wxss = read('pages/feed/feed.wxss')
  assert.match(wxml, /showPaidEvents \? 'event-grid-container' : ''/)
  assert.match(wxml, /wx:for="\{\{paidEvents\}\}"/)

  const grid = wxss.match(/\.event-grid-container\s*\{([^}]*)\}/)[1]
  const tile = wxss.match(/\.event-grid-container \.event-tile\s*\{([^}]*)\}/)[1]
  assert.match(grid, /flex-direction:\s*row;/)
  assert.match(grid, /flex-wrap:\s*wrap;/)
  assert.match(grid, /gap:\s*20rpx;/)
  assert.match(tile, /flex:\s*0 0 calc\(\(100% - 20rpx\) \/ 2\);/)
  for (const property of ['width', 'max-width']) {
    assert.match(tile, new RegExp(`(?:^|;)\\s*${property}:\\s*calc\\(\\(100% - 20rpx\\) / 2\\);`))
  }
  // The WXSS runtime rounds rpx operands independently. Keep the full gap
  // inside calc, so odd pixel gaps are split only after conversion to px.
  assert.doesNotMatch(tile, /calc\(50% - 10rpx\)/)
})

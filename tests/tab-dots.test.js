'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const storage = Object.create(null)
const app = { globalData: {} }

global.getApp = () => app
global.wx = {
  getStorageSync(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : '' },
  setStorageSync(key, value) { storage[key] = value }
}

const dots = require('../miniprogram/utils/tab-dots.js')

test('an early incomplete collection does not turn the first loaded collection into NEW events', () => {
  delete storage.tab_dots_seen_feed_events
  delete storage.tab_dots_seen_paid_events
  app.globalData = {}

  dots.updateEventDots([], [], 'feed', false)
  assert.deepEqual(dots.getUnseenEventIds([{ _id: 'existing-1' }], 'feed'), [])

  dots.updateEventDots([{ _id: 'existing-1' }], [], 'feed', true)
  assert.equal(dots.getDots().feed, false)
})

test('tab dots track unseen events, active tickets and profile completeness', () => {
  delete storage.tab_dots_seen_feed_events
  delete storage.tab_dots_seen_paid_events
  app.globalData = {}

  dots.updateEventDots([{ _id: 'free-1' }, { _id: 'paid-1' }], [{ _id: 'paid-1' }], 'wallet')
  assert.deepEqual(dots.getDots(), { feed: false, wallet: false, events: false, profile: false })

  dots.updateEventDots(
    [{ _id: 'free-1' }, { _id: 'free-2' }, { _id: 'paid-1' }, { _id: 'paid-2' }],
    [{ _id: 'paid-1' }, { _id: 'paid-2' }],
    'wallet'
  )
  assert.equal(dots.getDots().feed, true)
  assert.equal(dots.getDots().events, true)

  dots.markEventTabSeen('feed', [{ _id: 'free-1' }, { _id: 'free-2' }, { _id: 'paid-1' }, { _id: 'paid-2' }], [{ _id: 'paid-1' }, { _id: 'paid-2' }])
  assert.equal(dots.getDots().feed, false)
  assert.equal(dots.getDots().events, true)

  dots.markEventTabSeen('events', [], [{ _id: 'paid-1' }, { _id: 'paid-2' }])
  assert.equal(dots.getDots().events, false)

  dots.updateWalletDot(true)
  assert.equal(dots.getDots().wallet, true)
  dots.updateWalletDot(false)
  assert.equal(dots.getDots().wallet, false)

  dots.updateProfileDot({ nickName: 'Alex', birthday: '', gender: 'Male', country: 'Italy', music: ['House'] })
  assert.equal(dots.getDots().profile, true)
  dots.updateProfileDot({ nickName: 'Alex', birthday: '1995-05-10', gender: 'Male', country: 'Italy', music: ['House'] })
  assert.equal(dots.getDots().profile, false)
})

test('cached feed is always revalidated for new or deleted events', () => {
  const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/feed/feed.js'), 'utf8')
  const cachedBranch = source.match(/if \(Array\.isArray\(cachedEvents\)[\s\S]*?\n\s*return;/)
  assert.ok(cachedBranch)
  assert.match(cachedBranch[0], /this\.fetchEvents\(false\)/)
  assert.doesNotMatch(cachedBranch[0], /if \(age > /)
})

test('feed clears transient NEW labels when the visible tab is left', () => {
  const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/feed/feed.js'), 'utf8')
  const syncBlock = source.match(/syncRequestedTopTab: function\(\) \{[\s\S]*?\n\s*\},/)
  assert.ok(syncBlock)
  assert.doesNotMatch(syncBlock[0], /markEventTabSeen/)
  assert.match(source, /onHide: function\(\) \{[\s\S]*?clearNewEventLabels/)
  assert.match(source, /clearNewEventLabels: function\(tab\)/)
  assert.match(source, /this\._eventsReady = true;[\s\S]*?this\.applyFilters\(\)/)
  const applyBlock = source.match(/applyFilters: function\(\) \{[\s\S]*?\n\s*rememberNewEventIds:/)
  assert.ok(applyBlock)
  assert.match(applyBlock[0], /tabDots\.updateEventDots\(/)
  assert.match(applyBlock[0], /this\._eventsReady === true/)
})

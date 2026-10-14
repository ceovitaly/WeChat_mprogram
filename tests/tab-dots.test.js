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

test('tab dots track unseen events, active tickets and profile completeness', () => {
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

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const mini = path.join(__dirname, '../miniprogram')
const read = rel => fs.readFileSync(path.join(mini, rel), 'utf8')

test('profile shows completion progress and highlights every missing field', () => {
  const wxml = read('pages/me/me.wxml')
  const js = read('pages/me/me.js')
  assert.match(wxml, /profile-progress/)
  assert.match(wxml, /profileCompletedCount/)
  for (const field of ['name', 'birthday', 'gender', 'country', 'music']) {
    assert.match(wxml, new RegExp('missingProfileFields\\.' + field))
  }
  assert.match(js, /getProfileCompletion/)
})

test('new events are labelled in both Feed and paid Events views', () => {
  const wxml = read('pages/feed/feed.wxml')
  const js = read('pages/feed/feed.js')
  assert.equal((wxml.match(/class="new-event-badge/g) || []).length, 2)
  assert.match(js, /getUnseenEventIds/)
  assert.match(js, /isNew:/)
})

test('pages share one loading component and empty states provide Main actions', () => {
  const feed = read('pages/feed/feed.wxml')
  const wallet = read('pages/mytickets/mytickets.wxml')
  const profile = read('pages/me/me.wxml')
  assert.match(feed, /<loading-state/)
  assert.match(wallet, /<loading-state/)
  assert.match(profile, /<loading-state/)
  assert.match(feed, /bindtap="showFeedFromEmpty"[\s\S]*?>View Main</)
  assert.equal((wallet.match(/bindtap="goToFeed"/g) || []).length, 2)
  assert.equal((wallet.match(/>Explore Main</g) || []).length, 2)
  assert.doesNotMatch(feed + wallet, />[^<]*Feed[^<]*</)
})

test('top navigation keeps larger readable labels on regular and narrow devices', () => {
  const wxml = read('components/app-tabs/index.wxml')
  const js = read('components/app-tabs/index.js')
  const wxss = read('components/app-tabs/index.wxss')
  assert.match(wxml, /app-tabs-row--compact/)
  assert.match(js, /compactNav/)
  assert.match(wxss, /\.app-tab-label\s*\{[\s\S]*?font-size:\s*28rpx;/)
  assert.match(wxss, /\.app-tabs-row--compact \.app-tab-label\s*\{[\s\S]*?font-size:\s*24rpx;/)
})

test('paid events use the shared Main and Events split', () => {
  const feed = read('pages/feed/feed.js')
  const cloud = read('../cloudfunctions/clientAuth/index.js')
  assert.match(feed, /splitVisibleEvents\(filtered\)/)
  assert.match(feed, /paidEvents = visible\.events/)
  assert.match(feed, /marked = visible\.main/)
  assert.match(cloud, /SAFE_FIELDS[\s\S]*?eventsOnly/)
})

test('events-only registrations keep the Wallet notification active', () => {
  const feed = read('pages/feed/feed.js')
  assert.match(feed, /updateWalletDot\(dotCollections\.upcoming\.some/)
})

test('registration callers stop cleanly when an event is being deleted', () => {
  const detail = read('pages/event-detail/event-detail.js')
  const register = read('pages/register/register.js')
  assert.match(detail, /r\.code === 'EVENT_DELETING'[\s\S]*?Event is no longer available[\s\S]*?return/)
  assert.match(register, /r\.code === 'EVENT_DELETING'[\s\S]*?Event is no longer available[\s\S]*?return/)
})

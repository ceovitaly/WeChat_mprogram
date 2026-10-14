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

test('pages share one loading component and empty states provide Feed actions', () => {
  const feed = read('pages/feed/feed.wxml')
  const wallet = read('pages/mytickets/mytickets.wxml')
  const profile = read('pages/me/me.wxml')
  assert.match(feed, /<loading-state/)
  assert.match(wallet, /<loading-state/)
  assert.match(profile, /<loading-state/)
  assert.match(feed, /bindtap="showFeedFromEmpty"/)
  assert.equal((wallet.match(/bindtap="goToFeed"/g) || []).length, 2)
})

test('top navigation exposes a compact layout for narrow devices', () => {
  const wxml = read('components/app-tabs/index.wxml')
  const js = read('components/app-tabs/index.js')
  const wxss = read('components/app-tabs/index.wxss')
  assert.match(wxml, /app-tabs-row--compact/)
  assert.match(js, /compactNav/)
  assert.match(wxss, /\.app-tabs-row--compact/)
})

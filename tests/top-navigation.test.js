'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const mini = path.join(root, 'miniprogram')
const read = rel => fs.readFileSync(path.join(mini, rel), 'utf8')

test('top navigation switches Feed, Wallet, Events and Profile as persistent tabs', () => {
  const app = JSON.parse(read('app.json'))
  const component = read('components/app-tabs/index.wxml')
  const componentJs = read('components/app-tabs/index.js')
  const feed = read('pages/feed/feed.wxml')
  const wallet = read('pages/mytickets/mytickets.wxml')
  const profile = read('pages/me/me.wxml')

  assert.deepEqual(app.tabBar.list.map(item => item.pagePath), [
    'pages/feed/feed',
    'pages/mytickets/mytickets',
    'pages/me/me'
  ])
  for (const label of ['Feed', 'Wallet', 'Events', 'Profile']) {
    assert.match(component, new RegExp('>' + label + '<'))
  }
  assert.match(componentJs, /wx\.switchTab/)
  assert.match(componentJs, /guestTopTab/)
  assert.match(feed, /<app-tabs[^>]*active-tab="\{\{showPaidEvents \? 'events' : 'feed'\}\}"/)
  assert.match(wallet, /<app-tabs[^>]*active-tab="wallet"/)
  assert.match(profile, /<app-tabs[^>]*active-tab="profile"/)
})

test('tab-bar destinations are opened with switchTab rather than page navigation', () => {
  const sources = [
    read('pages/feed/feed.js'),
    read('pages/event-detail/event-detail.js'),
    read('pages/register/register.js')
  ].join('\n')

  assert.doesNotMatch(sources, /wx\.(?:navigateTo|reLaunch)\(\{\s*url:\s*['"]\/pages\/(?:mytickets\/mytickets|me\/me)['"]\s*\}\)/)
  assert.match(sources, /wx\.switchTab\(\{\s*url:\s*['"]\/pages\/mytickets\/mytickets['"]/)
})

test('wallet header uses two equal tabs with an underline active state', () => {
  const wxml = read('pages/mytickets/mytickets.wxml')
  const wxss = read('pages/mytickets/mytickets.wxss')

  assert.equal((wxml.match(/class="tab \{\{activeTab/g) || []).length, 2)
  assert.match(wxss, /\.tab\s*\{[\s\S]*?flex:\s*1;/)
  assert.match(wxss, /\.tab-active::after\s*\{[\s\S]*?bottom:\s*0;[\s\S]*?background:\s*var\(--accent\);/)
  assert.doesNotMatch(wxss, /\.tab-active\s*\{\s*background:/)
})

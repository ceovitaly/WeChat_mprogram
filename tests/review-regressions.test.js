'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const adminRoot = path.join(__dirname, '..')
const betaRoot = path.join(adminRoot, '..')
const guestRoot = path.join(betaRoot, 'The List (Guest)')

const read = file => fs.readFileSync(file, 'utf8')
const adminClientAuth = path.join(adminRoot, 'cloudfunctions/clientAuth/index.js')
const guestClientAuth = path.join(guestRoot, 'cloudfunctions/clientAuth/index.js')

test('clientAuth uses environment-backed WeChat credentials without logging phone payloads', () => {
  for (const file of [adminClientAuth, guestClientAuth]) {
    const source = read(file)
    assert.doesNotMatch(source, /const\s+SECRET\s*=\s*['"][^'"]+['"]/)
    assert.doesNotMatch(source, /phone API result/)
    assert.match(source, /loadWechatConfig/)
  }
  for (const root of [adminRoot, guestRoot]) {
    const config = read(path.join(root, 'cloudfunctions/clientAuth/wechatConfig.js'))
    assert.match(config, /GUEST_WECHAT_APPID/)
    assert.match(config, /GUEST_WECHAT_APP_SECRET/)
  }
})

test('both clientAuth deployment bundles stay byte-for-byte identical', () => {
  assert.equal(read(adminClientAuth), read(guestClientAuth))
  assert.equal(
    read(path.join(adminRoot, 'cloudfunctions/clientAuth/checkinTokens.js')),
    read(path.join(guestRoot, 'cloudfunctions/clientAuth/checkinTokens.js'))
  )
})

test('counter lifecycle only calls the implemented QR cleanup method', () => {
  const source = read(path.join(adminRoot, 'miniprogram/pages/counter/work/work.js'))
  assert.doesNotMatch(source, /_stopQrRotation\s*\(/)
  assert.match(source, /onHide\(\)[\s\S]*?_stopQrCountdown\s*\(/)
  assert.match(source, /onUnload\(\)[\s\S]*?_stopQrCountdown\s*\(/)
})

test('EVENT_OVER is not presented as a successful or duplicate registration', () => {
  const detail = read(path.join(guestRoot, 'miniprogram/pages/event-detail/event-detail.js'))
  const register = read(path.join(guestRoot, 'miniprogram/pages/register/register.js'))
  assert.doesNotMatch(detail, /ALREADY_REGISTERED['"]\s*\|\|\s*r\.code\s*===\s*['"]EVENT_OVER/)
  assert.match(detail, /r\.code\s*===\s*['"]EVENT_OVER['"][\s\S]*?Event has ended/)
  assert.match(register, /r\.code\s*===\s*['"]EVENT_OVER['"][\s\S]*?Event has ended/)
})

test('generated staff passwords and user-provided passwords meet minimum length', () => {
  const source = read(path.join(adminRoot, 'cloudfunctions/manageStaff/index.js'))
  assert.match(source, /generatePassword\s*=\s*\(length\s*=\s*12\)/)
  assert.match(source, /String\(password\)\.length\s*<\s*10/)
})

test('guest feed loads events through clientAuth and renders before image enrichment', () => {
  const source = read(path.join(guestRoot, 'miniprogram/pages/feed/feed.js'))
  assert.match(source, /callFunction\(\{[\s\S]*?name:\s*['"]clientAuth['"][\s\S]*?action:\s*['"]getEvents['"]/)
  assert.match(source, /clientAuth getEvents failed, using DB fallback/)
  assert.match(source, /Array\.isArray\(cachedEvents\)\s*&&\s*cachedEvents\.length\s*>\s*0/)
  const immediateRender = source.indexOf('self.renderEvents(events, true)')
  const enrichment = source.indexOf('self.enrichEventImages(events)', immediateRender)
  assert.ok(immediateRender >= 0, 'feed must render the base event list')
  assert.ok(enrichment > immediateRender, 'image enrichment must happen after the base list renders')
})

test('guest feed defaults to full-width event cards', () => {
  const template = read(path.join(guestRoot, 'miniprogram/pages/feed/feed.wxml'))
  const styles = read(path.join(guestRoot, 'miniprogram/pages/feed/feed.wxss'))

  assert.match(template, /wx:if="\{\{!showPaidEvents && filteredEvents\.length > 0\}\}"/)
  assert.match(template, /wx:for="\{\{filteredEvents\}\}"[\s\S]*?class="event-card/)
  assert.match(template, /class="[^"]*wallet-btn[^"]*"[\s\S]*?catchtap="goToTickets"[\s\S]*?VIEW IN WALLET/)
  assert.match(styles, /\.event-list-container\s*\{[^}]*flex-direction:\s*column/)
  assert.match(styles, /\.event-card\s*\{[^}]*width:\s*100%/)
})

test('Events navigation shows a two-column grid containing only paid events', () => {
  const template = read(path.join(guestRoot, 'miniprogram/pages/feed/feed.wxml'))
  const controller = read(path.join(guestRoot, 'miniprogram/pages/feed/feed.js'))
  const styles = read(path.join(guestRoot, 'miniprogram/pages/feed/feed.wxss'))

  assert.match(template, /bindtap="togglePaidEvents"[\s\S]*?<text class="nav-seg-label">Events<\/text>/)
  assert.match(controller, /showPaidEvents:\s*false/)
  assert.match(controller, /togglePaidEvents:\s*function\(\)/)
  assert.match(controller, /paidEvents\s*=\s*filtered\.filter\([\s\S]*?isPaid[\s\S]*?hasPaidPackages/)
  assert.match(template, /wx:if="\{\{showPaidEvents && paidEvents\.length > 0\}\}"/)
  assert.match(template, /wx:for="\{\{paidEvents\}\}"[\s\S]*?class="event-tile/)
  assert.match(template, /class="event-tile-join"[\s\S]*?catchtap="goToTicketDirect"/)
  assert.match(template, /class="event-tile-wallet"[\s\S]*?catchtap="goToTickets"[\s\S]*?View in Wallet/)
  assert.match(template, /showPaidEvents && paidEvents\.length === 0[\s\S]*?wx:if="\{\{selectedDate \|\| searchKeyword\}\}"[\s\S]*?bindtap="clearAllFilters"/)
  assert.match(styles, /\.event-grid-container\s*\{[^}]*flex-direction:\s*row[^}]*flex-wrap:\s*wrap/)
})

test('event detail shows photos only from its event venue', () => {
  const controller = read(path.join(guestRoot, 'miniprogram/pages/event-detail/event-detail.js'))
  const template = read(path.join(guestRoot, 'miniprogram/pages/event-detail/event-detail.wxml'))
  const styles = read(path.join(guestRoot, 'miniprogram/pages/event-detail/event-detail.wxss'))

  assert.match(controller, /venuePhotos:\s*\[\]/)
  assert.match(controller, /action:\s*['"]getVenueGalleries['"]/)
  assert.match(controller, /v\._id\s*===\s*event\.venueId/)
  assert.match(controller, /v\.name\s*===\s*event\.venueName/)
  assert.match(controller, /action:\s*['"]resolveImages['"]/)
  assert.match(template, /wx:if="\{\{venuePhotos\.length > 0\}\}"[\s\S]*?wx:for="\{\{venuePhotos\}\}"/)
  assert.match(template, /bindtap="previewVenuePhoto"[\s\S]*?data-url="\{\{item\}\}"/)
  assert.equal((template.match(/open-type="share"[\s\S]*?<text class="btn-share-text">Share<\/text>/g) || []).length, 3)
  assert.match(template, /isRegistered && !canUpgrade[\s\S]*?bindtap="goToTickets"[\s\S]*?View in Wallet/)
  assert.match(controller, /goToTickets:\s*function\(\)[\s\S]*?['"]\/pages\/mytickets\/mytickets['"]/)
  assert.match(styles, /\.venue-photo-list\s*\{[^}]*display:\s*flex/)
})

test('event editor persists an external link and event detail can copy it', () => {
  const editor = read(path.join(adminRoot, 'miniprogram/packageAdmin/pages/admin/event-edit/event-edit.js'))
  const editorTemplate = read(path.join(adminRoot, 'miniprogram/packageAdmin/pages/admin/event-edit/event-edit.wxml'))
  const detail = read(path.join(guestRoot, 'miniprogram/pages/event-detail/event-detail.js'))
  const detailTemplate = read(path.join(guestRoot, 'miniprogram/pages/event-detail/event-detail.wxml'))

  assert.match(editorTemplate, /value="\{\{externalLink\}\}"[\s\S]*?bindinput="onExternalLinkInput"/)
  assert.match(editor, /externalLink:\s*e\.externalLink\s*\|\|\s*['"]/)
  assert.match(editor, /eventData\s*=\s*\{[\s\S]*?externalLink/)
  assert.match(detail, /copyExternalLink:\s*function\(\)[\s\S]*?wx\.setClipboardData/)
  assert.equal((detailTemplate.match(/bindtap="copyExternalLink"/g) || []).length, 3)
  assert.equal((detailTemplate.match(/<text class="btn-share-text">Copy link<\/text>/g) || []).length, 3)
})

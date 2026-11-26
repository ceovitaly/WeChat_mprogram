'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const page = path.join(__dirname, '../miniprogram/pages/event-detail')
const read = file => fs.readFileSync(path.join(page, file), 'utf8')

test('labeled Share has comfortable padding while the primary action stays flexible', () => {
  const wxml = read('event-detail.wxml')
  const wxss = read('event-detail.wxss')

  assert.equal((wxml.match(/class="icon icon--link btn-copy-icon"/g) || []).length, 3)
  assert.equal((wxml.match(/event\.externalLink \? 'btn-icon-action' : ''/g) || []).length, 3)
  assert.equal((wxml.match(/wx:if="\{\{!event\.externalLink\}\}" class="btn-share-text">Share/g) || []).length, 3)
  assert.doesNotMatch(wxml, />Copy link<\/text>/)
  assert.match(wxml, /class="btn-register[^\"]*"[^>]*bindtap="openTicketModal"/)

  assert.match(wxss, /\.btn-register\s*\{[\s\S]*?flex:\s*1 1 0%;[\s\S]*?min-width:\s*0;/)
  const share = wxss.match(/\.btn-share\s*\{([^}]*)\}/)[1]
  for (const property of ['width', 'min-width', 'max-width']) {
    assert.match(share, new RegExp(`(?:^|;)\\s*${property}:\\s*192rpx;`))
  }
  assert.match(share, /flex:\s*0 0 192rpx;/)
  assert.match(share, /padding:\s*0 24rpx;/)
  assert.match(share, /white-space:\s*nowrap;/)
  assert.match(wxss, /\.btn-share-icon\s*\{[^}]*flex-shrink:\s*0;/)
  assert.match(wxss, /\.btn-share-text\s*\{[^}]*flex-shrink:\s*0;/)
  assert.match(wxss, /\.btn-icon-action\s*\{[\s\S]*?width:\s*64rpx;[\s\S]*?min-width:\s*64rpx;[\s\S]*?max-width:\s*64rpx;[\s\S]*?flex-basis:\s*64rpx;[\s\S]*?height:\s*64rpx;/)
  assert.match(wxss, /\.btn-copy-icon\s*\{[^}]*-webkit-mask-image:/s)
})

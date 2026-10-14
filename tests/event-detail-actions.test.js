'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const page = path.join(__dirname, '../miniprogram/pages/event-detail')
const read = file => fs.readFileSync(path.join(page, file), 'utf8')

test('external links turn copy and share actions into icon-only circles', () => {
  const wxml = read('event-detail.wxml')
  const wxss = read('event-detail.wxss')

  assert.equal((wxml.match(/class="icon icon--link btn-copy-icon"/g) || []).length, 3)
  assert.equal((wxml.match(/event\.externalLink \? 'btn-icon-action' : ''/g) || []).length, 3)
  assert.equal((wxml.match(/wx:if="\{\{!event\.externalLink\}\}" class="btn-share-text">Share/g) || []).length, 3)
  assert.doesNotMatch(wxml, />Copy link<\/text>/)

  assert.match(wxss, /\.btn-icon-action\s*\{[^}]*width:\s*76rpx[^}]*min-width:\s*76rpx[^}]*padding:\s*0/s)
  assert.match(wxss, /\.btn-copy-icon\s*\{[^}]*-webkit-mask-image:/s)
})

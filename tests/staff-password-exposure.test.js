'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')

test('manageStaff never returns password fields in roster queries', () => {
  const source = read('cloudfunctions/manageStaff/index.js')
  assert.match(source, /\.field\(\{[\s\S]*?_id:\s*true[\s\S]*?lastLogin:\s*true[\s\S]*?\}\)/)
  assert.doesNotMatch(source, /password:\s*true/)
  assert.doesNotMatch(source, /lastOpenid:\s*true/)
})

test('staff UI does not render, cache, or copy stored passwords', () => {
  const js = read('miniprogram/packageAdmin/pages/admin/staff/staff.js')
  const wxml = read('miniprogram/packageAdmin/pages/admin/staff/staff.wxml')

  assert.doesNotMatch(js, /item\.password/)
  assert.doesNotMatch(js, /copyCredentials/)
  assert.doesNotMatch(wxml, /item\.password/)
  assert.match(js, /res\.password/)
  assert.match(js, /setClipboardData/)
  assert.match(wxml, /Leave blank to keep current password/)
})

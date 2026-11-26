'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

test('event deletion cascades all registrations and verifies the event is gone', () => {
  const cloud = read('cloudfunctions/manageApplications/index.js')
  const calendar = read('miniprogram/pages/admin/calendar/calendar.js')
  const clientAuth = read('cloudfunctions/clientAuth/index.js')
  const payments = read('cloudfunctions/payments/index.js')

  assert.match(cloud, /data:\s*\{[\s\S]*?deleting:\s*true[\s\S]*?isClosed:\s*true/)
  assert.match(cloud, /MAX_DELETE_BATCHES/)
  assert.match(cloud, /while \(true\)[\s\S]*?collection\('registrations'\)[\s\S]*?batchCount >= MAX_DELETE_BATCHES/)
  assert.match(cloud, /collection\('events'\)\.doc\(targetId\)\.remove\(\)/)
  assert.match(cloud, /collection\('events'\)\.where\(\{ _id: targetId \}\)\.count\(\)/)
  assert.match(cloud, /remaining\.total > 0/)
  assert.match(cloud, /remainingRegistrations\.total > 0/)
  assert.match(clientAuth, /eventDoc\.deleting === true[\s\S]*?EVENT_DELETING/)
  assert.match(payments, /eventDoc\.deleting === true/)
  assert.doesNotMatch(payments, /eventDoc\.deleting === true\s*\|\|\s*eventDoc\.isClosed === true/)
  assert.match(calendar, /events:\s*this\.data\.events\.filter\(event => event\._id !== id\)/)
})

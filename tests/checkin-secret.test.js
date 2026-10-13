'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const modules = [
  ['manageApplications', require('../cloudfunctions/manageApplications/checkinTokens')],
  ['admin clientAuth', require('../cloudfunctions/clientAuth/checkinTokens')],
  ['guest clientAuth', require('../../The List (Guest)/cloudfunctions/clientAuth/checkinTokens')]
]
const ENV = { CHECKIN_SECRET: 'test-only-secret-that-is-longer-than-32-bytes' }

for (const [label, tokens] of modules) {
  test(`${label}: requires CHECKIN_SECRET`, () => {
    assert.throws(() => tokens.createToken('evt-1', 200, {}), /CHECKIN_SECRET/)
    assert.throws(() => tokens.createToken('evt-1', 200, { CHECKIN_SECRET: 'short' }), /CHECKIN_SECRET/)
  })

  test(`${label}: creates and validates a signed token`, () => {
    const token = tokens.createToken('evt-1', 200, ENV)
    assert.deepEqual(tokens.parseToken(token, { nowSec: 190, graceSec: 2 }, ENV), { eventId: 'evt-1' })
    assert.deepEqual(tokens.parseToken(token, { nowSec: 203, graceSec: 2 }, ENV), { error: 'expired' })
  })

  test(`${label}: rejects a forged signature`, () => {
    const token = tokens.createToken('evt-1', 200, ENV)
    const forged = token.replace(/.$/, token.endsWith('0') ? '1' : '0')
    assert.deepEqual(tokens.parseToken(forged, { nowSec: 190 }, ENV), { error: 'bad' })
  })
}

test('production sources do not contain a hardcoded check-in secret', () => {
  const files = [
    'cloudfunctions/manageApplications/index.js',
    'cloudfunctions/clientAuth/index.js',
    '../The List (Guest)/cloudfunctions/clientAuth/index.js'
  ]
  for (const relative of files) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    assert.doesNotMatch(source, /const CHECKIN_SECRET\s*=\s*['"][^'"]+['"]/, relative)
    assert.match(source, /checkinTokens/, relative)
  }
})

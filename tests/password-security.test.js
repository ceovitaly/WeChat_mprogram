'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const loginPasswords = require('../cloudfunctions/loginStaff/passwords')
const managePasswords = require('../cloudfunctions/manageStaff/passwords')

for (const [label, passwords] of [
  ['loginStaff', loginPasswords],
  ['manageStaff', managePasswords]
]) {
  test(`${label}: hashes passwords without storing plaintext`, async () => {
    const encoded = await passwords.hashPassword('Correct Horse Battery Staple')

    assert.equal(passwords.isPasswordHash(encoded), true)
    assert.equal(encoded.includes('Correct Horse Battery Staple'), false)
    assert.equal(await passwords.verifyPassword('Correct Horse Battery Staple', encoded), true)
    assert.equal(await passwords.verifyPassword('wrong password', encoded), false)
  })

  test(`${label}: accepts legacy plaintext only for migration`, async () => {
    assert.equal(await passwords.verifyPassword('legacy-pass', 'legacy-pass'), true)
    assert.equal(await passwords.verifyPassword('wrong', 'legacy-pass'), false)
    assert.equal(passwords.needsRehash('legacy-pass'), true)
  })

  test(`${label}: rejects empty passwords`, async () => {
    await assert.rejects(() => passwords.hashPassword(''), /Password is required/)
  })
}

test('both cloud functions use the same password format', async () => {
  const encoded = await managePasswords.hashPassword('shared-format')
  assert.equal(await loginPasswords.verifyPassword('shared-format', encoded), true)
})

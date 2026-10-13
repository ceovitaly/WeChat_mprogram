'use strict'

const crypto = require('crypto')
const { promisify } = require('util')

const scrypt = promisify(crypto.scrypt)
const PREFIX = 'scrypt'
const KEY_LENGTH = 64

function isPasswordHash(value) {
  return typeof value === 'string' && value.startsWith(PREFIX + '$')
}

function needsRehash(value) {
  return !isPasswordHash(value)
}

async function hashPassword(password) {
  const plain = String(password || '')
  if (!plain) throw new Error('Password is required')

  const salt = crypto.randomBytes(16)
  const derived = await scrypt(plain, salt, KEY_LENGTH)
  return [PREFIX, salt.toString('base64'), Buffer.from(derived).toString('base64')].join('$')
}

function safeEqualText(left, right) {
  const a = crypto.createHash('sha256').update(String(left)).digest()
  const b = crypto.createHash('sha256').update(String(right)).digest()
  return crypto.timingSafeEqual(a, b)
}

async function verifyPassword(password, stored) {
  const plain = String(password || '')
  const encoded = String(stored || '')
  if (!plain || !encoded) return false

  if (!isPasswordHash(encoded)) {
    return safeEqualText(plain, encoded)
  }

  const parts = encoded.split('$')
  if (parts.length !== 3) return false

  try {
    const salt = Buffer.from(parts[1], 'base64')
    const expected = Buffer.from(parts[2], 'base64')
    if (!salt.length || expected.length !== KEY_LENGTH) return false
    const actual = Buffer.from(await scrypt(plain, salt, expected.length))
    return crypto.timingSafeEqual(actual, expected)
  } catch (_) {
    return false
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  isPasswordHash,
  needsRehash
}

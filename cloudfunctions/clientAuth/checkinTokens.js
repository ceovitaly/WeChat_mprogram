'use strict'

const crypto = require('crypto')
const SIGNATURE_HEX_LENGTH = 16

function getSecret(env = process.env) {
  const secret = String((env && env.CHECKIN_SECRET) || '').trim()
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('CHECKIN_SECRET must be configured with at least 32 bytes')
  }
  return secret
}

function signature(eventId, expStr, env) {
  return crypto.createHmac('sha256', getSecret(env))
    .update(String(eventId) + '.' + String(expStr))
    .digest('hex')
    .slice(0, SIGNATURE_HEX_LENGTH)
}

function createToken(eventId, exp, env = process.env) {
  const id = String(eventId || '').trim()
  const expStr = String(exp || '')
  if (!id || !/^\d+$/.test(expStr)) throw new Error('Invalid check-in token payload')
  return `${id}.${expStr}.${signature(id, expStr, env)}`
}

function parseToken(token, options = {}, env = process.env) {
  const parts = String(token || '').trim().split('.')
  if (parts.length !== 3) return { error: 'bad' }
  const [eventId, expStr, supplied] = parts
  if (!eventId || !/^\d+$/.test(expStr) || !/^[a-f0-9]+$/i.test(supplied)) return { error: 'bad' }

  const expected = signature(eventId, expStr, env)
  const a = Buffer.from(supplied, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: 'bad' }

  const nowSec = options.nowSec == null ? Date.now() / 1000 : Number(options.nowSec)
  const graceSec = Number(options.graceSec || 0)
  if (nowSec > Number(expStr) + graceSec) return { error: 'expired' }
  return { eventId }
}

module.exports = { createToken, parseToken, getSecret }

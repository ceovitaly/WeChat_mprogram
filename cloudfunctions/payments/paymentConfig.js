'use strict'

const LEGACY_PLACEHOLDER = 'https://cloud1-9g2yewom6a2d5467.service.tcloudbase.com/payments/notify'

function required(env, name) {
  const value = String((env && env[name]) || '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function loadPaymentConfig(env = process.env) {
  const notifyUrl = required(env, 'WXPAY_NOTIFY_URL')
  let parsed
  try {
    parsed = new URL(notifyUrl)
  } catch (_) {
    throw new Error('WXPAY_NOTIFY_URL must be a valid HTTPS URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('WXPAY_NOTIFY_URL must use HTTPS')
  }
  if (notifyUrl === LEGACY_PLACEHOLDER) {
    throw new Error('WXPAY_NOTIFY_URL still points to the non-functional placeholder')
  }

  const privateKey = required(env, 'WXPAY_PRIVATE_KEY').replace(/\\n/g, '\n')
  if (!/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(privateKey)) {
    throw new Error('WXPAY_PRIVATE_KEY is not a PEM private key')
  }

  return {
    appid: required(env, 'WXPAY_APPID'),
    mchid: required(env, 'WXPAY_MCHID'),
    serial: required(env, 'WXPAY_SERIAL'),
    privateKey,
    notifyUrl,
    callbackSecret: (() => {
      const value = required(env, 'PAY_CALLBACK_SECRET')
      if (Buffer.byteLength(value, 'utf8') < 32) {
        throw new Error('PAY_CALLBACK_SECRET must contain at least 32 bytes')
      }
      return value
    })()
  }
}

function isPaymentConfigured(env = process.env) {
  try {
    loadPaymentConfig(env)
    return true
  } catch (_) {
    return false
  }
}

module.exports = { loadPaymentConfig, isPaymentConfigured }

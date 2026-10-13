'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const config = require('../cloudfunctions/payments/paymentConfig')

const COMPLETE_ENV = {
  WXPAY_APPID: 'wx-test-appid',
  WXPAY_MCHID: '1900000000',
  WXPAY_SERIAL: 'SERIAL123',
  WXPAY_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
  WXPAY_NOTIFY_URL: 'https://payments.example.com/wechat/notify',
  PAY_CALLBACK_SECRET: 'callback-secret-at-least-32-characters-long'
}

test('payment config requires a real HTTPS notification endpoint', () => {
  assert.throws(() => config.loadPaymentConfig({ ...COMPLETE_ENV, WXPAY_NOTIFY_URL: '' }), /WXPAY_NOTIFY_URL/)
  assert.throws(() => config.loadPaymentConfig({ ...COMPLETE_ENV, WXPAY_NOTIFY_URL: 'http://example.com/notify' }), /HTTPS/)
  assert.throws(() => config.loadPaymentConfig({ ...COMPLETE_ENV, WXPAY_NOTIFY_URL: 'https://cloud1-9g2yewom6a2d5467.service.tcloudbase.com/payments/notify' }), /placeholder/i)
  assert.throws(() => config.loadPaymentConfig({ ...COMPLETE_ENV, PAY_CALLBACK_SECRET: '' }), /PAY_CALLBACK_SECRET/)
})

test('payment config normalizes the private key and exposes explicit values', () => {
  const loaded = config.loadPaymentConfig(COMPLETE_ENV)
  assert.equal(loaded.appid, COMPLETE_ENV.WXPAY_APPID)
  assert.equal(loaded.notifyUrl, COMPLETE_ENV.WXPAY_NOTIFY_URL)
  assert.match(loaded.privateKey, /BEGIN PRIVATE KEY-----\nabc/)
})

test('payments source no longer silently uses a dead placeholder callback', () => {
  const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/payments/index.js'), 'utf8')
  assert.doesNotMatch(source, /NOTIFY_URL_PLACEHOLDER/)
  assert.doesNotMatch(source, /const GUEST_APPID/)
  assert.match(source, /notify_url:\s*cfg\.notifyUrl/)
  assert.match(source, /appid:\s*cfg\.appid/)
  assert.match(source, /where\(\{\s*outTradeNo\s*\}\)/)
  assert.doesNotMatch(source, /collection\('orders'\)\.doc\(outTradeNo\)/)
})

'use strict'

function required(env, name) {
  const value = String((env && env[name]) || '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function loadWechatConfig(env = process.env) {
  const appid = required(env, 'GUEST_WECHAT_APPID')
  const secret = required(env, 'GUEST_WECHAT_APP_SECRET')
  if (secret.length < 16) {
    throw new Error('GUEST_WECHAT_APP_SECRET is invalid')
  }
  return { appid, secret }
}

module.exports = { loadWechatConfig }

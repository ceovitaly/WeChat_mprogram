const app = getApp()
const { callFunction } = require('../../utils/request')
const { saveUser, getStartPageByRole } = require('../../utils/auth')
const { CLOUD_FUNCTIONS } = require('../../utils/constants')

Page({
  data: {
    username: '',
    password: '',
    loading: false
  },

  onLoad() {
    if (app.globalData.isLogged) {
      const url = getStartPageByRole(app.globalData.role)
      wx.reLaunch({ url })
    }
  },

  onInputUser(e) {
    this.setData({ username: e.detail.value })
  },

  onInputPass(e) {
    this.setData({ password: e.detail.value })
  },

  async handleLogin() {
    const { username, password, loading } = this.data
    if (loading) return

    if (!username.trim() || !password.trim()) {
      wx.showToast({ title: 'Enter credentials', icon: 'none' })
      return
    }

    this.setData({ loading: true })

    try {
      const result = await callFunction(CLOUD_FUNCTIONS.LOGIN_STAFF, {
        username: username.trim(),
        password: password.trim()
      })

      if (result && result.success) {
        const userData = result.data
        saveUser(userData)
        app.globalData.userInfo = userData
        app.globalData.role = userData.role
        app.globalData.isLogged = true

        wx.vibrateShort({ type: 'medium' })
        wx.showToast({ title: 'Welcome!', icon: 'success' })

        setTimeout(() => {
          const url = getStartPageByRole(userData.role)
          wx.reLaunch({ url })
        }, 800)
      } else {
        wx.showToast({
          title: result?.message || 'Auth failed',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('[Login] Error:', err)
      wx.showToast({ title: 'Connection error', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  }
})
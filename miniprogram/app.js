App({
  globalData: {
    openid: null,
    cloud: null,
    cloudReady: false,
    cloudReadyCallbacks: [],
    openidReadyCallbacks: [],
    userInfo: null,
    sceneData: null
  },

  onLaunch(options) {
    if (!wx.cloud) {
      console.error('Please use base library 2.2.3+')
      return
    }

    const cloud = new wx.cloud.Cloud({
      resourceAppid: 'wxb3ff00281bf0dca9',
      resourceEnv: 'cloud1-9g2yewom6a2d5467'
    })

    cloud.init().then(() => {
      this.globalData.cloud = cloud
      this.globalData.cloudReady = true
      this.globalData.cloudReadyCallbacks.forEach(cb => cb(cloud))
      this.globalData.cloudReadyCallbacks = []

      const tryLogin = (attemptsLeft) => {
        cloud.callFunction({ name: 'login' }).then(res => {
          const openid = res.result.openid || res.result.fromOpenid
          this.globalData.openid = openid
          this.globalData.openidReadyCallbacks.forEach(cb => cb(openid))
          this.globalData.openidReadyCallbacks = []
        }).catch(err => {
          console.error('[App] login error:', err)
          if (attemptsLeft > 0) {
            setTimeout(() => tryLogin(attemptsLeft - 1), 1500)
          } else {
            // Give up: flush waiters with null so getOpenid()-based flows
            // (utils/auth.js getAuth) fail gracefully instead of hanging.
            this.globalData.openidReadyCallbacks.forEach(cb => cb(null))
            this.globalData.openidReadyCallbacks = []
          }
        })
      }
      tryLogin(2)
    })

    // Читаем QR scene
    if (options.query && options.query.scene) {
      const scene = decodeURIComponent(options.query.scene)
      const parts = scene.split(':')
      if (parts.length === 2) {
        this.globalData.sceneData = {
          eventId: parts[0],
          promoterId: parts[1]
        }
      }
    }
  },

  getCloud(callback) {
    if (this.globalData.cloudReady) {
      callback(this.globalData.cloud)
    } else {
      this.globalData.cloudReadyCallbacks.push(callback)
    }
  },

  getOpenid(callback) {
    if (this.globalData.openid) {
      callback(this.globalData.openid)
    } else {
      this.globalData.openidReadyCallbacks.push(callback)
    }
  }
})
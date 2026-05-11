const LIST = [
  { pagePath: '/pages/feed/feed', text: 'Events', icon: 'events' },
  { pagePath: '/pages/mytickets/mytickets', text: 'Tickets', icon: 'tickets' },
  { pagePath: '/pages/me/me', text: 'Me', icon: 'me' }
]

Component({
  data: { selected: 0, list: LIST },

  pageLifetimes: {
    show() { this._sync() }
  },

  methods: {
    _sync() {
      const pages = getCurrentPages()
      const cur = pages[pages.length - 1]
      const path = cur ? '/' + cur.route : ''
      const idx = LIST.findIndex(i => i.pagePath === path)
      this.setData({ selected: idx >= 0 ? idx : 0 })
    },

    switchTab(e) {
      const { path, index } = e.currentTarget.dataset
      if (this.data.selected === index) return
      this.setData({ selected: index })
      wx.switchTab({ url: path })
    }
  }
})
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
      // Обновляем selected только если путь изменился
      if (this.data.selected !== idx && idx >= 0) {
        this.setData({ selected: idx })
      } else if (idx < 0) {
        // Если текущая страница не в списке таббаров (например event-detail),
        // пытаемся определить родительскую таб-страницу
        const parentTabIdx = pages.slice(0, -1).reverse().findIndex(p => {
          return LIST.some(i => i.pagePath === '/' + p.route)
        })
        if (parentTabIdx >= 0) {
          const parentRoute = pages[pages.length - 2 - parentTabIdx].route
          const parentIdx = LIST.findIndex(i => i.pagePath === '/' + parentRoute)
          if (parentIdx >= 0) {
            this.setData({ selected: parentIdx })
          }
        }
      }
    },

    switchTab(e) {
      const { path, index } = e.currentTarget.dataset
      if (this.data.selected === index) return
      this.setData({ selected: index })
      wx.switchTab({ url: path })
    }
  }
})
const LIST = [
  { pagePath: '/pages/feed/feed', text: 'Events', icon: 'events' },
  { pagePath: '/pages/mytickets/mytickets', text: 'Tickets', icon: 'tickets' },
  { pagePath: '/pages/me/me', text: 'Me', icon: 'me' }
]

Component({
  data: { selected: -1, list: LIST },
  
  pageLifetimes: {
    show() { this._sync() }
  },
  
  methods: {
    _sync() {
      const pages = getCurrentPages()
      const cur = pages[pages.length - 1]
      const path = cur ? '/' + cur.route : ''
      const idx = LIST.findIndex(i => i.pagePath === path)
      
      // Всегда обновляем selected при совпадении пути
      if (idx >= 0 && this.data.selected !== idx) {
        this.setData({ selected: idx })
      } else if (idx < 0) {
        // Если текущая страница не в списке таббаров (например event-detail),
        // ищем последнюю таб-страницу в стеке
        for (let i = pages.length - 1; i >= 0; i--) {
          const route = '/' + pages[i].route
          const tabIdx = LIST.findIndex(t => t.pagePath === route)
          if (tabIdx >= 0) {
            if (this.data.selected !== tabIdx) {
              this.setData({ selected: tabIdx })
            }
            break
          }
        }
      }
    },

    switchTab(e) {
      const { path, index } = e.currentTarget.dataset
      // Сначала обновляем визуальное состояние
      this.setData({ selected: index })
      // Затем выполняем переход
      wx.switchTab({ url: path })
    }
  }
})

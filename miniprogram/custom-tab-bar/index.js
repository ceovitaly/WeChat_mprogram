const LIST = [
  { pagePath: '/pages/feed/feed', text: 'Events', icon: 'events' },
  { pagePath: '/pages/mytickets/mytickets', text: 'Tickets', icon: 'tickets' },
  { pagePath: '/pages/me/me', text: 'Me', icon: 'me' }
]

Component({
  data: { selected: -1, list: LIST },
  
  methods: {
    switchTab(e) {
      const { path, index } = e.currentTarget.dataset
      // Сначала обновляем визуальное состояние
      this.setData({ selected: index })
      // Затем выполняем переход
      wx.switchTab({ url: path })
    }
  }
})

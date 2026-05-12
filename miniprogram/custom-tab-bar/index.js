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
      // СРАЗУ обновляем визуальное состояние для мгновенного отклика
      this.setData({ selected: index })
      // Выполняем переход
      wx.switchTab({ url: path })
    },
    
    updateActive(index) {
      // Обновляем только если индекс изменился
      if (this.data.selected !== index) {
        this.setData({ selected: index })
      }
    }
  }
})

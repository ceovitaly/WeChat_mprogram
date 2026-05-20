const ADMIN_LIST = [
  { pagePath: '/pages/admin/calendar/calendar', text: 'Schedule', icon: 'calendar' },
  { pagePath: '/pages/admin/team/team', text: 'Team', icon: 'team' },
  { pagePath: '/pages/admin/stats/stats', text: 'Stats', icon: 'stats' }
]

const COUNTER_LIST = [
  { pagePath: '/pages/counter/work/work', text: 'Work', icon: 'work' },
  { pagePath: '/pages/counter/stats/stats', text: 'Stats', icon: 'stats' }
]

Component({
  data: {
    selected: 0,
    role: '',
    list: []
  },

  lifetimes: {
    attached() {
      this.updateTabs()
    }
  },

  pageLifetimes: {
    show() {
      this.updateTabs()
    }
  },

  methods: {
    updateTabs() {
      const user = wx.getStorageSync('staffUser')
      const role = user ? user.role : 'counter'
      const list = role === 'admin' ? ADMIN_LIST : COUNTER_LIST

      const pages = getCurrentPages()
      const currentPage = pages && pages.length > 0 ? pages[pages.length - 1] : null
      const currentPath = currentPage && currentPage.route ? '/' + currentPage.route : ''
      const selected = list.findIndex(item => item.pagePath === currentPath)

      this.setData({
        role,
        list,
        selected: selected >= 0 ? selected : 0
      })
    },

    switchTab(e) {
      const { path, index } = e.currentTarget.dataset
      if (this.data.selected === index) return
      this.setData({ selected: index })
      wx.switchTab({ url: path })
    }
  }
})
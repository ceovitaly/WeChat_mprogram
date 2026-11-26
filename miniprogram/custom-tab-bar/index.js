const ADMIN_LIST = [
  { pagePath: '/pages/admin/calendar/calendar', text: 'Schedule', icon: 'calendar' },
  { pagePath: '/pages/admin/events/events', text: 'Events', icon: 'events' },
  { pagePath: '/pages/admin/main/main', text: 'Main', icon: 'main' },
  { pagePath: '/pages/admin/history/history', text: 'History', icon: 'history' }
]

const COUNTER_LIST = [
  { pagePath: '/pages/counter/work/work', text: 'Work', icon: 'work' }
]

Component({
  data: {
    selected: 0,
    role: '',
    // Pre-filled with the admin list: every tab page renders its OWN
    // instance of this component, and an empty first frame (list: []) was
    // visible as a flicker on every tab switch. The role can't change
    // mid-session, so starting with the admin list is safe; updateTabs()
    // still swaps in COUNTER_LIST + hidden for counter users on attach.
    list: ADMIN_LIST,
    hidden: false
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

      // Hide tab bar for counter role (always hide for counter)
      const hidden = role === 'counter'

      this.setData({
        role,
        list,
        selected: selected >= 0 ? selected : 0,
        hidden
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
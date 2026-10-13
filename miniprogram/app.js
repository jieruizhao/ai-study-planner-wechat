const store = require('./utils/store')
const sync = require('./utils/sync')
const api = require('./utils/api')
const theme = require('./utils/theme')
const diag = require('./utils/diag')

// 云环境 ID（微信开发者工具 → 云开发 → 环境 ID）
// 注意：这里填的是「云开发」环境 ID；若使用云托管的 MySQL，请见 docs/数据库接入说明.md
const CLOUD_ENV = 'YOUR_CLOUD_ENV_ID'

// tabBar 图标资源清单（自检用）
const ASSETS = []
;['', 'dark/'].forEach(sub => {
  ;['home', 'calendar', 'chart', 'user'].forEach(n => {
    ASSETS.push(`assets/icons/${sub}${n}.png`, `assets/icons/${sub}${n}-on.png`)
  })
})

App({
  globalData: {
    profile: null,
    loginReady: false
  },

  onLaunch() {
    diag.init()
    diag.checkAssets(ASSETS)
    theme.init()
    theme.applyChrome()
    store.load()
    if (!wx.cloud) {
      this.globalData.profile = store.get().profile
      this.globalData.loginReady = true
      console.error('[启动失败] 当前基础库不支持云开发，请在开发者工具中将基础库调到 2.2.3 以上')
      return
    }
    wx.cloud.init({ env: CLOUD_ENV, traceUser: true })
    this.login()
    if (wx.onNetworkStatusChange) wx.onNetworkStatusChange(({ isConnected }) => {
      if (isConnected) this.login().then(() => sync.flush()).then(() => this.refreshViews()).catch(() => {})
    })
  },

  onShow() {
    sync.flush().then(() => this.refreshViews()).catch(() => {})
    diag.checkQueue(sync.pendingCount())
  },

  async login() {
    const db = store.get()
    if (db.accountSignedOut) { this.globalData.loginReady = true; this.refreshViews(); return }
    const beforeExamDate = db.profile && db.profile.examDate
    const pendingBefore = db.queue.some(op => op.type === 'profile.update')
    try {
      const profile = await api.call('user', 'login', {}, { silent: true })
      if (db.profile.accountId && profile.accountId && db.profile.accountId !== profile.accountId) {
        store.signOut()
        this.globalData.profile = store.get().profile
        this.globalData.loginReady = true
        return
      }
      // 合并而非整体覆盖：本地尚有未同步的资料修改（如刚设置的考试日）时以本地为准
      const pendingProfile = db.queue.some(op => op.type === 'profile.update')
      const local = db.profile || {}
      const merged = Object.assign({}, local, profile || {})
      if (db.accountSignedOut) merged.accountAuthorized = false
      if (pendingBefore || pendingProfile || local.examDate !== beforeExamDate) merged.examDate = local.examDate
      db.profile = merged
      store.persist()
      this.globalData.profile = db.profile
      this.globalData.loginReady = true
    } catch (e) {
      // 离线/云环境未配置：用本地资料继续可用，联网后自动补同步
      if (!db.profile) {
        db.profile = { openidMask: '本地模式', examDate: null, timezone: 'Asia/Shanghai' }
        store.persist()
      }
      this.globalData.profile = db.profile
      this.globalData.loginReady = true
    } finally {
      this.refreshViews()
    }
  },

  refreshViews() {
    if (typeof getCurrentPages !== 'function') return
    getCurrentPages().forEach(page => {
      if (typeof page.render === 'function') page.render()
      else if (typeof page.renderLocal === 'function') page.renderLocal()
    })
  },

  getProfile() {
    return store.get().profile || this.globalData.profile
  },

  examCountdown() {
    const p = this.getProfile()
    if (!p || !p.examDate) return null
    const d = require('./utils/date')
    const days = d.diffDays(p.examDate, d.todayStr())
    return { date: p.examDate, days, past: days < 0, isToday: days === 0 }
  },

  // 问候语（按本地时段）
  greeting() {
    const h = new Date().getHours()
    if (h < 6) return '夜深了，早点休息。'
    if (h < 11) return '上午好，慢慢进入状态。'
    if (h < 14) return '中午好，歇一歇再出发。'
    if (h < 18) return '下午好，保持这个节奏。'
    return '晚上好，今天也辛苦了。'
  }
})

const store = require('../../utils/store')
const theme = require('../../utils/theme')
const d = require('../../utils/date')

const EN = { 听力: 'LISTENING', 阅读: 'READING', 写作: 'WRITING', 口语: 'SPEAKING', 单词: 'VOCAB', 其他: 'STUDY' }
const TIPS = {
  听力: '先看题干预判场景，再抓同义替换。',
  阅读: '先把这一段读清楚，不着急追赶时间。',
  写作: '先列提纲，明确立场与段落结构。',
  口语: '先说一遍并录音，回听找问题。',
  单词: '少量多次：先复习旧的，再学新的。',
  其他: '把任务拆成 25 分钟的小块，逐个完成。'
}

Page({
  data: {
    statusBarH: 44, theme: 'light',
    stamp: 'STUDY', title: '', tip: '',
    target: 90, elapsed: 0,
    running: true,
    mmss: '00:00',
    pct: 0
  },

  onLoad(options) {
    const date = options.date || d.todayStr()
    const ss = store.sessionsOf(date) || []
    const task = ss.find(s => s._id === options.sessionId) || ss.find(s => s.status !== 'done') || ss[0]
    const subject = task ? task.subject : '其他'
    this.task = task
    this.date = date
    this.setData({
      statusBarH: theme.statusBarHeight(),
      theme: theme.get(),
      stamp: EN[subject] || 'STUDY',
      title: (EN[subject] || '') ? subject + (task && task.content ? ' · ' + task.content : '') : '自由专注',
      tip: TIPS[subject] || TIPS['其他'],
      target: task ? task.suggestedMinutes || 45 : 45
    })
  },

  onShow() {
    this._openingLog = false
    if (this._logSaved) {
      wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/today/index' }) })
      return
    }
    this.start()
  },

  onUnload() { this.stopTimer() },
  onHide() { /* 计时用绝对时间差计算，后台回来自动校正 */ },

  start() {
    if (this.timer) return
    if (this.data.running && !this._startTs) this._startTs = Date.now()
    this.timer = setInterval(() => this.tick(), 1000)
    this.tick()
  },

  stopTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  },

  tick() {
    const base = this._base || 0
    const elapsed = this.data.running && this._startTs
      ? base + Math.floor((Date.now() - this._startTs) / 1000)
      : base
    const mm = Math.floor(elapsed / 60), ss = elapsed % 60
    this.setData({
      elapsed,
      mmss: (mm < 10 ? '0' + mm : mm) + ':' + (ss < 10 ? '0' + ss : ss),
      pct: Math.min(100, Math.round(elapsed / (this.data.target * 60) * 100))
    })
  },

  toggleRun() {
    if (this.data.running) {
      this._base = (this._base || 0) + Math.floor((Date.now() - this._startTs) / 1000)
      this._startTs = null
      this.setData({ running: false })
      this.tick()
    } else {
      this._startTs = Date.now()
      this.setData({ running: true })
    }
  },

  /** 结算当前真实已过秒数（tick 间隔 1 秒，直接用 data.elapsed 会丢最后不足 1 秒的部分） */
  settle() {
    const base = this._base || 0
    return this.data.running && this._startTs
      ? base + Math.floor((Date.now() - this._startTs) / 1000)
      : base
  },

  finish() {
    if (this._openingLog || this._logSaved) return
    const total = this.settle()
    this._base = total
    this._startTs = null
    this.setData({ running: false })
    this.tick()
    this.stopTimer()
    this._openingLog = true
    wx.navigateTo({
      url: '/pages/log-edit/index?date=' + this.date +
        (this.task ? '&sessionId=' + encodeURIComponent(this.task._id) : '') +
        '&fromFocus=1&elapsedSeconds=' + total +
        '&minutes=' + Math.max(1, Math.round(total / 60)),
      events: { focusLogSaved: () => { this._logSaved = true } },
      fail: () => {
        this._openingLog = false
        this.start()
        wx.showToast({ title: '无法打开记录页，请重试', icon: 'none' })
      }
    })
  }
})

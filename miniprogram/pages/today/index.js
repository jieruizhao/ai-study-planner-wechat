const store = require('../../utils/store')
const sync = require('../../utils/sync')
const api = require('../../utils/api')
const d = require('../../utils/date')
const planner = require('../../utils/planner')
const theme = require('../../utils/theme')

const EN = { 听力: 'Listening', 阅读: 'Reading', 写作: 'Writing', 口语: 'Speaking', 单词: 'Vocab', 其他: 'Study' }
const ICON = { 听力: '🎧', 阅读: '📖', 写作: '✍️', 口语: '🗣️', 单词: '🔤', 其他: '📚' }
const TIPS = {
  听力: '先看题干预判场景，再抓同义替换。',
  阅读: '先找题干中的限定词，再回原文确认同义替换。',
  写作: '先列提纲，明确立场与段落结构。',
  口语: '先说一遍并录音，回听找问题。',
  单词: '少量多次：先复习旧的，再学新的。',
  其他: '把任务拆成 25 分钟的小块，逐个完成。'
}

Page({
  data: {
    statusBarH: 44, theme: 'light',
    dateLine: '', greeting: '', exam: null, examText: '',
    task: null, tasks: [], studyCards: [], taskIndex: 0, swiperHeight: 0,
    taskDone: false, doneCount: 0, total: 0,
    habits: [], snoozed: [],
    weekDays: 0, weekPlan: 0, focusText: '',
    pending: 0
  },

  onLoad() {
    this.setData({ statusBarH: theme.statusBarHeight() })
  },

  onShow() {
    this.setData({ theme: theme.get() })
    this.render()
    this.refresh()
  },

  render() {
    const db = store.get()
    const T = d.todayStr()
    const sessions = (db.sessions[T] || []).slice().sort((a, b) => a.order - b.order)
    const plan = db.plan
    const logs = db.logs[T] || []
    const doneCount = sessions.filter(s => s.status === 'done').length
    if (this._selectedTaskDate !== T) {
      this._selectedTaskId = null
      this._selectedTaskDate = T
    }
    const studyCards = sessions.map(s => Object.assign({}, s, {
      icon: ICON[s.subject] || '📚',
      title: (EN[s.subject] || 'Study') + ' ' + (s.content || s.subject || ''),
      tip: s.status === 'done' ? '这项任务已完成，可以查看任务记录。' : TIPS[s.subject] || TIPS['其他'],
      meta: (s.subject || '') + ' · ' + (plan ? plan.title || '我的计划' : '我的计划')
    }))
    let taskIndex = studyCards.findIndex(s => s._id === this._selectedTaskId)
    if (taskIndex < 0) taskIndex = Math.max(0, studyCards.findIndex(s => s.status !== 'done'))
    const task = studyCards[taskIndex] || null
    this._selectedTaskId = task ? task._id : null

    const exam = getApp().examCountdown()
    const examText = !exam ? '设置考试日 ›' : exam.isToday
      ? '考试日就是今天 · ' + exam.date + ' ›'
      : exam.past ? '考试日已过 · ' + exam.date + ' ›'
        : '距考试还有 ' + exam.days + ' 天 ›'

    // 本周一览
    const monday = d.startOfWeek(T)
    let weekPlan = 0, weekDays = 0, weekMin = 0
    for (let s = monday; s <= d.addDays(monday, 6); s = d.addDays(s, 1)) {
      if ((db.sessions[s] || []).length || planner.isPlannedDate(s, plan)) weekPlan++
      if (s <= T) {
        const ss = db.sessions[s] || []
        const dd = ss.length && ss.every(x => x.status === 'done')
        const hasLog = (db.logs[s] || []).length > 0
        if (dd || hasLog) weekDays++
        (db.logs[s] || []).forEach(l => { weekMin += l.durationMinutes || 0 })
      }
    }

    const snoozed = (db.snooze && db.snooze[T]) || []
    const wd = d.weekdayOf(T)
    this.setData({
      dateLine: d.fmtCN(T) + ' · 星期' + '一二三四五六日'[wd - 1],
      greeting: getApp().greeting(),
      exam,
      examText,
      emptyLabel: !plan ? '尚未创建计划' : planner.isPlannedDate(T, plan) ? '暂无任务' : '休息日',
      task, studyCards, taskIndex,
      taskDone: sessions.length > 0 && doneCount === sessions.length,
      tasks: sessions.map(s => Object.assign({}, s, {
        icon: ICON[s.subject] || '📚',
        title: (s.subject || '学习') + (s.content ? ' · ' + s.content : ''),
        statusText: s.status === 'done' ? '已完成' : '待学习'
      })),
      doneCount, total: sessions.length,
      todayMinutes: logs.reduce((t, l) => t + (l.durationMinutes || 0), 0),
      habits: (db.habits || []).filter(h => {
        if (!h.enabled) return false
        if (h.date && h.date !== T) return false
        const ws = h.weekdays && h.weekdays.length ? h.weekdays : [1, 2, 3, 4, 5, 6, 7]
        return ws.indexOf(wd) >= 0
      }).map(h => ({
        _id: h._id, icon: h.icon || '◎', name: h.name,
        note: h.reminderTime ? '提醒 ' + h.reminderTime : '由你设置的日常提醒',
        st: (db.habitLogs[T] || {})[h._id] || 'none',
        snoozed: snoozed.indexOf(h._id) >= 0
      })),
      snoozed,
      weekDays, weekPlan,
      focusText: Math.floor(weekMin / 60) + 'h' + (weekMin % 60 ? (weekMin % 60) + 'm' : ''),
      pending: sync.pendingCount()
    })
    this.measureStudyCards()
  },

  onTaskChange(e) {
    // 只接收手势切换，避免程序更新 current 后反复触发 setData。
    if (e.detail.source !== 'touch') return
    const index = Number(e.detail.current), task = this.data.studyCards[index]
    if (!Number.isInteger(index) || !task) return
    this._selectedTaskId = task._id
    this._selectedTaskDate = d.todayStr()
    this.setData({ taskIndex: index, task })
  },

  measureStudyCards() {
    if (typeof wx.createSelectorQuery !== 'function') return
    const measure = () => {
      wx.createSelectorQuery().in(this).selectAll('.study-card').boundingClientRect(rects => {
        const height = Math.ceil(Math.max(0, ...(rects || []).map(rect => rect.height || 0)))
        if (height && height !== this.data.swiperHeight) this.setData({ swiperHeight: height })
      }).exec()
    }
    if (typeof wx.nextTick === 'function') wx.nextTick(measure)
    else setTimeout(measure, 0)
  },

  async refresh() {
    await sync.flush().catch(() => {})
    try {
      const from = d.startOfWeek(d.todayStr())
      const res = await api.call('plan', 'getRange', { from, to: d.addDays(from, 6) }, { silent: true })
      const habits = await api.call('habit', 'listAll', {}, { silent: true }).catch(() => null)
      if (habits) store.applyServerBuckets({ habits: habits.habits })
      store.applyServerBuckets(res.buckets)
    } catch (e) { /* 离线兜底 */ }
    this.render()
  },

  toggleTheme() {
    this.setData({ theme: theme.toggle() })
  },

  goHabits() { wx.navigateTo({ url: '/pages/habits/index' }) },
  goReview() { wx.switchTab({ url: '/pages/review/index' }) },

  goToday() { wx.navigateTo({ url: '/pages/day/index?date=' + d.todayStr() }) },
  goTaskRecords(e) {
    const id = e && e.currentTarget && e.currentTarget.dataset.id || (this.data.task && this.data.task._id)
    if (!id) return
    wx.navigateTo({ url: '/pages/task-records/index?date=' + d.todayStr() + '&sessionId=' + encodeURIComponent(id) })
  },

  openTask(e) {
    const id = e.currentTarget.dataset.id
    const task = this.data.tasks.find(s => s._id === id)
    if (!task) return
    const page = task.status === 'done' ? 'log-edit' : 'focus'
    wx.navigateTo({ url: '/pages/' + page + '/index?date=' + d.todayStr() + '&sessionId=' + encodeURIComponent(id) })
  },

  startFocus(e) {
    const id = e && e.currentTarget && e.currentTarget.dataset.id || this._selectedTaskId
    const t = store.sessionsOf(d.todayStr()).find(s => s._id === id)
    if (!t) return this.render()
    if (t.status === 'done') return this.goTaskRecords({ currentTarget: { dataset: { id: t._id } } })
    wx.navigateTo({ url: '/pages/focus/index?date=' + d.todayStr() + '&sessionId=' + encodeURIComponent(t._id) })
  },

  quickLog(e) {
    const sessions = store.sessionsOf(d.todayStr()).slice().sort((a, b) => a.order - b.order)
    const id = e && e.currentTarget && e.currentTarget.dataset.id || this._selectedTaskId
    const selected = sessions.find(s => s._id === id)
    if (id && !selected) return this.render()
    const task = selected || sessions.find(s => s.status !== 'done')
    wx.navigateTo({ url: '/pages/log-edit/index?date=' + d.todayStr() + (task ? '&sessionId=' + encodeURIComponent(task._id) : '') })
  },

  onExam(e) {
    const examDate = e.detail.value
    const db = store.get()
    db.profile = Object.assign({}, db.profile || {}, { examDate })
    store.persist()
    sync.enqueue('profile.update', { examDate })
    this.render()
  },

  // 习惯三态：完成 / 稍后 / 未记录
  habitDone(e) {
    const id = e.currentTarget.dataset.id
    const cur = (store.habitLogOf(d.todayStr()) || {})[id]
    store.setHabitLog(d.todayStr(), id, cur === 'done' ? 'none' : 'done')
    sync.enqueue('habit.log', { habitId: id, date: d.todayStr(), status: cur === 'done' ? 'none' : 'done' })
    this.clearSnooze(id)
    this.render()
  },

  habitSnooze(e) {
    const id = e.currentTarget.dataset.id
    const db = store.get()
    if (!db.snooze) db.snooze = {}
    const list = db.snooze[d.todayStr()] || []
    const i = list.indexOf(id)
    if (i >= 0) list.splice(i, 1); else list.push(id)
    db.snooze[d.todayStr()] = list
    if (i < 0) {
      store.setHabitLog(d.todayStr(), id, 'none')
      sync.enqueue('habit.log', { habitId: id, date: d.todayStr(), status: 'none' })
    }
    store.persist()
    this.render()
  },

  habitClear(e) {
    const id = e.currentTarget.dataset.id
    store.setHabitLog(d.todayStr(), id, 'none')
    sync.enqueue('habit.log', { habitId: id, date: d.todayStr(), status: 'none' })
    this.clearSnooze(id)
    this.render()
  },

  clearSnooze(id) {
    const db = store.get()
    if (db.snooze) db.snooze[d.todayStr()] = (db.snooze[d.todayStr()] || []).filter(x => x !== id)
    store.persist()
  }
})

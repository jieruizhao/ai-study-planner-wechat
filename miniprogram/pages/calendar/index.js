const store = require('../../utils/store')
const sync = require('../../utils/sync')
const api = require('../../utils/api')
const d = require('../../utils/date')
const planner = require('../../utils/planner')
const theme = require('../../utils/theme')

const EN = { 听力: 'Listening', 阅读: 'Reading', 写作: 'Writing', 口语: 'Speaking', 单词: 'Vocab', 其他: 'Study' }

// 状态 → 月历符号与颜色
function symOf(state) {
  if (state === 'done') return { s: '✓', cls: 'sy-done' }
  if (state === 'partial') return { s: '◐', cls: 'sy-part' }
  if (state === 'missed') return { s: '·', cls: 'sy-miss' }
  if (state === 'plan-logged' || state === 'logged') return { s: '·', cls: 'sy-logged' }
  if (state === 'rest') return { s: '—', cls: 'sy-rest' }
  if (state === 'future-plan') return { s: '—', cls: 'sy-future' }
  return { s: '', cls: '' }
}

Page({
  data: {
    statusBarH: 44, theme: 'light',
    ym: '', ymText: '',
    weekHeads: ['一', '二', '三', '四', '五', '六', '日'],
    cells: [], today: '',
    todayRow: null, todayTasks: [], todayLogs: [], todayHabits: [], todayDoneCount: 0, todayMinutes: 0
  },

  onLoad() { this.setData({ statusBarH: theme.statusBarHeight() }) },

  onShow() {
    this.setData({ theme: theme.get() })
    if (!this.data.ym) this.setData({ ym: d.monthOf(d.todayStr()) })
    this.render()
    this.refresh(this.data.ym)
  },

  render() {
    const db = store.get()
    const T = d.todayStr()
    const ctx = { plan: db.plan, sessions: db.sessions, logs: db.logs, today: T }
    const [y, m] = this.data.ym.split('-').map(Number)
    const first = this.data.ym + '-01'
    const lead = d.weekdayOf(first) - 1
    const total = d.daysInMonth(this.data.ym)
    const cells = []
    for (let i = 0; i < 42; i++) {
      const dayNo = i - lead + 1
      let date
      if (dayNo < 1) date = d.addDays(first, dayNo - 1)
      else if (dayNo > total) date = d.addDays(first, dayNo - 1)
      else date = this.data.ym + '-' + d.pad(dayNo)
      const dim = dayNo < 1 || dayNo > total
      const st = dim ? '' : planner.computeDateState(date, ctx)
      const sym = dim ? { s: '', cls: '' } : symOf(st)
      cells.push({
        date, day: Number(date.slice(8, 10)), dim,
        sym: sym.s, symCls: sym.cls,
        isToday: date === T
      })
    }
    // 今日摘要行
    let todayRow = null
    let todayTasks = [], todayLogs = [], todayHabits = [], todayDoneCount = 0, todayMinutes = 0
    if (d.monthOf(T) === this.data.ym) {
      const ss = (db.sessions[T] || []).slice().sort((a, b) => a.order - b.order)
      const logs = db.logs[T] || []
      todayTasks = ss.map(s => Object.assign({}, s, { title: ((EN[s.subject] || s.subject || '') + ' ' + (s.content || '')).trim() }))
      todayLogs = logs.slice().reverse()
      todayDoneCount = ss.filter(s => s.status === 'done').length
      todayMinutes = logs.reduce((sum, l) => sum + (Number(l.durationMinutes) || 0), 0)
      todayHabits = (db.habits || []).filter(h => h.enabled !== false && (!h.date || h.date === T) &&
        (h.weekdays && h.weekdays.length ? h.weekdays : [1, 2, 3, 4, 5, 6, 7]).includes(d.weekdayOf(T))).map(h => {
        const st = (db.habitLogs[T] || {})[h._id] || 'none'
        return Object.assign({}, h, { st, statusText: st === 'done' ? '已完成' : st === 'skipped' ? '已跳过' : '未记录' })
      })
      const first2 = ss.find(s => s.status !== 'done') || ss[0]
      if (first2) {
        todayRow = {
          day: Number(T.slice(8, 10)),
          week: '星期' + '一二三四五六日'[d.weekdayOf(T) - 1],
          title: (EN[first2.subject] || '') + ' ' + (first2.content || ''),
          sub: logs.length ? '已记录 ' + logs.length + ' 条 · 共 ' + todayMinutes + ' 分钟'
            : '计划 ' + first2.suggestedMinutes + ' 分钟 · 等待记录'
        }
      } else {
        todayRow = {
          day: Number(T.slice(8, 10)),
          week: '星期' + '一二三四五六日'[d.weekdayOf(T) - 1],
          title: (db.plan && !planner.isPlannedDate(T, db.plan)) ? '今天是休息日' : '今天没有安排任务',
          sub: logs.length ? '已记录 ' + logs.length + ' 条' : '按自己的节奏，随时记一笔'
        }
      }
    }
    this.setData({ ymText: y + '年 ' + m + '月', cells, today: T, todayRow, todayTasks, todayLogs, todayHabits, todayDoneCount, todayMinutes })
  },

  async refresh(ym) {
    await sync.flush().catch(() => {})
    const from = ym + '-01', to = ym + '-' + d.pad(d.daysInMonth(ym))
    try {
      const [res, habits] = await Promise.all([
        api.call('plan', 'getRange', { from, to }, { silent: true }),
        api.call('habit', 'listAll', {}, { silent: true }).catch(() => null)
      ])
      store.applyServerBuckets(res.buckets)
      if (habits && habits.habits) store.applyServerBuckets({ habits: habits.habits })
    } catch (e) { /* 离线兜底 */ }
    this.render()
  },

  prev() { this.switch(-1) },
  next() { this.switch(1) },
  switch(n) {
    const [y, m] = this.data.ym.split('-').map(Number)
    const dt = new Date(y, m - 1 + n, 1)
    const ym = dt.getFullYear() + '-' + d.pad(dt.getMonth() + 1)
    this.setData({ ym })
    this.render()
    this.refresh(ym)
  },

  tapDay(e) {
    const date = e.currentTarget.dataset.date
    if (date) wx.navigateTo({ url: '/pages/day/index?date=' + date })
  },
  tapToday() { wx.navigateTo({ url: '/pages/day/index?date=' + d.todayStr() }) }
})

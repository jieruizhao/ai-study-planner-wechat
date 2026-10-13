const store = require('../../utils/store')
const sync = require('../../utils/sync')
const api = require('../../utils/api')
const d = require('../../utils/date')
const theme = require('../../utils/theme')

const EN = {
  听力: 'Listening',
  阅读: 'Reading',
  写作: 'Writing',
  口语: 'Speaking',
  单词: 'Vocab',
  其他: 'Study',
}

Page({
  data: {
    statusBarH: 44,
    theme: 'light',
    range: 'week',
    rangeLabel: '这一周',
    from: '',
    to: '',
    fromTo: '',
    ongoing: true,
    days: 0,
    planDays: 0,
    minutesText: '',
    progressPct: 0,
    progressNote: '',
    rhythm: [],
    rhythmMode: 'week',
    mainText: '—',
    logCount: 0,
    habitText: '—',
    summary: null,
    subjectStats: [],
    today: '',
    rangeError: '',
    goal: '',
    planStart: '',
    planDaysInput: 7,
    dailyMinutes: 60,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    consent: false,
    analyzing: false,
    planBusy: false,
    coachError: '',
    importError: '',
    historyError: '',
    batchError: '',
    report: null,
    tasks: [],
    habits: [],
    reports: [],
    batches: [],
  },

  onLoad() {
    this.setData({
      statusBarH: theme.statusBarHeight(),
      today: d.todayStr(),
      planStart: d.addDays(d.todayStr(), 1),
    })
  },

  onShow() {
    this.setData({ today: d.todayStr() })
    if (this._coachOwner !== store.get()) {
      this._coachOwner = store.get()
      this.clearAnalysis()
      this.setData({
        reports: [],
        batches: [],
        consent: false,
        historyError: '',
        batchError: '',
      })
    }
    const previousRange = this.data.from + this.data.to
    this.setData({ theme: theme.get() })
    this.compute()
    if (previousRange !== this.data.from + this.data.to) this.clearAnalysis()
    this.renderLocal()
    this.refresh()
    this.loadHistory()
  },

  compute() {
    const T = d.todayStr()
    let from, to
    if (this.data.range === 'custom') {
      from = this.data.from || T
      to = this.data.to || T
    } else {
      from = d.addDays(T, this.data.range === 'week' ? -6 : -29)
      to = T
    }
    this.setData({
      from,
      to,
      fromTo: d.fmtCN(from).replace('月', '月') + ' — ' + d.fmtCN(to),
      rangeLabel:
        this.data.range === 'custom'
          ? '所选日期'
          : this.data.range === 'week'
            ? '最近7天'
            : '最近30天',
      ongoing: to >= T,
      rhythmMode: this.data.range,
    })
  },

  switchRange(e) {
    if (this.data.analyzing || this.data.planBusy) return
    this.setData({ range: e.currentTarget.dataset.r })
    this.clearAnalysis()
    this.compute()
    this.renderLocal()
    this.refresh()
  },

  renderLocal() {
    const db = store.get()
    const { from, to } = this.data
    const logs = []
    for (let s = from; s <= to; s = d.addDays(s, 1))
      (db.logs[s] || []).forEach((l) => logs.push(l))
    this.apply(logs)
  },

  async refresh() {
    const from = this.data.from,
      to = this.data.to,
      key = from + to
    await sync.flush().catch(() => {})
    try {
      const res = await api.call(
        'plan',
        'getRange',
        { from, to },
        { silent: true },
      )
      if (key !== this.data.from + this.data.to) return
      store.applyServerBuckets(res.buckets)
      this.renderLocal()
      const stats = await api.call(
        'coach',
        'overview',
        { from, to },
        { silent: true },
      )
      if (key === this.data.from + this.data.to)
        this.setData({
          summary: stats.summary,
          rangeError: '',
          subjectStats: Object.keys(stats.summary.byType).map((type) => ({
            label:
              {
                reading: '阅读',
                listening: '听力',
                writing: '写作',
                speaking: '口语',
                vocab: '词汇',
                other: '其他',
              }[type] || type,
            minutes: stats.summary.byType[type],
          })),
        })
    } catch (e) {
      /* 离线兜底 */
    }
  },

  clearAnalysis() {
    this.setData({
      report: null,
      tasks: [],
      habits: [],
      summary: null,
      subjectStats: [],
      coachError: '',
      importError: '',
    })
  },
  dateChanged(e) {
    if (this.data.analyzing || this.data.planBusy) return
    const field = e.currentTarget.dataset.field,
      value = e.detail.value
    const from = field === 'from' ? value : this.data.from,
      to = field === 'to' ? value : this.data.to
    if (
      from > to ||
      to > d.todayStr() ||
      (Date.parse(to) - Date.parse(from)) / 86400000 > 120
    )
      return this.setData({
        rangeError: '开始日期不能晚于结束日期，最多选择120天且不含未来',
      })
    this.setData({ [field]: value, range: 'custom', rangeError: '' })
    this.clearAnalysis()
    this.compute()
    this.renderLocal()
    this.refresh()
  },
  setting(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },
  weekdaysChanged(e) {
    this.setData({ weekdays: e.detail.value.map(Number) })
  },
  consentChanged(e) {
    this.setData({ consent: e.detail.value })
  },
  async loadHistory() {
    try {
      const h = await api.call('coach', 'history', {}, { silent: true })
      this.setData({ reports: h.reports, batches: h.batches })
    } catch (e) {}
  },
  async analyze() {
    if (this.data.analyzing || this.data.planBusy) return
    if (!this.data.consent)
      return this.setData({ coachError: '请先同意使用所选学习数据进行AI分析' })
    const previousIds = new Set(this.data.reports.map((r) => r._id))
    const requested = {
      from: this.data.from,
      to: this.data.to,
      startDate: this.data.planStart,
      days: Number(this.data.planDaysInput),
      dailyMinutes: Number(this.data.dailyMinutes),
      goal: this.data.goal,
      weekdays: this.data.weekdays.slice(),
    }
    this.setData({
      analyzing: true,
      coachError: '',
      report: null,
      tasks: [],
      habits: [],
    })
    try {
      const syncResult = await sync.flush()
      if (syncResult.remain) throw new Error('请先同步未保存的学习记录')
      const r = await api.call(
        'coach',
        'analyze',
        {
          from: this.data.from,
          to: this.data.to,
          startDate: this.data.planStart,
          days: Number(this.data.planDaysInput),
          dailyMinutes: Number(this.data.dailyMinutes),
          weekdays: this.data.weekdays,
          goal: this.data.goal,
          consent: true,
        },
        { silent: true },
      )
      this.showReport(r.report)
      await this.loadHistory()
    } catch (e) {
      if (
        /timeout|timed.?out|超时/i.test(String(e.errMsg || e.message || ''))
      ) {
        // 传输超时不能断言后端失败；先恢复已保存的本次结果，不重发模型请求。
        await this.loadHistory()
        const recovered = this.data.reports.find(
          (r) =>
            !previousIds.has(r._id) &&
            r.from === requested.from &&
            r.to === requested.to &&
            r.settings &&
            r.settings.startDate === requested.startDate &&
            r.settings.days === requested.days &&
            r.settings.dailyMinutes === requested.dailyMinutes &&
            r.settings.goal === (requested.goal || '形成可持续学习习惯') &&
            JSON.stringify(r.settings.weekdays.slice().sort()) ===
              JSON.stringify(requested.weekdays.slice().sort()),
        )
        if (recovered) {
          this.showReport(recovered)
          return
        }
        this.setData({
          coachError:
            e.code === 504
              ? e.message
              : '分析请求等待超时，结果尚未确认。请稍后返回本页查看历史分析，避免连续重复生成。',
        })
        return
      }
      this.setData({
        coachError:
          e.code === 404
            ? '请部署新版api和studyAgent云函数'
            : e.message || 'AI分析失败，请重试',
      })
    } finally {
      this.setData({ analyzing: false })
    }
  },
  showReport(report) {
    this.setData({
      report,
      importError: '',
      tasks: JSON.parse(JSON.stringify(report.tasks)),
      habits: JSON.parse(JSON.stringify(report.habits)),
      coachError: '',
    })
  },
  openReport(e) {
    if (this.data.analyzing || this.data.planBusy) return
    const report = this.data.reports.find(
      (r) => r._id === e.currentTarget.dataset.id,
    )
    if (report) this.showReport(report)
  },
  editTask(e) {
    const field = e.currentTarget.dataset.field,
      index = Number(e.currentTarget.dataset.index)
    this.setData({ ['tasks[' + index + '].' + field]: e.detail.value })
  },
  editHabit(e) {
    this.setData({
      ['habits[' + Number(e.currentTarget.dataset.index) + '].name']:
        e.detail.value,
    })
  },
  editHabitDays(e) {
    const weekdays = String(e.detail.value)
      .split(/[,，\s]+/)
      .filter(Boolean)
      .map(Number)
    this.setData({
      ['habits[' + Number(e.currentTarget.dataset.index) + '].weekdays']:
        weekdays,
    })
  },
  removeSuggestion(e) {
    if (this.data.planBusy) return
    const kind = e.currentTarget.dataset.kind
    this.setData({
      [kind]: this.data[kind].filter(
        (x, i) => i !== Number(e.currentTarget.dataset.index),
      ),
    })
  },
  async reloadImported(from, to) {
    const db = store.get()
    db.scheduleRevision = (db.scheduleRevision || 0) + 1
    store.persist()
    const result = await api.call(
      'plan',
      'getRange',
      { from, to },
      { silent: true },
    )
    store.applyServerBuckets(result.buckets)
    const habits = await api.call('habit', 'listAll', {}, { silent: true })
    store.applyServerBuckets({ habits: habits.habits })
    await this.loadHistory()
    await this.refresh()
  },
  importSuggestions() {
    if (this.data.planBusy || !this.data.report) return
    return wx.showModal({
      title: '导入建议计划？',
      content:
        '保留原有任务，新增当前预览中的任务和日常习惯。习惯将持续生效，不自动开启通知。',
      success: async (res) => {
        if (!res.confirm || this.data.planBusy) return
        this.setData({ planBusy: true, importError: '' })
        try {
          const synced = await sync.flush()
          if (synced.remain) throw new Error('请先完成数据同步')
          const r = await api.call(
            'coach',
            'importPlan',
            {
              reportId: this.data.report._id,
              tasks: this.data.tasks,
              habits: this.data.habits,
            },
            { silent: true },
          )
          await this.reloadImported(r.batch.from, r.batch.to)
          wx.showToast({ title: '建议计划已导入', icon: 'success' })
        } catch (e) {
          this.setData({
            importError: e.message || '导入失败；请刷新确认后重试',
          })
        } finally {
          this.setData({ planBusy: false })
        }
      },
    })
  },
  deleteReport(e) {
    if (this.data.analyzing || this.data.planBusy) return
    const id = e.currentTarget.dataset.id
    const item = this.data.reports.find((r) => r._id === id)
    if (!item) return
    return wx.showModal({
      title: '删除这份分析历史？',
      content:
        '删除后不再显示这份分析，已导入的任务、习惯和学习记录会保留，导入历史仍可撤销。',
      success: async (res) => {
        if (!res.confirm || this.data.analyzing || this.data.planBusy) return
        this.setData({ planBusy: true, historyError: '' })
        try {
          await api.call(
            'coach',
            'deleteReport',
            { reportId: id },
            { silent: true },
          )
          this.setData({
            reports: this.data.reports.filter((r) => r._id !== id),
          })
          if (this.data.report && this.data.report._id === id)
            this.setData({
              report: null,
              tasks: [],
              habits: [],
              importError: '',
            })
          await this.loadHistory()
          wx.showToast({ title: '分析历史已删除', icon: 'success' })
        } catch (error) {
          this.setData({
            historyError: error.message || '删除失败，请刷新确认后重试',
          })
        } finally {
          this.setData({ planBusy: false })
        }
      },
    })
  },
  deleteBatch(e) {
    if (this.data.analyzing || this.data.planBusy) return
    const id = e.currentTarget.dataset.id
    const batch = this.data.batches.find((b) => b._id === id)
    if (!batch) return
    return wx.showModal({
      title: '删除这条导入历史？',
      content:
        batch.status === 'imported'
          ? '仅删除历史展示，已导入的任务、习惯和学习记录会保留。删除后该列表不再提供这次导入的撤销入口。'
          : '仅删除历史展示，已撤销状态和保留的学习记录不受影响。',
      success: async (res) => {
        if (!res.confirm || this.data.analyzing || this.data.planBusy) return
        this.setData({ planBusy: true, batchError: '' })
        try {
          await api.call(
            'coach',
            'deleteBatch',
            { batchId: id },
            { silent: true },
          )
          this.setData({
            batches: this.data.batches.filter((b) => b._id !== id),
          })
          await this.loadHistory()
          wx.showToast({ title: '导入历史已删除', icon: 'success' })
        } catch (error) {
          this.setData({
            batchError: error.message || '删除失败，请刷新确认后重试',
          })
        } finally {
          this.setData({ planBusy: false })
        }
      },
    })
  },
  undoBatch(e) {
    if (this.data.planBusy) return
    const batch = this.data.batches.find(
      (b) => b._id === e.currentTarget.dataset.id,
    )
    if (!batch) return
    return wx.showModal({
      title: '撤销本次导入？',
      content: '保留已完成、有学习记录或已修改的项，只撤销未使用的建议。',
      success: async (res) => {
        if (!res.confirm || this.data.planBusy) return
        this.setData({ planBusy: true, batchError: '' })
        try {
          const synced = await sync.flush()
          if (synced.remain) throw new Error('请先完成数据同步')
          const r = await api.call(
            'coach',
            'undo',
            { batchId: batch._id },
            { silent: true },
          )
          await this.reloadImported(batch.from, batch.to)
          wx.showModal({
            title: '已撤销',
            content: '移除 ' + r.removed + ' 项，保留 ' + r.kept + ' 项。',
            showCancel: false,
          })
        } catch (e) {
          this.setData({ batchError: e.message || '撤销失败，请重试' })
        } finally {
          this.setData({ planBusy: false })
        }
      },
    })
  },

  apply(logs) {
    const db = store.get()
    const { from, to, range } = this.data
    const T = d.todayStr()
    const byDate = {},
      byType = {},
      byHabit = {}
    let total = 0
    logs = logs.filter((l) => l.date <= T)
    const typeNames = {
      listening: '听力',
      reading: '阅读',
      writing: '写作',
      speaking: '口语',
      vocab: '单词',
      other: '其他',
    }
    logs.forEach((l) => {
      total += l.durationMinutes || 0
      byDate[l.date] = (byDate[l.date] || 0) + (l.durationMinutes || 0)
      byType[l.subject || l.typeLabel || typeNames[l.type] || '其他'] =
        (byType[l.subject || l.typeLabel || typeNames[l.type] || '其他'] || 0) +
        (l.durationMinutes || 0)
    })
    // 学习日：有记录或任务全部完成
    let days = 0,
      planDays = 0
    const rhythm = []
    for (let s = from; s <= to; s = d.addDays(s, 1)) {
      const isPlan =
        (db.sessions[s] || []).length > 0 || planner_isPlanned(s, db.plan)
      if (isPlan) planDays++
      const ss = db.sessions[s] || []
      const allDone = ss.length > 0 && ss.every((x) => x.status === 'done')
      const hasLog = (byDate[s] || 0) > 0
      if (s <= T && (hasLog || allDone)) days++
      // 节奏符号
      let st = 'blank',
        sym = '',
        cls = ''
      if (s > T) {
        st = 'future'
        sym = ''
        cls = 'dot-future'
      } else if (allDone) {
        st = 'done'
        sym = '✓'
        cls = 'dot-done'
      } else if (ss.length && ss.some((x) => x.status === 'done')) {
        st = 'part'
        sym = '◐'
        cls = 'dot-part'
      } else if (hasLog) {
        st = 'log'
        sym = '·'
        cls = 'dot-log'
      } else if (isPlan) {
        st = 'miss'
        sym = '·'
        cls = 'dot-miss'
      } else {
        st = 'rest'
        sym = '—'
        cls = 'dot-rest'
      }
      rhythm.push({
        date: s,
        day: Number(s.slice(8, 10)),
        lab: '一二三四五六日'[d.weekdayOf(s) - 1],
        sym,
        cls,
        future: s > T,
      })
    }
    // 习惯完成统计（本周期内）
    const habitCount = {}
    for (let s = from; s <= to; s = d.addDays(s, 1)) {
      const hl = db.habitLogs[s] || {}
      Object.keys(hl).forEach((hid) => {
        if (hl[hid] !== 'done') return
        const h = db.habits.find((x) => x._id === hid)
        if (h) habitCount[h.name] = (habitCount[h.name] || 0) + 1
      })
    }
    const habitText = Object.keys(habitCount).length
      ? Object.keys(habitCount)
          .map((n) => n + ' ' + habitCount[n] + ' 次')
          .join(' · ')
      : '—'
    // 主要内容：累计时长最长的主题
    let mainText = '—',
      best = 0
    Object.keys(byType).forEach((k) => {
      if (byType[k] > best) {
        best = byType[k]
        mainText = k
      }
    })
    const h = Math.floor(total / 60),
      m = total % 60
    const pct = planDays
      ? Math.min(100, Math.round((days / planDays) * 100))
      : logs.length
        ? 100
        : 0
    const pctNote = planDays
      ? '计划 ' +
        planDays +
        ' 天 · ' +
        (pct >= 100 ? '已全部完成' : pct >= 50 ? '已完成一半' : '刚开始')
      : logs.length
        ? '自由记录中'
        : '还没有记录'
    this.setData({
      days,
      planDays,
      minutesText: (h ? h + '小时' : '') + (m || !h ? m + '分钟' : ''),
      progressPct: pct,
      progressNote: pctNote,
      rhythm,
      mainText,
      logCount: logs.length,
      habitText,
    })
  },
})

function planner_isPlanned(date, plan) {
  return require('../../utils/planner').isPlannedDate(date, plan)
}

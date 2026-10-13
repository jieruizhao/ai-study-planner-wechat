const store = require('../../utils/store')
const sync = require('../../utils/sync')
const api = require('../../utils/api')
const d = require('../../utils/date')
const planner = require('../../utils/planner')
const theme = require('../../utils/theme')

const EN = { 听力: 'Listening', 阅读: 'Reading', 写作: 'Writing', 口语: 'Speaking', 单词: 'Vocab', 其他: 'Study' }
const ICON = { 听力: '🎧', 阅读: '📖', 写作: '✍️', 口语: '🗣️', 单词: '🔤', 其他: '📚' }

Page({
  data: {
    statusBarH: 44, theme: 'light',
    date: '', topWeek: '', topDate: '', isFuture: false, isToday: false,
    plan: [], planEmpty: '', rest: false,
    logs: [], logCount: 0, totalMinutes: 0,
    habitItems: [],
    addTaskShow: false, taskSaving: false, taskError: '', editingTaskId: '', taskActionError: '',
    subjects: ['阅读', '听力', '写作', '口语', '单词', '其他'],
    taskSubjectIndex: 0, taskContent: '', taskMinutes: 30
  },

  onLoad(options) {
    const date = options.date || d.todayStr()
    this.setData({ date, statusBarH: theme.statusBarHeight() })
  },

  onShow() {
    this.setData({ theme: theme.get() })
    this.render()
    this.refresh()
  },

  render() {
    const db = store.get()
    const date = this.data.date
    const T = d.todayStr()
    const ss = (db.sessions[date] || []).slice().sort((a, b) => a.order - b.order)
    const logs = (db.logs[date] || []).slice().reverse()
    const wd = d.weekdayOf(date)
    const rest = !ss.length && db.plan ? !planner.isPlannedDate(date, db.plan) : false
    this.setData({
      topWeek: (date === T ? '今天' : d.fmtCN(date)) + ' · 星期' + '一二三四五六日'[wd - 1],
      topDate: d.fmtCN(date),
      isFuture: date > T,
      isToday: date === T,
      rest,
      planEmpty: rest ? '休息日 · 没有安排任务' : '这一天没有安排任务',
      plan: ss.map(s => ({
        _id: s._id, date: s.date, status: s.status,
        icon: ICON[s.subject] || '📚',
        title: (EN[s.subject] || '') + ' ' + (s.content || s.subject || ''),
        sub: '建议 ' + s.suggestedMinutes + ' 分钟' + (db.plan && db.plan.title ? ' · ' + db.plan.title : '')
      })),
      logs, logCount: logs.length,
      totalMinutes: logs.reduce((t, l) => t + (l.durationMinutes || 0), 0),
      habitItems: (db.habits || []).filter(h => {
        if (!h.enabled || (h.date && h.date !== date)) return false
        const ws = h.weekdays && h.weekdays.length ? h.weekdays : [1, 2, 3, 4, 5, 6, 7]
        return ws.indexOf(wd) >= 0
      }).map(h => ({
        _id: h._id, name: h.name, time: h.reminderTime || '', once: !!h.date,
        st: (db.habitLogs[date] || {})[h._id] || 'none'
      }))
    })
  },

  async refresh() {
    await sync.flush().catch(() => {})
    try {
      const [res, habitRes] = await Promise.all([
        api.call('plan', 'getDay', { date: this.data.date }, { silent: true }),
        api.call('habit', 'listAll', {}, { silent: true }).catch(() => null)
      ])
      store.applyServerBuckets(res.buckets)
      if (habitRes) store.applyServerBuckets({ habits: habitRes.habits })
    } catch (e) { /* 离线兜底 */ }
    this.render()
  },

  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/calendar/index' }) }) },
  addReminder() {
    if (this.data.date < d.todayStr()) return wx.showToast({ title: '过去日期不能新增提醒', icon: 'none' })
    wx.navigateTo({ url: '/pages/habit-edit/index?date=' + this.data.date })
  },
  editReminder(e) { wx.navigateTo({ url: '/pages/habit-edit/index?id=' + encodeURIComponent(e.currentTarget.dataset.id) }) },

  openAddTask() {
    if (this.data.taskSaving) return
    this._addRequestId = sync.genId()
    this._editingTask = null
    this.setData({ addTaskShow: true, editingTaskId: '', taskError: '', taskActionError: '', taskSubjectIndex: 0, taskContent: '', taskMinutes: 30 })
  },

  editTask(e) {
    if (this.data.taskSaving) return
    const task = store.sessionsOf(this.data.date).find(s => s._id === e.currentTarget.dataset.id)
    if (!task) return
    if (task.status === 'done') return wx.showToast({ title: '已完成任务仅支持删除', icon: 'none' })
    this._editingTask = Object.assign({}, task)
    const subjects = ['阅读', '听力', '写作', '口语', '单词', '其他']
    if (subjects.indexOf(task.subject) < 0) subjects.push(task.subject)
    this.setData({ addTaskShow: true, editingTaskId: task._id, taskError: '', taskActionError: '',
      subjects, taskSubjectIndex: subjects.indexOf(task.subject), taskContent: task.content || task.subject,
      taskMinutes: task.suggestedMinutes })
  },

  removeTask(e) {
    if (this.data.taskSaving || this._deleteConfirming) return
    const task = store.sessionsOf(this.data.date).find(s => s._id === e.currentTarget.dataset.id)
    if (!task) return
    this._deleteConfirming = true
    return wx.showModal({
      title: '删除这条任务？',
      content: '删除 ' + this.data.date + ' 的“' + (task.content || task.subject) + '”？已有学习记录会保留。',
      confirmText: '删除', confirmColor: '#B04A3A',
      success: res => { this._deleteConfirming = false; if (res.confirm) return this.deleteTask(task) },
      fail: () => { this._deleteConfirming = false }
    })
  },

  async deleteTask(task) {
    if (this.data.taskSaving) return
    this.setData({ taskSaving: true, taskActionError: '' })
    wx.showLoading({ title: '删除任务中…', mask: true })
    try {
      const flushed = await sync.flush()
      if (flushed.remain) throw new Error('还有未同步的改动，请先完成同步')
      const result = await api.call('plan', 'removeSession', { sessionId: task._id, date: task.date, baseVersion: task.version }, { silent: true })
      if (!result || !result.deleted || result.sessionId !== task._id) throw new Error('删除结果不完整，请刷新确认')
      const db = store.get()
      db.scheduleRevision = (db.scheduleRevision || 0) + 1
      store.applyServerBuckets({ sessions: { [task.date]: store.sessionsOf(task.date).filter(s => s._id !== task._id) } })
      this.render()
      getApp().refreshViews()
      wx.hideLoading()
      wx.showToast({ title: '任务已删除', icon: 'success' })
    } catch (e) {
      const message = e.code === 409 ? '任务已被修改，请刷新后重试删除' : e.code === 404 ? '请确认任务存在并已部署新版 api' : (e.message || '删除失败，请重试')
      this.setData({ taskActionError: message })
      wx.showModal({ title: '未能删除任务', content: message, showCancel: false })
    } finally { wx.hideLoading(); this.setData({ taskSaving: false }) }
  },

  closeAddTask() { if (!this.data.taskSaving) this.setData({ addTaskShow: false }) },
  noop() {},
  onTaskSubject(e) { this.setData({ taskSubjectIndex: Number(e.detail.value) }) },
  onTaskContent(e) { this.setData({ taskContent: e.detail.value }) },
  onTaskMinutes(e) { this.setData({ taskMinutes: e.detail.value }) },

  async saveTask() {
    if (this.data.taskSaving || !this.data.addTaskShow) return
    const content = this.data.taskContent.trim()
    const minutes = Number(this.data.taskMinutes)
    if (!content) return wx.showToast({ title: '请填写任务名称', icon: 'none' })
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 600) return wx.showToast({ title: '建议时长为 5–600 分钟', icon: 'none' })
    this.setData({ taskSaving: true, taskError: '' })
    wx.showLoading({ title: '保存任务中…', mask: true })
    try {
      const flushed = await sync.flush()
      if (flushed.remain) throw new Error('还有未同步的改动，请先完成同步再调整任务')
      const editing = this._editingTask
      if (editing && (editing.status === 'done' || store.sessionsOf(this.data.date).some(s => s._id === editing._id && s.status === 'done'))) {
        throw new Error('任务已完成，不能编辑，仅支持删除')
      }
      const payload = {
        date: this.data.date, subject: this.data.subjects[this.data.taskSubjectIndex],
        content, suggestedMinutes: minutes, clientRequestId: this._addRequestId
      }
      if (editing) Object.assign(payload, { sessionId: editing._id, baseVersion: editing.version })
      const result = await api.call('plan', editing ? 'updateSession' : 'addSession', payload, { silent: true })
      if (!result || !result.doc) throw new Error('任务保存结果不完整，请部署新版 api 后重试')
      const doc = result.doc, db = store.get()
      db.scheduleRevision = (db.scheduleRevision || 0) + 1
      store.applyServerBuckets({ sessions: { [doc.date]: store.sessionsOf(doc.date).filter(s => s._id !== doc._id).concat(doc) } })
      this.setData({ addTaskShow: false })
      this.render()
      getApp().refreshViews()
      wx.hideLoading()
      wx.showToast({ title: editing ? '任务已更新' : '任务已新增', icon: 'success' })
    } catch (e) {
      const message = e.code === 409 ? '任务已有变更，请取消后重新打开编辑；本次输入暂时保留' : e.code === 404 ? '请确认任务存在并已部署新版 api' : (e.message || '保存失败，请重试')
      this.setData({ taskError: message })
    } finally {
      wx.hideLoading()
      this.setData({ taskSaving: false })
    }
  },

  goLog() {
    if (this.data.date > d.todayStr()) return wx.showToast({ title: '未来日期不能提前记录', icon: 'none' })
    wx.navigateTo({ url: '/pages/log-edit/index?date=' + this.data.date })
  },

  openLog(e) {
    if (this.data.date > d.todayStr()) return
    wx.navigateTo({ url: '/pages/log-edit/index?date=' + this.data.date + '&sessionId=' + e.currentTarget.dataset.id })
  },

  removeLog(e) {
    const { id, date } = e.currentTarget.dataset
    wx.showModal({
      title: '删除这条记录？', content: '删除后无法恢复', confirmColor: '#B04A3A',
      success: (res) => {
        if (!res.confirm) return
        store.removeLog(date, id)
        sync.enqueue('log.delete', { logId: id })
        this.render()
      }
    })
  }
})

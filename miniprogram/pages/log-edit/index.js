const store = require('../../utils/store')
const sync = require('../../utils/sync')
const d = require('../../utils/date')
const theme = require('../../utils/theme')
const actions = require('../../utils/record-actions')

const EN = { 听力: 'Listening', 阅读: 'Reading', 写作: 'Writing', 口语: 'Speaking', 单词: 'Vocab', 其他: 'Study' }
const ICON = { 听力: '🎧', 阅读: '📖', 写作: '✍️', 口语: '🗣️', 单词: '🔤', 其他: '📚' }
const TYPE_KEY = { 听力: 'listening', 阅读: 'reading', 写作: 'writing', 口语: 'speaking', 单词: 'vocab', 其他: 'other' }

Page({
  data: {
    statusBarH: 44, theme: 'light',
    date: '', dateText: '', isFuture: false, saving: false,
    task: null, content: '', fromFocus: false, actualTimeText: '', readOnly: false, missing: false, existingLog: false,
    minutes: 30, chips: [30, 45, 60, 90],
    stuck: '', next: ''
  },

  onLoad(options) {
    const date = options.date || d.todayStr()
    if (options.logId) {
      const log = store.logsOf(date).find(l => l._id === options.logId && (!options.sessionId || l.sessionId === options.sessionId))
      this.logId = options.logId
      this.originalLog = log ? Object.assign({}, log) : null
      this.setData({ statusBarH: theme.statusBarHeight(), theme: theme.get(), date, dateText: d.fmtCN(date),
        readOnly: true, existingLog: true, missing: !log, content: log ? log.content : '', minutes: log ? log.durationMinutes : 0,
        stuck: log ? log.note || '' : '', next: log ? log.nextTip || '' : '' })
      return
    }
    let task = null
    if (options.sessionId) {
      task = (store.sessionsOf(date) || []).find(s => s._id === options.sessionId) || null
    }
    const subject = task ? task.subject : '其他'
    const fromFocus = options.fromFocus === '1'
    const elapsed = Math.max(0, Math.floor(Number(options.elapsedSeconds) || 0))
    this.setData({
      statusBarH: theme.statusBarHeight(),
      theme: theme.get(),
      date,
      isFuture: date > d.todayStr(),
      dateText: d.fmtCN(date) + (date === d.todayStr() ? ' · 今日' : ''),
      content: task ? (task.content || subject) : '',
      fromFocus,
      actualTimeText: fromFocus ? Math.floor(elapsed / 60) + ' 分 ' + (elapsed % 60) + ' 秒' : '',
      task: task ? {
        _id: task._id, icon: ICON[subject] || '📚',
        title: (EN[subject] || '') + ' ' + (task.content || subject || '')
      } : null,
      minutes: Math.max(1, Math.min(1440, Math.round(Number(options.minutes) || 30)))
    })
    this.session = task
  },

  back() {
    if (this.data.saving) return
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/today/index' }) })
  },

  onMinutes(e) { this.setData({ minutes: Math.max(1, Math.min(1440, Math.round(Number(e.detail.value) || 0))) }) },
  pickChip(e) { this.setData({ minutes: Number(e.currentTarget.dataset.m) }) },
  onStuck(e) { this.setData({ stuck: e.detail.value.slice(0, 10000) }) },
  onNext(e) { this.setData({ next: e.detail.value.slice(0, 10000) }) },
  onContent(e) { this.setData({ content: e.detail.value }) },
  editRecord() {
    if (this.data.saving || this.data.missing || !this.originalLog) return
    this.setData({ readOnly: false })
  },
  deleteRecord() {
    if (this.data.saving || !this.originalLog) return
    actions.confirmDelete(this, this.data.date, this.logId, () => {
      this.setData({ missing: true, readOnly: true })
      wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/today/index' }) })
    })
  },
  async saveExisting() {
    const current = store.logsOf(this.data.date).find(l => l._id === this.logId)
    if (!current) { this.setData({ missing: true, saving: false, readOnly: true }); return }
    const patch = { content: (this.data.content || '').trim().slice(0, 200) || '自由学习',
      durationMinutes: this.data.minutes, note: this.data.stuck, nextTip: this.data.next }
    store.upsertLog(Object.assign({}, current, patch))
    sync.enqueue('log.update', { logId: this.logId, patch }, this.originalLog.version || 1)
    let result
    try { result = await sync.flush() } catch (e) { /* 保留本地修改及同步队列 */ }
    const saved = store.logsOf(this.data.date).find(l => l._id === this.logId)
    this.originalLog = saved ? Object.assign({}, saved) : null
    this.setData({ saving: false, readOnly: true, missing: !saved,
      content: saved ? saved.content : '', minutes: saved ? saved.durationMinutes : 0,
      stuck: saved ? saved.note || '' : '', next: saved ? saved.nextTip || '' : '' })
    wx.showToast({ title: result && result.conflicts ? '记录冲突，本地修改已保留' :
      !result || result.remain ? '已保存本地，等待同步' : '已保存', icon: 'none' })
  },

  save() {
    const f = this.data
    if (f.saving || f.readOnly) return
    if (f.stuck.length > 10000 || f.next.length > 10000) return wx.showToast({ title: '每项文本最多10000字', icon: 'none' })
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date) || d.dateStr(d.parse(f.date)) !== f.date) return wx.showToast({ title: '日期无效', icon: 'none' })
    if (f.date > d.todayStr()) return wx.showToast({ title: '未来日期不能提前记录', icon: 'none' })
    if (!Number.isInteger(f.minutes) || f.minutes <= 0 || f.minutes > 1440) return wx.showToast({ title: '请填写实际时长', icon: 'none' })
    this.setData({ saving: true })
    if (f.existingLog) return this.saveExisting()
    const subject = this.session ? this.session.subject : '其他'
    const type = TYPE_KEY[subject] || 'other'
    const content = (f.content || '').trim().slice(0, 200) || '自由学习'
    const log = {
      _id: sync.genId(), date: f.date,
      type, typeLabel: subject, icon: ICON[subject] || '📚',
      durationMinutes: f.minutes,
      content,
      note: f.stuck || '',
      nextTip: f.next || '',
      sessionId: this.session ? this.session._id : '',
      version: 1, pendingNew: true, updatedAtLocal: Date.now()
    }
    store.upsertLog(log)
    sync.enqueue('log.add', {
      clientTempId: log._id, date: f.date, type,
      durationMinutes: f.minutes, content: log.content,
      note: log.note, nextTip: log.nextTip,
      sessionId: this.session ? this.session._id : ''
    })
    // 若来自任务且任务未完成，询问是否同时标记完成
    if (this.session && this.session.status !== 'done') {
      wx.showModal({
        title: '同时把这项任务标记为完成？',
        confirmText: '标记完成', cancelText: '暂不',
        success: (res) => {
          if (res.confirm) {
            store.setSessionStatus(f.date, this.session._id, 'done')
            sync.enqueue('session.status', { sessionId: this.session._id, status: 'done', date: f.date }, this.session.version)
          }
          this.done()
        }
      })
      return
    }
    this.done()
  },

  done() {
    if (this.data.fromFocus && typeof this.getOpenerEventChannel === 'function') {
      const channel = this.getOpenerEventChannel()
      if (channel && typeof channel.emit === 'function') channel.emit('focusLogSaved')
    }
    wx.showToast({ title: '已保存', icon: 'success' })
    setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/today/index' }) }), 450)
  }
})

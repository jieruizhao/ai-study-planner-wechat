const store = require('../../utils/store')
const sync = require('../../utils/sync')
const theme = require('../../utils/theme')
const d = require('../../utils/date')

const WEEKS = [
  { n: 1, label: '一' }, { n: 2, label: '二' }, { n: 3, label: '三' }, { n: 4, label: '四' },
  { n: 5, label: '五' }, { n: 6, label: '六' }, { n: 7, label: '日' }
]

Page({
  data: {
    statusBarH: 44, theme: 'light',
    isEdit: false, date: '',
    name: '', time: '', weekdays: [1, 2, 3, 4, 5, 6, 7],
    weeks: WEEKS.map(w => Object.assign({}, w, { on: true })), wxReminder: false, saving: false
  },

  onLoad(options) {
    this.setData({ statusBarH: theme.statusBarHeight(), theme: theme.get() })
    if (options.date) this.setData({ date: options.date })
    if (options.id) {
      const h = store.get().habits.find(x => x._id === options.id)
      if (h) {
        this.id = options.id
        this.habit = h
        this.setData({
          isEdit: true,
          name: h.name, time: h.reminderTime || '', date: h.date || '',
          weekdays: (h.weekdays && h.weekdays.length ? h.weekdays : [1, 2, 3, 4, 5, 6, 7]).slice(),
          wxReminder: !!h.wxReminder
        })
      }
    }
    this.updateWeeks(this.data.weekdays)
  },

  updateWeeks(weekdays) {
    this.setData({ weekdays, weeks: WEEKS.map(w => Object.assign({}, w, { on: weekdays.indexOf(w.n) >= 0 })) })
  },

  back() { wx.navigateBack() },
  onName(e) { this.setData({ name: e.detail.value }) },
  onTime(e) { this.setData({ time: e.detail.value }) },
  clearTime() { this.setData({ time: '' }) },

  toggleWk(e) {
    const n = Number(e.currentTarget.dataset.n)
    let ws = this.data.weekdays.slice()
    const i = ws.indexOf(n)
    if (i >= 0) { if (ws.length === 1) return wx.showToast({ title: '至少选择一天', icon: 'none' }); ws.splice(i, 1) }
    else ws.push(n)
    this.updateWeeks(ws.sort((a, b) => a - b))
  },

  toggleWx() { this.setData({ wxReminder: !this.data.wxReminder }) },

  async save() {
    const f = this.data
    if (f.saving) return
    if (!f.name.trim()) return wx.showToast({ title: '请填写提醒名称', icon: 'none' })
    if (f.date && (f.date < d.todayStr() || !/^\d{4}-\d{2}-\d{2}$/.test(f.date) || d.dateStr(d.parse(f.date)) !== f.date)) return wx.showToast({ title: '请选择今天或未来日期', icon: 'none' })
    if (f.date && !f.time) return wx.showToast({ title: '请设置当日提醒时间', icon: 'none' })
    this.setData({ saving: true })
    const id = this.id || sync.genId()
    const habit = {
      _id: id, name: f.name.trim(), icon: '◎',
      reminderTime: f.time, weekdays: f.date ? [d.weekdayOf(f.date)] : f.weekdays, date: f.date,
      wxReminder: f.wxReminder,
      enabled: this.habit ? this.habit.enabled !== false : true,
      version: this.habit ? this.habit.version || 1 : 1
    }
    store.upsertHabit(habit)
    sync.enqueue('habit.save', habit, this.habit && this.habit.version)
    this.done()
  },

  done() {
    wx.showToast({ title: '已保存', icon: 'success' })
    setTimeout(() => wx.navigateBack(), 450)
  },

  remove() {
    wx.showModal({
      title: '删除该提醒？',
      content: '提醒配置将停用，历史打卡记录会保留',
      confirmColor: '#B04A3A',
      success: (res) => {
        if (!res.confirm) return
        store.removeHabit(this.id)
        sync.enqueue('habit.delete', { habitId: this.id })
        wx.navigateBack()
      }
    })
  }
})

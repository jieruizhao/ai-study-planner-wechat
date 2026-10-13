const store = require('../../utils/store')
const sync = require('../../utils/sync')
const api = require('../../utils/api')
const d = require('../../utils/date')
const theme = require('../../utils/theme')
const actions = require('../../utils/record-actions')

Page({
  data: { theme: 'light', statusBarH: 44, date: '', sessionId: '', title: '', logs: [], minutes: 0, error: '', openSwipeId: '' },
  onLoad(options) {
    this.setData({ date: options.date || d.todayStr(), sessionId: options.sessionId || '', statusBarH: theme.statusBarHeight() })
  },
  onShow() { this.setData({ theme: theme.get() }); this.render(); this.refresh() },
  render() {
    const task = store.sessionsOf(this.data.date).find(s => s._id === this.data.sessionId)
    const logs = this.data.sessionId ? store.logsOf(this.data.date).filter(l => l.sessionId === this.data.sessionId).slice().reverse() : []
    this.setData({ title: task ? task.content || task.subject : '任务记录', logs,
      minutes: logs.reduce((n, l) => n + (Number(l.durationMinutes) || 0), 0) })
  },
  async refresh() {
    await sync.flush().catch(() => {})
    try {
      const res = await api.call('plan', 'getDay', { date: this.data.date }, { silent: true })
      store.applyServerBuckets(res.buckets)
      this.setData({ error: '' })
    } catch (e) { this.setData({ error: '暂时无法刷新，正在显示本地记录' }) }
    this.render()
  },
  openLog(e) {
    if (this._suppressTap) { this._suppressTap = false; return }
    const id = e.currentTarget.dataset.id
    if (this.data.openSwipeId) { this.setData({ openSwipeId: '' }); return }
    if (!this.data.logs.some(l => l._id === id)) return
    wx.navigateTo({ url: '/pages/log-edit/index?date=' + this.data.date + '&logId=' + encodeURIComponent(id) + '&sessionId=' + encodeURIComponent(this.data.sessionId) })
  },
  touchStart(e) {
    const t = e.touches && e.touches[0]
    this._suppressTap = false
    this._touch = t ? { x: t.clientX, y: t.clientY, id: e.currentTarget.dataset.id } : null
  },
  touchEnd(e) {
    const t = e.changedTouches && e.changedTouches[0], start = this._touch
    this._touch = null
    if (!t || !start) return
    const dx = t.clientX - start.x, dy = t.clientY - start.y
    if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.5) return
    this._suppressTap = true
    this.setData({ openSwipeId: dx < 0 ? start.id : '' })
  },
  touchCancel() { this._touch = null },
  deleteRecord(e) {
    const id = e.currentTarget.dataset.id
    if (!this.data.logs.some(l => l._id === id)) return
    actions.confirmDelete(this, this.data.date, id, () => { this.setData({ openSwipeId: '' }); this.render() })
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/today/index' }) }) }
})

const store = require('../../utils/store')
const sync = require('../../utils/sync')
const api = require('../../utils/api')
const d = require('../../utils/date')
const theme = require('../../utils/theme')
const calendar = require('../../utils/phone-calendar')

Page({
  data: {
    statusBarH: 44, theme: 'light',
    habits: [], invalidCount: 0, clearing: false
  },

  onLoad() { this.setData({ statusBarH: theme.statusBarHeight() }) },

  onShow() {
    this.setData({ theme: theme.get() })
    this.render()
    this.refresh()
    this.loadTemplate()
    clearInterval(this._expiryTimer)
    this._expiryTimer = setInterval(() => this.render(), 30000)
  },
  onHide() { clearInterval(this._expiryTimer) },
  onUnload() { clearInterval(this._expiryTimer) },

  isExpired(h, now = new Date()) {
    if (!h.date) return false
    const today = d.dateStr(now)
    const hm = d.pad(now.getHours()) + ':' + d.pad(now.getMinutes())
    return h.date < today || (h.date === today && !!h.reminderTime && h.reminderTime < hm)
  },

  isInvalid(h) { return h.enabled === false || this.isExpired(h) },

  render() {
    const db = store.get()
    const now = new Date()
    const habits = (db.habits || []).map((h, index) => {
      const expired = this.isExpired(h, now)
      return {
        _id: h._id, name: h.name,
        time: h.reminderTime || '',
        freq: h.date ? h.date + ' · 仅当天' : this.freqText(h.weekdays),
        date: h.date || '',
        wechat: !!h.wxReminder,
        calendarAdded: !!(db.phoneCalendarAdds || {})[h._id],
        enabled: h.enabled !== false,
        expired, invalid: h.enabled === false || expired, index
      }
    }).sort((a,b) => Number(a.invalid) - Number(b.invalid) || a.index - b.index)
    this.setData({ habits, invalidCount: habits.filter(h => h.invalid).length })
  },

  clearInvalid() {
    if (this.data.clearing) return
    const owner = store.get()
    const ids = (owner.habits || []).filter(h => this.isInvalid(h)).map(h => h._id)
    if (!ids.length) return this.render()
    this.setData({ clearing: true })
    return wx.showModal({
      title: '删除失效提醒？',
      content: '删除 ' + ids.length + ' 条已过期的单次提醒或已停用的提醒，历史打卡记录保留。已添加的手机日历提醒需在日历中删除。',
      confirmText: '删除', confirmColor: '#B04A3A',
      success: async res => {
        if (!res.confirm || store.get() !== owner) { this.setData({ clearing: false }); return }
        try {
          // 再次检查，保留确认期间已重新启用或改为未来时间的提醒。
          const current = owner.habits.filter(h => ids.includes(h._id) && this.isInvalid(h))
          for (const h of current) {
            store.removeHabit(h._id)
            if (owner.phoneCalendarAdds) delete owner.phoneCalendarAdds[h._id]
            sync.enqueue('habit.delete', { habitId: h._id })
          }
          store.persist()
          this.render()
          const result = await sync.flush()
          wx.showToast({ title: result.remain ? '已移除，等待同步' : '失效提醒已删除', icon: 'none' })
        } catch (e) {
          wx.showToast({ title: '已移除，联网后同步', icon: 'none' })
        } finally { this.setData({ clearing: false }); this.render() }
      },
      fail: () => this.setData({ clearing: false })
    })
  },

  freqText(ws) {
    if (!ws || !ws.length || ws.length === 7) return '每天'
    return '周' + ws.map(w => '一二三四五六日'[w - 1]).join('、')
  },

  async refresh() {
    await sync.flush().catch(() => {})
    try {
      const res = await api.call('habit', 'listAll', {}, { silent: true })
      if (res.habits) store.applyServerBuckets({ habits: res.habits })
    } catch (e) { /* 离线兜底 */ }
    this.render()
  },

  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) }) },
  add() { if (!this.data.clearing) wx.navigateTo({ url: '/pages/habit-edit/index' }) },
  edit(e) { wx.navigateTo({ url: '/pages/habit-edit/index?id=' + e.currentTarget.dataset.id }) },

  toggleEnabled(e) {
    const id = e.currentTarget.dataset.id
    const h = store.get().habits.find(x => x._id === id)
    if (!h) return
    if (this.isExpired(h)) return wx.showToast({ title: '请先编辑提醒日期和时间', icon: 'none' })
    const enabled = !h.enabled
    store.upsertHabit({ _id: id, enabled })
    sync.enqueue('habit.save', Object.assign({}, h, { enabled }), h.version)
    this.render()
  },

  addCalendar(e) {
    const h = store.get().habits.find(x => x._id === e.currentTarget.dataset.id)
    if (h && this.isExpired(h)) return wx.showToast({ title: '此单次提醒已过期', icon: 'none' })
    calendar.addDaily(h, this)
  },
  async loadTemplate() {
    try { const res = await api.call('habit', 'getTemplate', {}, { silent: true }); this._templateId = res.templateId || '' }
    catch (e) { this._templateId = '' }
  },
  requestWechat(e) {
    if (this._subscribeBusy) return
    const id = e && e.currentTarget && e.currentTarget.dataset.id
    const h = store.get().habits.find(x => x._id === id)
    if (h && this.isExpired(h)) return wx.showToast({ title: '请先修改过期提醒时间', icon: 'none' })
    if (!h || !h.enabled || !h.reminderTime) return wx.showToast({ title: '请先启用提醒并设置时间', icon: 'none' })
    if (!this._templateId) {
      this.loadTemplate()
      return wx.showModal({ title: '提醒模板暂不可用', content: '请先配置一次性订阅模板，或稍后再试。每天提醒可以先添加到手机日历。', showCancel: false })
    }
    if (typeof wx.requestSubscribeMessage !== 'function') return wx.showToast({ title: '请在手机微信中订阅', icon: 'none' })
    this._subscribeBusy = true
    const templateId = this._templateId
    try {
      wx.requestSubscribeMessage({
        tmplIds: [templateId],
        complete: async (r) => {
          this._subscribeBusy = false
          if (r && r[templateId] === 'accept') {
            let envVersion = 'release'
            try { envVersion = wx.getAccountInfoSync().miniProgram.envVersion } catch (e) {}
            const miniprogramState = { develop:'developer', trial:'trial', release:'formal' }[envVersion] || 'formal'
            store.upsertHabit({ _id: id, wxReminder: true, miniprogramState })
            sync.enqueue('habit.save', Object.assign({}, h, { wxReminder: true, miniprogramState }), h.version)
            this.render()
            try {
              const result = await sync.flush()
              if (result.remain) throw new Error('提醒尚未同步')
              wx.showToast({ title: '已订阅一次提醒', icon: 'success' })
            } catch (err) {
              wx.showModal({ title: '订阅已允许，提醒待同步', content: '提醒配置尚未同步到云端，请保持网络连接，稍后重新进入此页面检查。', showCancel: false })
            }
          }
          else wx.showToast({ title: '未完成授权，可稍后再试', icon: 'none' })
        }
      })
    } catch (e) {
      this._subscribeBusy = false
      wx.showToast({ title: '订阅失败，请稍后重试', icon: 'none' })
    }
  }
})

const store = require('./store')
function addDaily(habit, page) {
  if (page._calendarBusy) return
  if (!habit || !habit.enabled || !/^([01]\d|2[0-3]):[0-5]\d$/.test(habit.reminderTime || '')) {
    return wx.showToast({ title: '请先启用提醒并设置时间', icon: 'none' })
  }
  const method = habit.date ? 'addPhoneCalendar' : 'addPhoneRepeatCalendar'
  if (typeof wx[method] !== 'function') return wx.showModal({
    title: '请在手机微信中添加', content: '当前环境不支持写入手机日历。也可在手机日历中手动创建每天重复的学习提醒。', showCancel: false })
  page._calendarBusy = true
  const added = (store.get().phoneCalendarAdds || {})[habit._id]
  wx.showModal({
    title: added ? '再次添加手机日历？' : habit.date ? '添加当日提醒到手机日历？' : '添加每日提醒到手机日历？',
    content: (added ? '本机曾添加过，重复添加可能产生多条日程。' : '') +
      (habit.date ? habit.date + ' ' : '每天 ') + habit.reminderTime + ' 提醒“' + habit.name + '”。修改或删除请到手机日历操作。',
    success(res) {
      if (!res.confirm) { page._calendarBusy = false; return }
      const fail = e => {
        page._calendarBusy = false
        const msg = e && (e.errMsg || e.message) || ''
        if (/cancel/i.test(msg)) return wx.showToast({ title: '已取消添加', icon: 'none' })
        wx.showModal({ title: '日历未添加',
          content: '请检查微信的日历权限和小程序隐私授权。你也可以在手机日历手动新建每天重复提醒。', showCancel: false })
      }
      const write = () => {
        const now = new Date(), parts = habit.reminderTime.split(':').map(Number)
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parts[0], parts[1], 0)
        if (habit.date) {
          const day = habit.date.split('-').map(Number)
          start.setFullYear(day[0], day[1] - 1, day[2])
          if (start.getTime() <= now.getTime()) { page._calendarBusy = false; return wx.showToast({ title: '所选提醒时间已过去', icon: 'none' }) }
        } else if (start.getTime() <= now.getTime()) start.setDate(start.getDate() + 1)
        try {
          wx[method]({
            title: habit.name, startTime: Math.floor(start.getTime() / 1000),
            ...(habit.date ? {} : { repeatInterval: 'day' }), alarm: true, alarmOffset: 0,
            description: '学习提醒。此日程由手机日历独立管理，' + (habit.date ? '仅所选日期生效' : '每天重复') + '；修改或删除请在手机日历操作。',
            success() {
              const db = store.get()
              db.phoneCalendarAdds = db.phoneCalendarAdds || {}
              db.phoneCalendarAdds[habit._id] = { time: habit.reminderTime, name: habit.name, addedAt: Date.now() }
              store.persist()
              page._calendarBusy = false
              if (typeof page.render === 'function') page.render()
              wx.showToast({ title: '已添加，请检查日历通知', icon: 'none' })
            }, fail
          })
        } catch (e) { fail(e) }
      }
      try {
        if (typeof wx.requirePrivacyAuthorize === 'function') wx.requirePrivacyAuthorize({ success: write, fail })
        else write()
      } catch (e) { fail(e) }
    },
    fail() { page._calendarBusy = false }
  })
}
module.exports = { addDaily }

const store = require('./store')
const sync = require('./sync')

// 列表和详情共用确认流程；删除仅影响记录，不改变任务完成状态。
function confirmDelete(page, date, id, afterDelete) {
  if (page._recordDeleting) return
  if (!store.logsOf(date).some(l => l._id === id)) return
  page._recordDeleting = true
  wx.showModal({
    title: '删除这条学习记录？',
    content: '删除后无法恢复，任务本身不会被删除。',
    confirmText: '删除', confirmColor: '#C76B62', cancelText: '取消',
    success(res) {
      page._recordDeleting = false
      if (!res.confirm) return
      if (!store.logsOf(date).some(l => l._id === id)) return
      store.removeLog(date, id)
      sync.enqueue('log.delete', { logId: id, date })
      afterDelete()
      wx.showToast({ title: '已删除', icon: 'success' })
    },
    fail() { page._recordDeleting = false },
    complete() { page._recordDeleting = false }
  })
}
module.exports = { confirmDelete }

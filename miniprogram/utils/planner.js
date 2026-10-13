// 日历状态计算：由"计划 + 实际记录"推导，不单独存储日期状态
// 口径（与产品文档一致）：
//  - 过去学习日无记录 → missed（未记录/待补记）
//  - 休息日不算漏学 → rest
//  - 未来日期不显示完成/未完成 → future
//  - 习惯状态不影响学习任务状态
const d = require('./date')

// state: done | partial | missed | logged | rest | future-plan | future | today
function computeDateState(date, ctx) {
  const today = ctx.today || d.todayStr()
  const plan = ctx.plan
  const sessions = ctx.sessions && ctx.sessions[date] ? ctx.sessions[date] : []
  const logs = ctx.logs && ctx.logs[date] ? ctx.logs[date] : []
  const isFuture = date > today
  const isPlanDay = sessions.length > 0 || isPlannedDate(date, plan)

  if (isFuture) return isPlanDay ? 'future-plan' : 'future'
  if (isPlanDay && sessions.length) {
    const doneCount = sessions.filter(s => s.status === 'done').length
    if (doneCount === sessions.length) return 'done'
    if (doneCount > 0) return 'partial'
    return logs.length ? 'plan-logged' : (date === today ? 'today' : 'missed')
  }
  if (logs.length) return 'logged'
  if (isPlanDay && date === today) return 'today'
  if (isPlanDay) return 'missed'
  return date === today ? 'today' : (plan && date >= plan.startDate ? 'rest' : 'blank')
}

function isPlannedDate(date, plan) {
  if (!plan) return false
  if (date < plan.startDate) return false
  if (plan.endDate && date > plan.endDate) return false
  if (plan.lastDate && date > plan.lastDate) return false
  if ((plan.imported || plan.source === 'excel') && Array.isArray(plan.dates)) return plan.dates.indexOf(date) >= 0
  // 逐日导入计划只能以实际排期日期判断，不能扩展成每周重复计划。
  if (plan.imported || plan.source === 'import') return false
  const wd = d.weekdayOf(date)
  const rests = plan.extraRestDates || []
  if (rests.indexOf(date) >= 0) return false
  const study = plan.studyWeekdays || [1, 2, 3, 4, 5, 6, 7]
  return study.indexOf(wd) >= 0
}

const STATE_META = {
  done: { cls: 'st-done', label: '已完成' },
  partial: { cls: 'st-partial', label: '部分完成' },
  'plan-logged': { cls: 'st-logged', label: '有记录' },
  logged: { cls: 'st-logged', label: '有记录' },
  missed: { cls: 'st-missed', label: '未记录' },
  rest: { cls: 'st-rest', label: '休息' },
  'future-plan': { cls: 'st-future-plan', label: '计划' },
  future: { cls: 'st-future', label: '' },
  today: { cls: 'st-today', label: '今天' },
  blank: { cls: 'st-blank', label: '' }
}

module.exports = { computeDateState, isPlannedDate, STATE_META }

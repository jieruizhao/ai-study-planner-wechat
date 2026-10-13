/** 数据管理模块：导出、删除（可查询的任务式处理）、Excel 计划导入、恢复初始状态 */
const { getUser, bizErr, readAll } = require('./helper')
const planParse = require('./planParse')
const planService = require('./plan')

async function exportAll(ctx) {
  const { db, _, OPENID } = ctx
  const user = await getUser(ctx)
  const [plans, sessions, logs, habits, habitLogs] = await Promise.all([
    readAll(db.collection('plans').where({ userId: OPENID })),
    readAll(db.collection('sessions').where({ userId: OPENID })),
    readAll(db.collection('logs').where({ userId: OPENID })),
    readAll(db.collection('habits').where({ userId: OPENID })),
    readAll(db.collection('habitLogs').where({ userId: OPENID }))
  ])
  const payload = {
    exportedAt: new Date().toISOString(),
    user: { openidMask: user.openidMask, examDate: user.examDate, timezone: user.timezone },
    plans: plans, sessions: sessions, logs: logs,
    habits: habits, habitLogs: habitLogs,
    counts: { summary: `计划 ${plans.length} 项 / 任务 ${sessions.length} 条 / 记录 ${logs.length} 条 / 习惯 ${habits.length} 个` }
  }
  return { payload }
}

async function exportExcel(ctx) {
  const { payload } = await exportAll(ctx)
  const XLSX = require('xlsx')
  const { buildWorkbook } = require('./recordWorkbook')
  const wb = buildWorkbook(payload, XLSX)
  const fileName = '学习记录_' + ctx.bizToday() + '.xlsx'
  const owner = require('crypto').createHash('sha256').update(ctx.OPENID).digest('hex')
  const cloudPath = 'exports/' + owner + '/' + Date.now() + '_' + require('crypto').randomBytes(8).toString('hex') + '.xlsx'
  const result = await ctx.cloud.uploadFile({ cloudPath, fileContent: XLSX.write(wb, { type:'buffer', bookType:'xlsx', compression:true }) })
  if (!result.fileID) throw new Error('导出文件上传失败，请重试')
  return { fileID: result.fileID, fileName, count: (payload.logs || []).length }
}

/** 删除：逐集合清理并留档 deletionJobs（结果可查询，避免长任务状态丢失） */
async function requestDeletion(ctx) {
  const { db, OPENID } = ctx
    const collections = ['plans', 'sessions', 'logs', 'habits', 'habitLogs', 'reminders', 'dispatches', 'syncOps', 'coachReports', 'coachBatches', 'coachGuards']
  const deleted = {}
  for (const name of collections) {
    try {
      const r = await db.collection(name).where({ userId: OPENID }).remove()
      deleted[name] = (r && r.stats) ? r.stats.removed : 0
    } catch (e) {
      deleted[name] = 'error: ' + e.message
    }
  }
  const failed = Object.values(deleted).some(value => typeof value === 'string')
  const job = await db.collection('deletionJobs').add({
    data: { userId: OPENID, deleted, at: db.serverDate(), status: failed ? 'failed' : 'done' }
  })
  if (failed) throw bizErr(500, '部分数据未能删除，请重试', { jobId: job._id, deleted })
  await db.collection('users').where({ openid: OPENID }).remove()
  return { jobId: job._id, deleted }
}

/** 恢复初始状态：清空计划/任务/学习记录/习惯打卡，保留账号资料与习惯定义 */
async function resetPlan(ctx) {
  const { db, OPENID } = ctx
  const collections = ['plans', 'sessions', 'logs', 'habitLogs']
  const deleted = {}
  for (const name of collections) {
    try {
      const r = await db.collection(name).where({ userId: OPENID }).remove()
      deleted[name] = (r && r.stats) ? r.stats.removed : 0
    } catch (e) {
      deleted[name] = 'error: ' + e.message
    }
  }
  const failed = Object.values(deleted).some(value => typeof value === 'string')
  await db.collection('deletionJobs').add({
    data: { userId: OPENID, type: 'resetPlan', deleted, at: db.serverDate(), status: failed ? 'failed' : 'done' }
  }).catch(() => {})
  if (failed) throw bizErr(500, '部分数据未能恢复，请重试', { deleted })
  return { deleted }
}

// ---------- Excel 导入 ----------

/** 把 xlsx 二维行数组解析为计划预览（fileBase64 或 rows 二选一） */
async function importPreview(ctx) {
  const { payload } = ctx
  let sheets = []
  if (payload.fileBase64) {
    const XLSX = require('xlsx')
    const buf = Buffer.from(payload.fileBase64, 'base64')
    if (!buf || !buf.length) throw bizErr(400, '文件内容为空')
    if (buf.length > 2 * 1024 * 1024) throw bizErr(400, '文件需小于 2MB')
    // 不用 cellDates：xlsx 库浮点误差会把日期回退一天，改用原始序列数自行换算
    const wb = XLSX.read(buf, { type: 'buffer' })
    sheets = wb.SheetNames.map(n => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }) }))
  } else if (Array.isArray(payload.rows)) {
    sheets = [{ name: 'inline', rows: payload.rows }]
  } else {
    throw bizErr(400, '缺少文件内容')
  }

  // 逐个 sheet 尝试解析，取第一个成功且行数最多的
  let best = null
  for (const s of sheets) {
    const r = planParse.parsePlanRows(s.rows)
    if (r.ok && (!best || r.result.stats.tasks > best.parsed.result.stats.tasks)) {
      best = { sheetName: s.name, parsed: r }
    }
  }
  if (!best) {
    const err = sheets.length ? planParse.parsePlanRows(sheets[0].rows) : { error: '表格为空' }
    throw bizErr(400, err.error || '解析失败')
  }

  const { rows, stats } = best.parsed.result
  const currentPlan = await planService.getPlanDoc(ctx)
  return {
    planVersion: currentPlan ? currentPlan.version : 0,
    sheetName: best.sheetName,
    rows: rows.map(r => ({ date: r.date, subject: r.subject, content: r.content, minutes: r.minutes })),
    imported: stats,
    sample: rows.slice(0, 5).map(r => ({ date: r.date, subject: r.subject, content: r.content, minutes: r.minutes }))
  }
}

/** 确认导入：覆盖未来待办任务，写入逐日计划（历史与已完成保留） */
async function importApply(ctx) {
  const rows = planParse.sanitizeRows(ctx.payload.rows)
  if (!rows) throw bizErr(400, '导入数据不合法（需为解析预览返回的 rows）')
  const dates = [...new Set(rows.map(r => r.date))].sort()
  const planDoc = await planService.getPlanDoc(ctx)
  if (ctx.payload.baseVersion != null && Number(ctx.payload.baseVersion) !== (planDoc ? planDoc.version : 0)) {
    throw bizErr(409, '计划已变更，请重新预览导入')
  }
  const orders = {}
  const slots = rows.map(r => ({ date: r.date, order: (orders[r.date] = (orders[r.date] || 0) + 1) - 1,
    subject: r.subject, content: r.content, suggestedMinutes: r.minutes }))
  const plan = { title: String(ctx.payload.title || '导入的学习计划').slice(0, 30),
    startDate: dates[0], lastDate: dates[dates.length - 1], dates,
    studyWeekdays: [...new Set(dates.map(weekdayOfDate))].sort((a,b) => a-b),
    extraRestDates: [], dailyMaxSessions: Math.max(...Object.values(orders)), template: [], imported: true, source: 'excel' }
  // 过去任务不删除；历史表格允许补入尚不存在的任务，已完成同内容任务保持不变。
  const replaceFrom = dates[0] > ctx.bizToday() ? dates[0] : ctx.bizToday()
  const result = await planService.applySchedule(ctx, { planDoc, plan, slots,
    from: replaceFrom, bucketDates: dates, action: 'import' })
  return Object.assign(result, { imported: { days: dates.length, tasks: rows.length,
    inserted: result.insertedCount, preserved: result.preservedCount,
    totalMinutes: rows.reduce((total,r) => total+r.minutes,0) } })
}

function weekdayOfDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const w = new Date(y, m - 1, d).getDay()
  return w === 0 ? 7 : w
}

module.exports = { exportAll, exportExcel, requestDeletion, resetPlan, importPreview, importApply }


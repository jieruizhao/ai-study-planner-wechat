/** 复盘与统计模块：返回区间原始记录，聚合由前端按口径计算（口径单一来源在客户端展示层） */
const { getUser, bizErr, isValidDate, readAll } = require('./helper')

async function overview(ctx) {
  const { db, _, OPENID, payload } = ctx
  await getUser(ctx)
  const from = String(payload.from || ''), to = String(payload.to || '')
  if (!isValidDate(from) || !isValidDate(to) || from > to) {
    throw bizErr(400, '日期区间错误')
  }
  const records = await readAll(db.collection('logs')
    .where({ userId: OPENID, date: _.gte(from).and(_.lte(to)) })
    )
  const logs = records.map(l => ({
    _id: l._id, date: l.date, type: l.type, subject: l.subject,
    durationMinutes: l.durationMinutes, content: l.content, note: l.note, nextTip: l.nextTip, version: l.version
  }))
  const totalMinutes = logs.reduce((t, l) => t + (l.durationMinutes || 0), 0)
  const days = new Set(logs.map(l => l.date))
  return {
    logs,
    summary: { totalMinutes, activeDays: days.size, logCount: logs.length }
  }
}

module.exports = { overview }

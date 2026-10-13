/**
 * 计划与日历：模板按天生成；重排保留已完成和历史任务。
 * 以版本预约避免重复提交，先写新排期再删除旧待办，异常时按完整快照恢复。
 */
const crypto = require('crypto')
const { getUser, assertOwner, bizErr, pad, isValidDate, readAll } = require('./helper')

function normalizePlan(input) {
  const weekdays = [...new Set((Array.isArray(input.studyWeekdays) ? input.studyWeekdays : [])
    .map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 7))]
  if (!weekdays.length) throw bizErr(400, '至少选择一个可学习星期')
  const template = (Array.isArray(input.template) ? input.template : [])
    .filter(t => t && t.subject && String(t.subject).trim())
    .map(t => ({
      subject: String(t.subject).trim().slice(0, 20),
      content: String(t.content || '').trim().slice(0, 60),
      minutes: Math.max(5, Math.min(600, Math.round(Number(t.minutes) || 30)))
    }))
  if (!template.length) throw bizErr(400, '至少配置一个每日任务')
  const startDate = String(input.startDate || '')
  if (!isValidDate(startDate)) throw bizErr(400, '开始日期格式错误')
  const dailyMaxSessions = Math.max(1, Math.min(12, Math.floor(Number(input.dailyMaxSessions) || 6)))
  if (template.length > dailyMaxSessions) throw bizErr(400, '每日任务数超过上限（' + dailyMaxSessions + '）')
  return {
    title: String(input.title || '我的学习计划').slice(0, 20),
    startDate, studyWeekdays: weekdays.sort((a, b) => a - b),
    extraRestDates: [...new Set((Array.isArray(input.extraRestDates) ? input.extraRestDates : []).filter(isValidDate))].sort(),
    dailyMaxSessions, template, imported: false, source: 'template', dates: [], lastDate: null
  }
}

function weekdayOf(s) {
  const w = new Date(s + 'T00:00:00Z').getUTCDay()
  return w === 0 ? 7 : w
}

function addDays(s, n) {
  const dt = new Date(s + 'T00:00:00Z')
  dt.setUTCDate(dt.getUTCDate() + n)
  return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate())
}

function isStudyDate(date, plan) {
  return date >= plan.startDate && !(plan.extraRestDates || []).includes(date) &&
    plan.studyWeekdays.includes(weekdayOf(date))
}

/** 从 max(today, startDate) 起生成 180 天，旧计划也能继续排期。 */
function expandSlots(plan, today) {
  const slots = []
  const from = plan.startDate > today ? plan.startDate : today
  for (let i = 0; i < 180; i++) {
    const date = addDays(from, i)
    if (isStudyDate(date, plan)) {
      plan.template.forEach((t, order) => {
        slots.push({ date, order, subject: t.subject, content: t.content, suggestedMinutes: t.minutes })
      })
    }
  }
  return slots
}

async function getPlanDoc(ctx) {
  const res = await ctx.db.collection('plans').where({ userId: ctx.OPENID }).orderBy('createdAt', 'asc').limit(1).get()
  return res.data[0] || null
}

function publicPlan(p) {
  return {
    _id: p._id, version: p.version, title: p.title, startDate: p.startDate,
    studyWeekdays: p.studyWeekdays, extraRestDates: p.extraRestDates,
    dailyMaxSessions: p.dailyMaxSessions, template: p.template,
    imported: !!p.imported, source: p.source || (p.imported ? 'excel' : 'template'),
    dates: p.dates || [], lastDate: p.lastDate || null
  }
}

/** 单日包含空桶，清除服务端已删除而本地仍残留的数据。 */
async function getDay(ctx) {
  const { db, OPENID, payload, bizToday } = ctx
  const date = String(payload.date || bizToday())
  if (!isValidDate(date)) throw bizErr(400, '日期格式错误')
  const [user, plan, sessions, logs, habitLogs] = await Promise.all([
    getUser(ctx), getPlanDoc(ctx),
    readAll(db.collection('sessions').where({ userId: OPENID, date }).orderBy('order', 'asc')),
    readAll(db.collection('logs').where({ userId: OPENID, date })),
    readAll(db.collection('habitLogs').where({ userId: OPENID, date }))
  ])
  if (plan && plan.scheduling) throw bizErr(503, '排期更新中，请稍后刷新')
  const hl = {}
  habitLogs.forEach(h => { hl[h.habitId] = h.status })
  return { buckets: {
    profile: { openidMask: user.openidMask, examDate: user.examDate, timezone: user.timezone },
    plan: plan ? publicPlan(plan) : null,
    sessions: { [date]: sessions.filter(s => !s.deleted) }, logs: { [date]: logs }, habitLogs: { [date]: hl }
  } }
}

/** 区间查询始终返回每个日期的桶，不能用“缺少日期”表示空数据。 */
async function getRange(ctx) {
  const { db, _, OPENID, payload } = ctx
  const from = String(payload.from || ''), to = String(payload.to || '')
  if (!isValidDate(from) || !isValidDate(to) || from > to) throw bizErr(400, '日期区间错误')
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 120) throw bizErr(400, '单次查询最多 120 天')
  const [user, plan, sessions, logs, habitLogs] = await Promise.all([
    getUser(ctx), getPlanDoc(ctx),
    readAll(db.collection('sessions').where({ userId: OPENID, date: _.gte(from).and(_.lte(to)) })),
    readAll(db.collection('logs').where({ userId: OPENID, date: _.gte(from).and(_.lte(to)) })),
    readAll(db.collection('habitLogs').where({ userId: OPENID, date: _.gte(from).and(_.lte(to)) }))
  ])
  if (plan && plan.scheduling) throw bizErr(503, '排期更新中，请稍后刷新')
  const bucketS = {}, bucketL = {}, bucketH = {}
  for (let date = from; date <= to; date = addDays(date, 1)) {
    bucketS[date] = []; bucketL[date] = []; bucketH[date] = {}
  }
  sessions.filter(s => !s.deleted).forEach(s => { bucketS[s.date].push(s) })
  logs.forEach(l => { bucketL[l.date].push(l) })
  habitLogs.forEach(h => { bucketH[h.date][h.habitId] = h.status })
  Object.values(bucketS).forEach(list => list.sort((a, b) => (a.order || 0) - (b.order || 0)))
  return { buckets: {
    profile: { openidMask: user.openidMask, examDate: user.examDate, timezone: user.timezone },
    plan: plan ? publicPlan(plan) : null, sessions: bucketS, logs: bucketL, habitLogs: bucketH
  } }
}

function belongsToPlan(s, planDoc) {
  return !s.planId || (planDoc && s.planId === planDoc._id)
}

function taskKey(s) {
  return JSON.stringify([s.date, String(s.subject || '').trim(), String(s.content || '').trim()])
}

/** 已保留任务逐一占用同日同内容槽位；重复模板依然可以有多条。 */
function pendingSlots(slots, preserved) {
  const counts = new Map()
  preserved.forEach(s => {
    const key = taskKey(s.scheduleSlot || s)
    counts.set(key, (counts.get(key) || 0) + 1)
  })
  return slots.filter(s => {
    const key = taskKey(s), count = counts.get(key) || 0
    if (!count) return true
    counts.set(key, count - 1)
    return false
  })
}

async function scheduleState(ctx, planDoc, slots, from) {
  const all = await readAll(ctx.db.collection('sessions').where({ userId: ctx.OPENID }).orderBy('date', 'asc').orderBy('order', 'asc'))
  const oldPending = all.filter(s => !s.deleted && s.source !== 'manual' && belongsToPlan(s, planDoc) && s.status === 'pending' && s.date >= from)
  const replaceIds = new Set(oldPending.map(s => s._id))
  const preserved = all.filter(s => !replaceIds.has(s._id))
  return { all, oldPending, preserved, slots: pendingSlots(slots, preserved.filter(s => (s.source !== 'manual' || s.scheduleSlot) && belongsToPlan(s, planDoc))) }
}

/** 预览和确认使用同一套排期规则。 */
async function previewReorder(ctx) {
  const plan = normalizePlan(ctx.payload.plan || {})
  const today = ctx.bizToday(), planDoc = await getPlanDoc(ctx)
  if (planDoc && planDoc.scheduling) throw bizErr(409, '计划正在更新，请稍后重试')
  const state = await scheduleState(ctx, planDoc, expandSlots(plan, today), today)
  const moves = []
  for (let i = 0; i < Math.min(state.oldPending.length, state.slots.length); i++) {
    if (state.oldPending[i].date !== state.slots[i].date) {
      moves.push({ subject: state.slots[i].subject, content: state.slots[i].content,
        from: state.oldPending[i].date, to: state.slots[i].date })
    }
  }
  return {
    mode: planDoc ? 'preview' : 'create', planVersion: planDoc ? planDoc.version : 0,
    moves, warnings: [], keepCount: state.preserved.filter(s => !s.deleted && belongsToPlan(s, planDoc)).length,
    added: Math.max(0, state.slots.length - state.oldPending.length),
    removed: Math.max(0, state.oldPending.length - state.slots.length)
  }
}

function withoutId(doc) {
  const data = Object.assign({}, doc)
  delete data._id
  return data
}

async function removeIds(ctx, docs, onlyPending) {
  for (let i = 0; i < docs.length; i += 100) {
    const filter = { userId: ctx.OPENID, _id: ctx._.in(docs.slice(i, i + 100).map(s => s._id)) }
    if (onlyPending) filter.status = 'pending'
    await ctx.db.collection('sessions').where(filter).remove()
  }
}

/** 模板和 Excel 共用提交路径；快照保留完整字段，写入失败自动补偿。 */
async function applySchedule(ctx, { planDoc, plan, slots, from, bucketDates = [], action = 'reorder' }) {
  const { db, OPENID } = ctx
  if (planDoc && planDoc.scheduling) throw bizErr(409, '计划正在更新，请稍后重试')
  const state = await scheduleState(ctx, planDoc, slots, from)
  const planId = planDoc ? planDoc._id : 'plan_' + crypto.createHash('sha1').update(OPENID).digest('hex').slice(0, 24)
  const version = planDoc ? (Number(planDoc.version) || 0) + 1 : 1
  const stamp = version + '_' + crypto.randomBytes(6).toString('hex')
  const docs = state.slots.map((s, index) => Object.assign({}, s, {
    _id: 's_' + crypto.createHash('sha1').update(planId).digest('hex').slice(0, 12) + '_' + stamp + '_' + index,
    userId: OPENID, planId, status: 'pending', version: 1,
    createdAt: db.serverDate(), updatedAt: db.serverDate()
  }))
  const nextPlan = Object.assign({}, planDoc || {}, plan, {
    _id: planId, userId: OPENID, version, scheduling: false,
    createdAt: planDoc ? planDoc.createdAt : db.serverDate(), updatedAt: db.serverDate()
  })
  // 先保留完整快照；留档失败时不做任何业务数据修改。
  const audit = await db.collection('reorderLogs').add({ data: {
    userId: OPENID, planId, action, baseVersion: planDoc ? planDoc.version : 0,
    toVersion: version, oldPlan: planDoc, snapshot: state.oldPending,
    status: 'prepared', at: db.serverDate()
  } })
  let reserved = false
  try {
    if (planDoc) {
      const lock = await db.collection('plans').where({
        _id: planId, userId: OPENID, version: planDoc.version
      }).update({ data: { version, scheduling: true } })
      if (!lock.stats || lock.stats.updated !== 1) throw bizErr(409, '计划已被其他设备修改，请刷新预览后重试')
    } else {
      await db.collection('plans').add({ data: Object.assign({}, nextPlan, { scheduling: true }) })
    }
    reserved = true
    for (let i = 0; i < docs.length; i += 100) {
      await db.collection('sessions').add({ data: docs.slice(i, i + 100) })
    }
    await removeIds(ctx, state.oldPending, true)
    await db.collection('plans').doc(planId).update({ data: withoutId(nextPlan) })
  } catch (error) {
    if (reserved) {
      try {
        await removeIds(ctx, docs, false)
        for (const old of state.oldPending) {
          const current = await db.collection('sessions').doc(old._id).get().catch(() => null)
          if (!current || !current.data) await db.collection('sessions').doc(old._id).set({ data: withoutId(old) })
        }
        if (planDoc) await db.collection('plans').doc(planId).set({ data: withoutId(planDoc) })
        else await db.collection('plans').doc(planId).remove()
        await db.collection('reorderLogs').doc(audit._id).update({ data: { status: 'rolled-back' } })
      } catch (restoreError) {
        await db.collection('reorderLogs').doc(audit._id).update({
          data: { status: 'recovery-required', error: restoreError.message }
        }).catch(() => {})
        throw bizErr(500, '排期失败，恢复未完成，请保留现有数据并联系管理员', { recoveryId: audit._id })
      }
    }
    throw error
  }
  await db.collection('reorderLogs').doc(audit._id).update({ data: { status: 'committed' } }).catch(() => {})
  const sessionsByDate = {}
  bucketDates.concat(state.oldPending.map(s => s.date), slots.map(s => s.date), [ctx.bizToday()])
    .forEach(date => { sessionsByDate[date] = [] })
  state.preserved.concat(docs).filter(s => !s.deleted).forEach(s => {
    if (Object.prototype.hasOwnProperty.call(sessionsByDate, s.date)) sessionsByDate[s.date].push(s)
  })
  Object.values(sessionsByDate).forEach(list => list.sort((a, b) => (a.order || 0) - (b.order || 0)))
  const resultPlan = publicPlan(nextPlan)
  return {
    plan: resultPlan, sessionsByDate, buckets: { plan: resultPlan, sessions: sessionsByDate },
    todayCount: (sessionsByDate[ctx.bizToday()] || []).length,
    insertedCount: docs.length, preservedCount: slots.length - docs.length
  }
}

async function confirmReorder(ctx) {
  const plan = normalizePlan(ctx.payload.plan || {})
  const today = ctx.bizToday(), planDoc = await getPlanDoc(ctx)
  const baseVersion = Number(ctx.payload.baseVersion) || 0
  if ((planDoc ? planDoc.version : 0) !== baseVersion) {
    throw bizErr(409, '计划已被其他设备修改，请刷新预览后重试')
  }
  const from = plan.startDate > today ? plan.startDate : today
  const bucketDates = Array.from({ length: 180 }, (_, i) => addDays(from, i))
  return applySchedule(ctx, { planDoc, plan, slots: expandSlots(plan, today), from: today, bucketDates })
}

/** 任务完成打卡（版本检查 + 幂等重放）。 */
async function setSessionStatus(ctx) {
  const { db, OPENID, payload } = ctx
  const sessionId = String(payload.sessionId || '')
  const res = await db.collection('sessions').doc(sessionId).get().catch(() => null)
  const doc = res && res.data
  assertOwner(doc, OPENID)
  if (doc.deleted) throw bizErr(404, '任务已删除')
  const planDoc = await getPlanDoc(ctx)
  if (planDoc && planDoc.scheduling) throw bizErr(409, '计划正在更新，请稍后重试')
  if (doc.date > ctx.bizToday()) throw bizErr(400, '未来日期不能提前完成')
  const status = payload.status === 'done' ? 'done' : 'pending'
  if (doc.status === status) return { doc }
  const baseVersion = Number(payload.baseVersion) || 0
  if (doc.version !== baseVersion) {
    throw bizErr(409, '任务状态已在其他设备更新', { kind: 'session.status', serverDoc: doc })
  }
  const updated = { status, version: doc.version + 1, updatedAt: db.serverDate() }
  const result = await db.collection('sessions').where({
    _id: sessionId, userId: OPENID, version: doc.version
  }).update({ data: updated })
  if (!result.stats || result.stats.updated !== 1) throw bizErr(409, '任务状态已在其他设备更新')
  return { doc: Object.assign({}, doc, updated) }
}

/** 新增所选日期的独立任务；请求 ID 按用户隔离，重试不重复新增。 */
async function addSession(ctx) {
  const { db, OPENID, payload } = ctx
  const date = String(payload.date || '')
  const subject = String(payload.subject || '').trim()
  const content = String(payload.content || '').trim()
  const minutes = Number(payload.suggestedMinutes)
  const requestId = String(payload.clientRequestId || '')
  if (!isValidDate(date)) throw bizErr(400, '日期格式错误')
  if (!subject || subject.length > 20) throw bizErr(400, '科目需为 1–20 个字')
  if (!content || content.length > 60) throw bizErr(400, '任务名称需为 1–60 个字')
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 600) throw bizErr(400, '建议时长为 5–600 分钟')
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(requestId)) throw bizErr(400, '缺少有效的新增请求 ID')
  const id = 'manual_' + crypto.createHash('sha256').update(OPENID + ':' + requestId).digest('hex').slice(0, 40)
  const replay = async () => {
    const found = await db.collection('sessions').doc(id).get().catch(() => null)
    if (!found || !found.data) return null
    assertOwner(found.data, OPENID)
    if (found.data.deleted) throw bizErr(409, '该次新增的任务已删除，请重新添加')
    if (found.data.date !== date || found.data.subject !== subject || found.data.content !== content || found.data.suggestedMinutes !== minutes) {
      throw bizErr(409, '该次新增已保存，请刷新确认后再添加其他任务')
    }
    return { doc: found.data }
  }
  const existed = await replay()
  if (existed) return existed
  await getUser(ctx)
  const planDoc = await getPlanDoc(ctx)
  if (planDoc && planDoc.scheduling) throw bizErr(409, '计划正在更新，请稍后重试')
  const sessions = await readAll(db.collection('sessions').where({ userId: OPENID, date }))
  const doc = {
    _id: id, userId: OPENID, planId: planDoc ? planDoc._id : '',
    date, subject, content, suggestedMinutes: minutes,
    order: sessions.reduce((max, s) => Math.max(max, Number(s.order) || 0), -1) + 1,
    source: 'manual', status: 'pending', version: 1,
    createdAt: db.serverDate(), updatedAt: db.serverDate()
  }
  try { await db.collection('sessions').add({ data: doc }) }
  catch (error) {
    const duplicate = await replay()
    if (duplicate) return duplicate
    throw error
  }
  return { doc }
}

async function taskForChange(ctx) {
  const id = String(ctx.payload.sessionId || '')
  const res = await ctx.db.collection('sessions').doc(id).get().catch(() => null)
  const doc = res && res.data
  assertOwner(doc, ctx.OPENID)
  if (doc.date !== ctx.payload.date) throw bizErr(400, '任务日期不匹配')
  const planDoc = await getPlanDoc(ctx)
  if (planDoc && planDoc.scheduling) throw bizErr(409, '计划正在更新，请稍后重试')
  return doc
}

/** 修改单条任务，不改变其日期、顺序和完成状态。 */
async function updateSession(ctx) {
  const doc = await taskForChange(ctx)
  if (doc.deleted) throw bizErr(404, '任务已删除')
  if (doc.status === 'done') throw bizErr(403, '已完成任务不能编辑，仅支持删除')
  const subject = String(ctx.payload.subject || '').trim()
  const content = String(ctx.payload.content || '').trim()
  const minutes = Number(ctx.payload.suggestedMinutes)
  if (!subject || subject.length > 20 || !content || content.length > 60) throw bizErr(400, '请填写有效的科目和任务名称')
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 600) throw bizErr(400, '建议时长为 5–600 分钟')
  if (doc.subject === subject && doc.content === content && doc.suggestedMinutes === minutes) return { doc }
  if (doc.version !== Number(ctx.payload.baseVersion)) throw bizErr(409, '任务已被其他设备修改，请刷新后重试')
  const changes = { subject, content, suggestedMinutes: minutes, source: 'manual',
    version: doc.version + 1, updatedAt: ctx.db.serverDate() }
  if (doc.scheduleSlot) changes.scheduleSlot = doc.scheduleSlot
  else if (doc.source !== 'manual') changes.scheduleSlot = { date: doc.date, subject: doc.subject, content: doc.content }
  const result = await ctx.db.collection('sessions').where({
    _id: doc._id, userId: ctx.OPENID, version: doc.version, status: doc.status
  }).update({ data: changes })
  if (!result.stats || result.stats.updated !== 1) throw bizErr(409, '任务已被修改，请刷新后重试')
  return { doc: Object.assign({}, doc, changes) }
}

/** 保留删除标记，避免模板重排后重新生成已删除的同日任务；实际学习记录不变。 */
async function removeSession(ctx) {
  const doc = await taskForChange(ctx)
  if (!doc.deleted) {
    if (doc.version !== Number(ctx.payload.baseVersion)) throw bizErr(409, '任务已被其他设备修改，请刷新后重试')
    const result = await ctx.db.collection('sessions').where({
      _id: doc._id, userId: ctx.OPENID, version: doc.version
    }).update({ data: { deleted: true, version: doc.version + 1, updatedAt: ctx.db.serverDate() } })
    if (!result.stats || result.stats.updated !== 1) throw bizErr(409, '任务已被修改，请刷新后重试')
  }
  return { deleted: true, sessionId: doc._id, date: doc.date }
}

module.exports = { getDay, getRange, previewReorder, confirmReorder, setSessionStatus, addSession, updateSession, removeSession, getPlanDoc, publicPlan, applySchedule }


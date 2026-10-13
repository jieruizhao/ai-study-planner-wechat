const {
  getUser,
  assertOwner,
  bizErr,
  isValidDate,
  readAll,
} = require('./helper')
const crypto = require('crypto')
const hash = (s) =>
  crypto.createHash('sha256').update(s).digest('hex').slice(0, 32)
async function optionalDocument(ref) {
  try {
    return await ref.get({ throwOnNotFound: false })
  } catch (error) {
    // wx-server-sdk 的事务读取可能忽略 throwOnNotFound，只兼容明确的文档缺失。
    const message = String(error.errMsg || error.message || '')
    if (
      /^document\.get:fail document with _id .+ does not exist$/.test(message)
    )
      return { data: null }
    throw error
  }
}
const addDays = (s, n) =>
  new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000)
    .toISOString()
    .slice(0, 10)
const text = (s, max) => {
  if (typeof s !== 'string' || !s.trim() || s.length > max)
    throw bizErr(400, '建议文本为空或超长')
  return s.trim()
}
function range(p, today) {
  if (
    !isValidDate(p.from) ||
    !isValidDate(p.to) ||
    p.from > p.to ||
    p.to > today ||
    Date.parse(p.to) - Date.parse(p.from) > 120 * 86400000
  )
    throw bizErr(400, '请选择120天以内、截至今天的有效日期区间')
}
async function dataset(ctx) {
  range(ctx.payload, ctx.bizToday())
  await getUser(ctx)
  const { db, _, OPENID, payload: p } = ctx
  const q = (name) =>
    readAll(
      db
        .collection(name)
        .where({ userId: OPENID, date: _.gte(p.from).and(_.lte(p.to)) }),
    )
  const [rawLogs, rawTasks, habitLogs, habits] = await Promise.all([
    q('logs'),
    q('sessions'),
    q('habitLogs'),
    readAll(db.collection('habits').where({ userId: OPENID })),
  ])
  const logs = rawLogs.filter((x) => !x.deleted),
    tasks = rawTasks.filter((x) => !x.deleted)
  const daily = {},
    byType = {}
  logs.forEach((l) => {
    const minutes = Number(l.durationMinutes) || 0
    daily[l.date] = (daily[l.date] || 0) + minutes
    byType[l.type || 'other'] = (byType[l.type || 'other'] || 0) + minutes
  })
  let expected = 0
  const expectedKeys = new Set()
  for (let date = p.from; date <= p.to; date = addDays(date, 1))
    for (const h of habits) {
      const weekday = new Date(date + 'T00:00:00Z').getUTCDay() || 7
      const createdTime = h.createdAt ? new Date(h.createdAt).getTime() : NaN
      const createdDate = Number.isFinite(createdTime)
        ? new Date(createdTime + 8 * 3600000).toISOString().slice(0, 10)
        : ''
      if (
        h.enabled !== false &&
        (h.date
          ? h.date === date
          : !h.weekdays || h.weekdays.includes(weekday)) &&
        (!createdDate || createdDate <= date)
      ) {
        expected++
        expectedKeys.add(h._id + ':' + date)
      }
    }
  const completedHabits = habitLogs.filter(
    (x) => x.status === 'done' && expectedKeys.has(x.habitId + ':' + x.date),
  ).length
  return {
    logs,
    tasks,
    habits,
    habitLogs,
    summary: {
      from: p.from,
      to: p.to,
      totalMinutes: logs.reduce(
        (n, l) => n + (Number(l.durationMinutes) || 0),
        0,
      ),
      activeDays: Object.keys(daily).length,
      logCount: logs.length,
      taskCount: tasks.length,
      doneTasks: tasks.filter((x) => x.status === 'done').length,
      completionRate: tasks.length
        ? Math.round(
            (tasks.filter((x) => x.status === 'done').length / tasks.length) *
              100,
          )
        : 0,
      habitDone: completedHabits,
      habitExpected: expected,
      habitRate: expected
        ? Math.min(100, Math.round((completedHabits / expected) * 100))
        : 0,
      daily,
      byType,
    },
  }
}
async function overview(ctx) {
  const d = await dataset(ctx)
  return { summary: d.summary }
}
function settings(p, today) {
  const startDate = p.startDate || addDays(today, 1),
    days = Number(p.days),
    dailyMinutes = Number(p.dailyMinutes)
  if (
    !isValidDate(startDate) ||
    startDate < today ||
    startDate > addDays(today, 90) ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 14 ||
    !Number.isInteger(dailyMinutes) ||
    dailyMinutes < 5 ||
    dailyMinutes > 600
  )
    throw bizErr(400, '计划周期为1–14天，每天5–600分钟，开始日期不早于今天')
  const weekdays = Array.isArray(p.weekdays)
    ? [...new Set(p.weekdays.map(Number))]
    : [1, 2, 3, 4, 5, 6, 7]
  if (
    !weekdays.length ||
    weekdays.some((x) => !Number.isInteger(x) || x < 1 || x > 7)
  )
    throw bizErr(400, '可学习星期无效')
  return {
    startDate,
    days,
    dailyMinutes,
    weekdays,
    goal: String(p.goal || '形成可持续学习习惯').slice(0, 300),
  }
}
function validatePlan(raw, s) {
  if (
    !raw ||
    !Array.isArray(raw.tasks) ||
    !Array.isArray(raw.habits) ||
    raw.tasks.length > 20 ||
    raw.habits.length > 7 ||
    (!raw.tasks.length && !raw.habits.length)
  )
    throw bizErr(400, '建议最多20条任务、7个习惯，且不能全部为空')
  const totals = {},
    keys = new Set()
  const tasks = raw.tasks.map((t) => {
    const date = String(t.date || ''),
      minutes = Number(t.minutes)
    if (
      !isValidDate(date) ||
      date < s.startDate ||
      date >= addDays(s.startDate, s.days) ||
      !s.weekdays.includes(new Date(date + 'T00:00:00Z').getUTCDay() || 7) ||
      !Number.isInteger(minutes) ||
      minutes < 5 ||
      minutes > 600
    )
      throw bizErr(400, '建议日期、可学习日或时长不符合设置')
    const row = {
      date,
      subject: text(t.subject, 20),
      content: text(t.content, 60),
      minutes,
      reason: String(t.reason || '').slice(0, 300),
    }
    const key = date + ':' + row.subject + ':' + row.content
    if (keys.has(key)) throw bizErr(400, '建议包含重复任务')
    keys.add(key)
    totals[date] = (totals[date] || 0) + minutes
    if (totals[date] > s.dailyMinutes) throw bizErr(400, '建议超过每天可用时间')
    return row
  })
  const names = new Set()
  const habits = raw.habits.map((h) => {
    const name = text(h.name, 20)
    if (names.has(name)) throw bizErr(400, '建议习惯名称重复')
    names.add(name)
    const weekdays = Array.isArray(h.weekdays)
      ? [...new Set(h.weekdays.map(Number))]
      : s.weekdays
    if (
      !weekdays.length ||
      weekdays.some((x) => x < 1 || x > 7 || !Number.isInteger(x))
    )
      throw bizErr(400, '习惯星期无效')
    return { name, weekdays, reason: String(h.reason || '').slice(0, 300) }
  })
  return { tasks, habits }
}
async function analyze(ctx) {
  if (ctx.payload.consent !== true)
    throw bizErr(400, '请先同意将所选学习数据用于AI分析')
  const s = settings(ctx.payload, ctx.bizToday()),
    data = await dataset(ctx)
  const futureTasks = (
    await readAll(
      ctx.db.collection('sessions').where({
        userId: ctx.OPENID,
        date: ctx.db.command
          .gte(s.startDate)
          .and(ctx.db.command.lt(addDays(s.startDate, s.days))),
      }),
    )
  ).filter((t) => !t.deleted)
  const quotaId = 'quota_' + hash(ctx.OPENID + ':' + ctx.bizToday())
  await ctx.db.runTransaction(async (tx) => {
    const doc = tx.collection('coachGuards').doc(quotaId),
      got = await optionalDocument(doc)
    const count = (got.data && got.data.count) || 0
    if (count >= 10) throw bizErr(429, '今天已分析10次，请明天再试')
    await doc.set({
      data: { userId: ctx.OPENID, date: ctx.bizToday(), count: count + 1 },
    })
  })
  let budget = 40000,
    omitted = 0
  const logs = data.logs
    .map((l) => {
      const row = {
        date: l.date,
        type: l.type,
        minutes: l.durationMinutes,
        content: l.content,
        note: String(l.note || ''),
        nextTip: String(l.nextTip || ''),
      }
      for (const key of ['note', 'nextTip']) {
        const value = row[key]
        row[key] = value.slice(0, Math.max(0, budget))
        budget -= row[key].length
        omitted += value.length - row[key].length
      }
      return row
    })
    .slice(0, 300)
  const id =
    'report_' + hash(ctx.OPENID + ':' + crypto.randomBytes(16).toString('hex'))
  await ctx.db.collection('coachReports').add({
    data: {
      _id: id,
      userId: ctx.OPENID,
      requestDate: ctx.bizToday(),
      status: 'running',
      createdAt: ctx.db.serverDate(),
    },
  })
  try {
    const response = await ctx.cloud.callFunction({
      name: 'studyAgent',
      // 大于 Coze 的45秒等待，并为 api 的60秒执行上限保留收尾时间。
      timeout: 55000,
      data: {
        bridgeSecret: require('process').env.STUDY_AGENT_BRIDGE_SECRET || '',
        input: {
          summary: data.summary,
          settings: s,
          existingFutureTasks: futureTasks.slice(0, 300).map((t) => ({
            date: t.date,
            subject: t.subject,
            content: t.content,
            minutes: t.suggestedMinutes,
            status: t.status,
          })),
          logs,
          recordsIncluded: logs.length,
          totalRecords: data.logs.length,
          omittedTextCharacters: omitted,
          tasks: data.tasks.slice(0, 300).map((t) => ({
            date: t.date,
            subject: t.subject,
            content: t.content,
            minutes: t.suggestedMinutes,
            status: t.status,
          })),
          habits: data.habits.map((h) => ({
            name: h.name,
            weekdays: h.weekdays,
            enabled: h.enabled,
          })),
        },
      },
    })
    const r = response.result
    if (!r || r.code !== 0)
      throw bizErr(503, (r && r.msg) || 'AI Agent调用失败，请检查部署配置')
    const result = r.data,
      plan = validatePlan(result, s)
    const analysis = {
      strengths: text(result.strengths, 3000),
      difficulties: text(result.difficulties, 3000),
      suggestions: text(result.suggestions, 3000),
    }
    const report = {
      _id: id,
      from: ctx.payload.from,
      to: ctx.payload.to,
      summary: data.summary,
      settings: s,
      ...analysis,
      ...plan,
      recordsIncluded: logs.length,
      totalRecords: data.logs.length,
      omittedTextCharacters: omitted,
      status: 'ready',
    }
    const { _id, ...savedReport } = report
    await ctx.db
      .collection('coachReports')
      .doc(id)
      .update({ data: savedReport })
    return { report }
  } catch (e) {
    await ctx.db
      .collection('coachReports')
      .doc(id)
      .update({ data: { status: 'failed' } })
    if (/timeout|timed.?out|超时/i.test(String(e.errMsg || e.message || '')))
      throw bizErr(504, 'AI分析等待超时，请稍后重试；请勿连续重复生成')
    throw e
  }
}
async function history(ctx) {
  await getUser(ctx)
  const reports = await ctx.db
    .collection('coachReports')
    .where({ userId: ctx.OPENID, status: 'ready', deleted: ctx._.neq(true) })
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get()
  const batches = await ctx.db
    .collection('coachBatches')
    .where({ userId: ctx.OPENID, deleted: ctx._.neq(true) })
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get()
  return { reports: reports.data, batches: batches.data }
}
async function reportFor(ctx) {
  const r = await ctx.db
    .collection('coachReports')
    .doc(String(ctx.payload.reportId || ''))
    .get()
  assertOwner(r.data, ctx.OPENID)
  if (r.data.deleted) throw bizErr(404, '这份分析已删除')
  if (r.data.status !== 'ready') throw bizErr(409, '分析尚未完成')
  return r.data
}
async function importPlan(ctx) {
  const r = await reportFor(ctx),
    plan = validatePlan(ctx.payload, r.settings)
  if (plan.tasks.some((t) => t.date < ctx.bizToday()))
    throw bizErr(400, '建议已过期，请重新分析')
  const { db, OPENID } = ctx,
    id = 'batch_' + hash(OPENID + ':' + r._id),
    guard = 'coach_' + hash(OPENID)
  const fingerprint = hash(JSON.stringify(plan))
  const existingPlan = await require('./plan').getPlanDoc(ctx)
  return db.runTransaction(async (tx) => {
    const currentReport = await tx.collection('coachReports').doc(r._id).get()
    assertOwner(currentReport.data, OPENID)
    if (currentReport.data.deleted) throw bizErr(404, '这份分析已删除')
    if (existingPlan) {
      const currentPlan = await tx
        .collection('plans')
        .doc(existingPlan._id)
        .get()
      if (currentPlan.data.scheduling)
        throw bizErr(409, '计划正在重排，请稍后重试')
    }
    const prior = await optionalDocument(tx.collection('coachBatches').doc(id))
    if (prior.data) {
      assertOwner(prior.data, OPENID)
      if (prior.data.status === 'undone')
        throw bizErr(409, '本次计划已撤销，请重新分析')
      if (prior.data.fingerprint !== fingerprint)
        throw bizErr(409, '本次分析已导入另一版本，请刷新')
      return { batch: prior.data }
    }
    const lock = await optionalDocument(tx.collection('coachGuards').doc(guard))
    const existing = await readAll(
      db.collection('sessions').where({
        userId: OPENID,
        date: db.command
          .gte(r.settings.startDate)
          .and(db.command.lt(addDays(r.settings.startDate, r.settings.days))),
      }),
    )
    const active = existing.filter((t) => !t.deleted),
      totals = {}
    active.forEach(
      (t) =>
        (totals[t.date] =
          (totals[t.date] || 0) + (Number(t.suggestedMinutes) || 0)),
    )
    for (const t of plan.tasks) {
      if (
        active.some(
          (x) =>
            x.date === t.date &&
            x.subject === t.subject &&
            x.content === t.content,
        )
      )
        throw bizErr(409, '已有同名同日任务，请在预览中移除重复项')
      const existingMinutes = totals[t.date] || 0
      totals[t.date] = existingMinutes + t.minutes
      if (totals[t.date] > r.settings.dailyMinutes)
        throw bizErr(
          409,
          t.date +
            ' 任务合计' +
            totals[t.date] +
            '分钟，超过本次建议的每日预算' +
            r.settings.dailyMinutes +
            '分钟。请移除或缩短建议任务；如需提高预算，请重新生成分析。',
        )
    }
    const tasks = [],
      habits = []
    for (let i = 0; i < plan.tasks.length; i++) {
      const t = plan.tasks[i],
        doc = {
          _id: 'ai_' + hash(id + ':task:' + i),
          userId: OPENID,
          source: 'manual',
          coachBatchId: id,
          date: t.date,
          subject: t.subject,
          content: t.content,
          suggestedMinutes: t.minutes,
          status: 'pending',
          version: 1,
          order: 1000 + i,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate(),
        }
      const { _id, ...taskData } = doc
      await tx.collection('sessions').doc(_id).set({ data: taskData })
      tasks.push(doc._id)
    }
    const existingHabits = await readAll(
      db.collection('habits').where({ userId: OPENID }),
    )
    for (let i = 0; i < plan.habits.length; i++) {
      const h = plan.habits[i]
      if (existingHabits.some((x) => x.name === h.name))
        throw bizErr(409, '已有同名习惯，请在预览中移除重复项')
      const doc = {
        _id: 'ai_' + hash(id + ':habit:' + i),
        userId: OPENID,
        coachBatchId: id,
        name: h.name,
        weekdays: h.weekdays,
        reminderTime: '',
        date: '',
        wxReminder: false,
        enabled: true,
        version: 1,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      }
      const { _id, ...habitData } = doc
      await tx.collection('habits').doc(_id).set({ data: habitData })
      habits.push(doc._id)
    }
    const batch = {
      _id: id,
      userId: OPENID,
      reportId: r._id,
      fingerprint,
      status: 'imported',
      from: r.settings.startDate,
      to: addDays(r.settings.startDate, r.settings.days - 1),
      tasks,
      habits,
      createdAt: db.serverDate(),
    }
    const { _id: batchId, ...batchData } = batch
    await tx.collection('coachBatches').doc(batchId).set({ data: batchData })
    await tx
      .collection('coachGuards')
      .doc(guard)
      .set({
        data: {
          userId: OPENID,
          version: ((lock.data && lock.data.version) || 0) + 1,
        },
      })
    return { batch }
  })
}
async function undo(ctx) {
  const { db, OPENID } = ctx,
    id = String(ctx.payload.batchId || '')
  const initial = await db.collection('coachBatches').doc(id).get()
  assertOwner(initial.data, OPENID)
  const logs = await readAll(db.collection('logs').where({ userId: OPENID })),
    hl = await readAll(db.collection('habitLogs').where({ userId: OPENID }))
  return db.runTransaction(async (tx) => {
    const got = await tx.collection('coachBatches').doc(id).get(),
      batch = got.data
    assertOwner(batch, OPENID)
    if (batch.status === 'undone')
      return { removed: batch.removed, kept: batch.kept }
    let removed = 0,
      kept = 0
    for (const taskId of batch.tasks) {
      const got = await optionalDocument(tx.collection('sessions').doc(taskId)),
        t = got.data
      if (!t || t.deleted) continue
      assertOwner(t, OPENID)
      if (
        t.version !== 1 ||
        t.status !== 'pending' ||
        logs.some((l) => l.sessionId === taskId)
      ) {
        kept++
        continue
      }
      await tx
        .collection('sessions')
        .doc(taskId)
        .update({
          data: { deleted: true, version: 2, updatedAt: db.serverDate() },
        })
      removed++
    }
    for (const habitId of batch.habits) {
      const got = await optionalDocument(tx.collection('habits').doc(habitId)),
        h = got.data
      if (!h) continue
      assertOwner(h, OPENID)
      if (h.version !== 1 || hl.some((l) => l.habitId === habitId)) {
        kept++
        continue
      }
      await tx.collection('habits').doc(habitId).remove()
      removed++
    }
    await tx
      .collection('coachBatches')
      .doc(id)
      .update({
        data: { status: 'undone', removed, kept, undoneAt: db.serverDate() },
      })
    return { removed, kept }
  })
}
async function deleteReport(ctx) {
  const id = String(ctx.payload.reportId || '')
  if (!/^report_[a-zA-Z0-9_]+$/.test(id)) throw bizErr(400, '分析编号无效')
  return ctx.db.runTransaction(async (tx) => {
    const ref = tx.collection('coachReports').doc(id)
    const found = await optionalDocument(ref)
    assertOwner(found.data, ctx.OPENID)
    if (!found.data.deleted)
      await ref.update({
        data: { deleted: true, deletedAt: ctx.db.serverDate() },
      })
    return { reportId: id }
  })
}
async function deleteBatch(ctx) {
  const id = String(ctx.payload.batchId || '')
  if (!/^batch_[a-zA-Z0-9_]+$/.test(id)) throw bizErr(400, '导入记录编号无效')
  return ctx.db.runTransaction(async (tx) => {
    const ref = tx.collection('coachBatches').doc(id)
    const found = await optionalDocument(ref)
    assertOwner(found.data, ctx.OPENID)
    // 删除历史展示不等于撤销计划，保留防止重复导入所需的记录。
    if (!found.data.deleted)
      await ref.update({
        data: { deleted: true, deletedAt: ctx.db.serverDate() },
      })
    return { batchId: id }
  })
}
module.exports = {
  overview,
  analyze,
  history,
  importPlan,
  undo,
  validatePlan,
  deleteReport,
  deleteBatch,
}

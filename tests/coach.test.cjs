const { test } = require('node:test')
const assert = require('node:assert/strict')
const { runtime, database, context, clone } = require('./helpers.cjs')
const today = '2026-10-11'
const settings = {
  startDate: '2026-10-12',
  days: 7,
  dailyMinutes: 90,
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  goal: '备考',
}
const draft = {
  tasks: [
    {
      date: '2026-10-12',
      subject: '阅读',
      content: '阅读定位练习',
      minutes: 30,
      reason: '改善定位',
    },
  ],
  habits: [{ name: '晚间复盘', weekdays: [1, 3, 5], reason: '保持节奏' }],
}
const report = {
  _id: 'report_ready',
  userId: 'user_a',
  status: 'ready',
  from: '2026-10-05',
  to: today,
  settings,
  ...draft,
}
function setup(seed = {}) {
  const r = runtime({
    now: new Date(2026, 9, 11, 12).getTime(),
    db: database({
      users: [{ _id: 'u', openid: 'user_a' }],
      coachReports: [clone(report)],
      ...seed,
    }),
  })
  const service = r.load('cloudfunctions/api/modules/coach.js')
  return {
    r,
    service,
    ctx: (payload, user = 'user_a') => context(r.db, payload, user, today),
  }
}
function cloudMissingDocuments(db, failure) {
  const run = db.runTransaction.bind(db)
  db.runTransaction = (fn) =>
    run((tx) => {
      const collection = tx.collection.bind(tx)
      tx.collection = (name) => ({
        doc(id) {
          const ref = collection(name).doc(id)
          const set = ref.set.bind(ref)
          ref.set = (args) => {
            if (Object.hasOwn(args.data, '_id'))
              throw new Error(
                'document.set:fail -501007 invalid parameters. 不能更新_id的值',
              )
            return set(args)
          }
          const get = ref.get.bind(ref)
          ref.get = async () => {
            if (failure) throw failure
            if (!(db.tables[name] || []).some((row) => row._id === id))
              throw new Error(
                `document.get:fail document with _id ${id} does not exist`,
              )
            return get()
          }
          return ref
        },
      })
      return fn(tx)
    })
}
test('云端事务缺失配额仍可首次分析，限额及导入撤销保持有效', async () => {
  const { r, service, ctx } = setup()
  cloudMissingDocuments(r.db)
  const c = ctx({ from: today, to: today, ...settings, consent: true })
  c.cloud = {
    callFunction: async () => ({
      result: {
        code: 0,
        data: {
          strengths: '已有记录',
          difficulties: '需要练习',
          suggestions: '逐步改善',
          ...draft,
        },
      },
    }),
  }
  await service.analyze(c)
  assert.equal(
    r.db.tables.coachGuards.find((x) => x._id.startsWith('quota_')).count,
    1,
  )
  const imported = await service.importPlan(
    ctx({ reportId: report._id, ...draft }),
  )
  const again = await service.importPlan(
    ctx({ reportId: report._id, ...draft }),
  )
  assert.equal(again.batch._id, imported.batch._id)
  // 外部删除的任务/习惯应跳过，而非阻断整个撤销。
  r.db.tables.sessions = []
  r.db.tables.habits = []
  await service.undo(ctx({ batchId: imported.batch._id }))
  const quota = r.db.tables.coachGuards.find((x) => x._id.startsWith('quota_'))
  quota.count = 10
  await assert.rejects(service.analyze(c), { code: 429 })
})
test('事务权限或网络错误不得被当作文档不存在或调用模型', async () => {
  for (const message of [
    'database permission denied',
    'network timeout',
    'collection does not exist',
  ]) {
    const { r, service, ctx } = setup()
    cloudMissingDocuments(r.db, new Error(message))
    let calls = 0
    const c = ctx({ from: today, to: today, ...settings, consent: true })
    c.cloud = {
      callFunction: async () => {
        calls++
        throw new Error('unexpected')
      },
    }
    await assert.rejects(
      service.analyze(c),
      (error) => error.message === message,
    )
    assert.equal(calls, 0)
  }
})
test('时间筛选按账号与日期统计超过100条记录，排除删除任务', async () => {
  const logs = Array.from({ length: 125 }, (_, i) => ({
    _id: 'l' + i,
    userId: 'user_a',
    date: today,
    type: 'reading',
    durationMinutes: 10,
  }))
  logs.push(
    { _id: 'foreign', userId: 'other', date: today, durationMinutes: 999 },
    { _id: 'old', userId: 'user_a', date: '2026-01-01', durationMinutes: 999 },
  )
  const { service, ctx } = setup({
    logs,
    sessions: [
      { _id: 'done', userId: 'user_a', date: today, status: 'done' },
      { _id: 'pending', userId: 'user_a', date: today, status: 'pending' },
      {
        _id: 'deleted',
        userId: 'user_a',
        date: today,
        status: 'done',
        deleted: true,
      },
    ],
  })
  const { summary } = await service.overview(ctx({ from: today, to: today }))
  assert.equal(summary.totalMinutes, 1250)
  assert.equal(summary.logCount, 125)
  assert.equal(summary.completionRate, 50)
})
test('无效、未来、过长日期区间拒绝', async () => {
  const { service, ctx } = setup()
  for (const p of [
    { from: '2026-02-30', to: today },
    { from: today, to: '2026-10-12' },
    { from: today, to: '2026-10-01' },
    { from: '2025-01-01', to: today },
  ])
    await assert.rejects(service.overview(ctx(p)), { code: 400 })
})
test('AI仅收到脱敏数据，长备注截取透明，输出校验后保存历史', async () => {
  const { r, service, ctx } = setup({
    logs: [
      {
        _id: 'private',
        userId: 'user_a',
        date: today,
        note: '字'.repeat(50000),
        durationMinutes: 30,
      },
    ],
    users: [
      {
        _id: 'u',
        openid: 'user_a',
        nickname: '不可发送',
        avatarUrl: '不可发送',
      },
    ],
  })
  const c = ctx({ from: today, to: today, ...settings, consent: true })
  let input
  c.cloud = {
    callFunction: async (args) => {
      input = args.data.input
      return {
        result: {
          code: 0,
          data: {
            strengths: '已有30分钟记录',
            difficulties: '材料截取，无法全面判断',
            suggestions: '按可用时间安排',
            ...draft,
          },
        },
      }
    },
  }
  const result = await service.analyze(c)
  assert.equal(result.report.omittedTextCharacters, 10000)
  assert.ok(!JSON.stringify(input).includes('user_a'))
  assert.ok(!JSON.stringify(input).includes('不可发送'))
  assert.equal((await service.history(ctx({}))).reports.length, 2)
})
test('未同意AI、未配置Agent及不合法模型输出不冒充成功', async () => {
  const { service, ctx } = setup()
  await assert.rejects(
    service.analyze(ctx({ from: today, to: today, ...settings })),
    { code: 400 },
  )
  const c = ctx({ from: today, to: today, ...settings, consent: true })
  c.cloud = {
    callFunction: async () => ({ result: { code: 503, msg: '尚未配置' } }),
  }
  await assert.rejects(service.analyze(c), /尚未配置/)
  c.cloud.callFunction = async () => ({
    result: {
      code: 0,
      data: {
        strengths: 'ok',
        difficulties: 'ok',
        suggestions: 'ok',
        tasks: [
          { date: '2030-01-01', subject: '阅读', content: '错误', minutes: 30 },
        ],
        habits: [],
      },
    },
  })
  await assert.rejects(service.analyze(c), { code: 400 })
})
test('导入任务和习惯并发幂等，原有任务保留，AI任务按手动项保留于重排', async () => {
  const { r, service, ctx } = setup({
    sessions: [
      {
        _id: 'original',
        userId: 'user_a',
        date: '2026-10-12',
        subject: '写作',
        content: '原任务',
        suggestedMinutes: 20,
        status: 'pending',
      },
    ],
  })
  const c = ctx({ reportId: report._id, ...draft })
  const [a, b] = await Promise.all([
    service.importPlan(c),
    service.importPlan(c),
  ])
  assert.equal(a.batch._id, b.batch._id)
  assert.equal(r.db.tables.sessions.length, 2)
  assert.equal(
    r.db.tables.sessions.find((x) => x.coachBatchId).source,
    'manual',
  )
  assert.equal(r.db.tables.habits.length, 1)
  assert.equal(r.db.tables.habits[0].wxReminder, false)
})
test('每日总量、重复安排、同名习惯、越权报告和过期计划拒绝', async () => {
  for (const seed of [
    {
      sessions: [
        {
          _id: 'existing',
          userId: 'user_a',
          date: '2026-10-12',
          suggestedMinutes: 80,
        },
      ],
    },
    {
      sessions: [
        {
          _id: 'existing',
          userId: 'user_a',
          ...draft.tasks[0],
          suggestedMinutes: 30,
        },
      ],
    },
    { habits: [{ _id: 'h', userId: 'user_a', name: '晚间复盘' }] },
  ]) {
    const { service, ctx } = setup(seed)
    await assert.rejects(
      service.importPlan(ctx({ reportId: report._id, ...draft })),
      { code: 409 },
    )
  }
  const { service, ctx } = setup()
  await assert.rejects(
    service.importPlan(ctx({ reportId: report._id, ...draft }, 'other')),
    { code: 403 },
  )
})
test('导入中途失败事务回滚，重试完整导入', async () => {
  const { r, service, ctx } = setup()
  r.db.fail('habits', 'set')
  const c = ctx({ reportId: report._id, ...draft })
  await assert.rejects(service.importPlan(c))
  assert.equal((r.db.tables.sessions || []).length, 0)
  assert.equal((r.db.tables.coachBatches || []).length, 0)
  assert.equal((await service.importPlan(c)).batch.tasks.length, 1)
})
test('撤销保留已修改任务和有打卡习惯，重复撤销幂等且不删学习记录', async () => {
  const { r, service, ctx } = setup()
  const { batch } = await service.importPlan(
    ctx({ reportId: report._id, ...draft }),
  )
  r.db.tables.sessions[0].version = 2
  r.db.tables.logs = [{ _id: 'l', userId: 'user_a', sessionId: batch.tasks[0] }]
  r.db.tables.habitLogs = [
    { _id: 'hl', userId: 'user_a', habitId: batch.habits[0], status: 'done' },
  ]
  const c = ctx({ batchId: batch._id })
  assert.equal((await service.undo(c)).kept, 2)
  assert.equal((await service.undo(c)).kept, 2)
  assert.equal(r.db.tables.logs.length, 1)
  assert.equal(r.db.tables.sessions[0].deleted, undefined)
})
test('撤销未使用建议并阻止旧报告重新导入，其他任务保留', async () => {
  const { r, service, ctx } = setup()
  const { batch } = await service.importPlan(
    ctx({ reportId: report._id, ...draft }),
  )
  r.db.tables.sessions.push({
    _id: 'original',
    userId: 'user_a',
    status: 'pending',
  })
  const result = await service.undo(ctx({ batchId: batch._id }))
  assert.equal(result.removed, 2)
  assert.equal(
    r.db.tables.sessions.find((x) => x._id === 'original').deleted,
    undefined,
  )
  await assert.rejects(
    service.importPlan(ctx({ reportId: report._id, ...draft })),
    { code: 409 },
  )
})
test('筛选切换清除旧AI结果，自定义反向区间拦截', () => {
  const { r } = setup()
  const p = r.page('review')
  p.onLoad()
  p.compute()
  assert.equal(p.data.to, today)
  assert.equal(p.data.from, '2026-10-05')
  p.data.report = report
  p.switchRange({ currentTarget: { dataset: { r: 'month' } } })
  assert.equal(p.data.report, null)
  p.dateChanged({
    currentTarget: { dataset: { field: 'from' } },
    detail: { value: '2026-10-12' },
  })
  assert.match(p.data.rangeError, /开始日期/)
})
test('前端分析、编辑、导入、撤销完整流程刷新首页与日历数据', async () => {
  const { r } = setup()
  r.getApp()
  r.options.confirm = true
  r.options.transport = async ({ module, action, payload }) => {
    const c = context(r.db, payload, 'user_a', today)
    c.cloud = {
      callFunction: async () => ({
        result: {
          code: 0,
          data: {
            strengths: '已有记录',
            difficulties: '定位困难',
            suggestions: '规律练习',
            ...draft,
          },
        },
      }),
    }
    return r.load('cloudfunctions/api/modules/' + module + '.js')[action](c)
  }
  const p = r.page('review')
  p.onLoad()
  p.compute()
  p.data.consent = true
  await p.analyze()
  assert.equal(p.data.tasks.length, 1)
  p.editTask({
    currentTarget: { dataset: { index: 0, field: 'content' } },
    detail: { value: '用户编辑的练习' },
  })
  await p.importSuggestions()
  assert.equal(r.store().sessionsOf('2026-10-12')[0].content, '用户编辑的练习')
  assert.equal(r.store().get().habits.length, 1)
  const batch = p.data.batches.find((x) => x.status === 'imported')
  assert.ok(batch)
  await p.undoBatch({ currentTarget: { dataset: { id: batch._id } } })
  assert.equal(r.store().sessionsOf('2026-10-12').length, 0)
  assert.equal(r.store().get().habits.length, 0)
})
test('并发AI调用限额事务保护，每天最多10次', async () => {
  const { service, ctx } = setup()
  const make = () => {
    const c = ctx({ from: today, to: today, ...settings, consent: true })
    c.cloud = {
      callFunction: async () => ({
        result: {
          code: 0,
          data: {
            strengths: '依据',
            difficulties: '观察',
            suggestions: '建议',
            ...draft,
          },
        },
      }),
    }
    return service.analyze(c)
  }
  const results = await Promise.allSettled(Array.from({ length: 11 }, make))
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 10)
  assert.equal(results.find((x) => x.status === 'rejected').reason.code, 429)
})
test('AI链路等待覆盖模型45秒窗口，SDK超时对象转为业务提示', async () => {
  const { r, service, ctx } = setup()
  const c = ctx({ from: today, to: today, ...settings, consent: true })
  c.cloud = {
    callFunction: async (args) => {
      assert.ok(args.timeout > 45000 && args.timeout < 60000)
      throw { errMsg: 'callFunction:fail ESOCKETTIMEDOUT' }
    },
  }
  await assert.rejects(
    service.analyze(c),
    (e) => e.code === 504 && /等待超时/.test(e.message),
  )
  assert.equal(
    r.db.tables.coachReports.find((x) => x._id !== report._id).status,
    'failed',
  )
})
test('传输超时恢复本次已保存报告，未完成时不自动重发或误用历史报告', async () => {
  for (const saved of [true, false]) {
    const { r, service, ctx } = setup()
    r.getApp()
    let calls = 0
    r.options.transport = async ({ module, action, payload }) => {
      if (module === 'coach' && action === 'analyze') {
        calls++
        if (saved)
          r.db.tables.coachReports.push({ ...clone(report), _id: 'recovered' })
        throw new Error('callFunction:fail ESOCKETTIMEDOUT')
      }
      return r
        .load('cloudfunctions/api/modules/' + module + '.js')
        [action](ctx(payload))
    }
    const p = r.page('review')
    p.onLoad()
    p.compute()
    Object.assign(p.data, {
      consent: true,
      goal: settings.goal,
      planStart: settings.startDate,
      planDaysInput: settings.days,
      dailyMinutes: settings.dailyMinutes,
      weekdays: settings.weekdays,
      reports: [clone(report)],
    })
    await p.analyze()
    assert.equal(calls, 1)
    assert.equal(p.data.analyzing, false)
    if (saved) assert.equal(p.data.report._id, 'recovered')
    else {
      assert.equal(p.data.report, null)
      assert.match(p.data.coachError, /历史分析/)
      assert.ok(!p.data.coachError.includes('ESOCKETTIMEDOUT'))
    }
  }
})
test('删除分析按账号隔离且幂等，已导入任务习惯保留并仍可撤销', async () => {
  const { r, service, ctx } = setup()
  cloudMissingDocuments(r.db)
  const imported = await service.importPlan(
    ctx({ reportId: report._id, ...draft }),
  )
  await assert.rejects(
    service.deleteReport(ctx({ reportId: report._id }, 'other')),
    { code: 403 },
  )
  await service.deleteReport(ctx({ reportId: report._id }))
  await service.deleteReport(ctx({ reportId: report._id }))
  assert.equal((await service.history(ctx({}))).reports.length, 0)
  assert.equal(r.db.tables.sessions.filter((t) => !t.deleted).length, 1)
  assert.equal(r.db.tables.habits.length, 1)
  assert.equal((await service.history(ctx({}))).batches.length, 1)
  await assert.rejects(
    service.importPlan(ctx({ reportId: report._id, ...draft })),
    { code: 404 },
  )
  await service.undo(ctx({ batchId: imported.batch._id }))
  assert.equal(r.db.tables.sessions.filter((t) => !t.deleted).length, 0)
})
test('导入错误使用独立按钮下方提示，历史删除取消与失败不清除预览', async () => {
  const { r } = setup()
  r.getApp()
  r.options.confirm = true
  const p = r.page('review')
  p.onLoad()
  p.compute()
  p.showReport(clone(report))
  p.data.reports = [clone(report)]
  r.options.transport = async ({ module, action, payload }) => {
    if (module === 'coach' && action === 'importPlan')
      throw Object.assign(new Error('超过本次建议的每日预算'), {
        biz: true,
        code: 409,
      })
    return r
      .load('cloudfunctions/api/modules/' + module + '.js')
      [action](context(r.db, payload, 'user_a', today))
  }
  await p.importSuggestions()
  assert.match(p.data.importError, /预算/)
  assert.equal(p.data.coachError, '')
  r.options.confirm = false
  await p.deleteReport({ currentTarget: { dataset: { id: report._id } } })
  assert.equal(p.data.reports.length, 1)
  r.options.confirm = true
  r.db.fail('coachReports', 'update')
  await p.deleteReport({ currentTarget: { dataset: { id: report._id } } })
  assert.equal(p.data.report._id, report._id)
  assert.equal(p.data.reports.length, 1)
  assert.ok(p.data.historyError)
  await p.deleteReport({ currentTarget: { dataset: { id: report._id } } })
  assert.equal(p.data.report, null)
  assert.equal(p.data.reports.length, 0)
  assert.equal(p.data.planBusy, false)
})
test('导入历史删除隔离账号且保留任务与防重信息，已撤销记录不能重新导入', async () => {
  for (const undone of [false, true]) {
    const { r, service, ctx } = setup()
    const batch = (
      await service.importPlan(ctx({ reportId: report._id, ...draft }))
    ).batch
    if (undone) await service.undo(ctx({ batchId: batch._id }))
    const before = JSON.stringify({
      sessions: r.db.tables.sessions,
      habits: r.db.tables.habits,
    })
    await assert.rejects(
      service.deleteBatch(ctx({ batchId: batch._id }, 'other')),
      { code: 403 },
    )
    await service.deleteBatch(ctx({ batchId: batch._id }))
    await service.deleteBatch(ctx({ batchId: batch._id }))
    assert.equal((await service.history(ctx({}))).batches.length, 0)
    assert.equal((await service.history(ctx({}))).reports.length, 1)
    assert.equal(
      JSON.stringify({
        sessions: r.db.tables.sessions,
        habits: r.db.tables.habits,
      }),
      before,
    )
    if (undone)
      await assert.rejects(
        service.importPlan(ctx({ reportId: report._id, ...draft })),
        { code: 409 },
      )
    else
      assert.equal(
        (await service.importPlan(ctx({ reportId: report._id, ...draft })))
          .batch._id,
        batch._id,
      )
    assert.equal(r.db.tables.coachBatches.length, 1)
  }
})
test('删除导入历史取消或失败保留列表，成功才移除并显示二次确认说明', async () => {
  const { r, service, ctx } = setup()
  r.getApp()
  const batch = (
    await service.importPlan(ctx({ reportId: report._id, ...draft }))
  ).batch
  const p = r.page('review')
  p.data.batches = [clone(batch)]
  const ev = { currentTarget: { dataset: { id: batch._id } } }
  r.options.confirm = false
  await p.deleteBatch(ev)
  assert.equal(p.data.batches.length, 1)
  r.options.confirm = true
  r.db.fail('coachBatches', 'update')
  await p.deleteBatch(ev)
  assert.equal(p.data.batches.length, 1)
  assert.ok(p.data.batchError)
  assert.equal(p.data.coachError, '')
  await p.deleteBatch(ev)
  assert.equal(p.data.batches.length, 0)
  assert.equal(p.data.planBusy, false)
  assert.equal(p.data.batchError, '')
  assert.ok(
    r.calls.some((c) => c.name === 'modal' && /撤销入口/.test(c.content)),
  )
})
test('api入口开放两种历史删除并保留身份校验和内部方法白名单限制', async () => {
  const { r } = setup({
    coachBatches: [{ _id: 'batch_entry', userId: 'user_a', status: 'undone', tasks: [], habits: [] },
      { _id: 'batch_other', userId: 'other', status: 'undone', tasks: [], habits: [] }],
  })
  const entry = r.load('cloudfunctions/api/index.js')
  const batch = await entry.main({ module: 'coach', action: 'deleteBatch', payload: { batchId: 'batch_entry' } })
  assert.equal(batch.code, 0)
  assert.equal(r.db.tables.coachBatches.find((b) => b._id === 'batch_entry').deleted, true)
  const removedReport = await entry.main({ module: 'coach', action: 'deleteReport', payload: { reportId: report._id } })
  assert.equal(removedReport.code, 0)
  assert.equal(r.db.tables.coachReports.find((x) => x._id === report._id).deleted, true)
  assert.equal((await entry.main({ module: 'coach', action: 'deleteBatch', payload: { batchId: 'batch_other' } })).code, 403)
  assert.ok(!r.db.tables.coachBatches.find((b) => b._id === 'batch_other').deleted)
  assert.equal((await entry.main({ module: 'coach', action: 'validatePlan', payload: draft })).code, 404)
  assert.equal((await entry.main({ module: 'coach', action: 'constructor', payload: {} })).code, 404)
})

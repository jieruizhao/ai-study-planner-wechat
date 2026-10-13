/**
 * 习惯与提醒配置模块
 * habitLogs 保留历史（删除习惯不停用打卡记录）；提醒配置同步维护到 reminders 集合供调度器使用
 */
const { getUser, assertOwner, bizErr, isValidDate, readAll } = require('./helper')

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]

function normalizeHabit(input) {
  const name = String(input.name || '').trim()
  if (!name) throw bizErr(400, '习惯名称不能为空')
  const weekdays = (input.weekdays || []).map(Number).filter(n => WEEKDAYS.indexOf(n) >= 0)
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.reminderTime || '') ? input.reminderTime : ''
  const date = String(input.date || '')
  if (date && !isValidDate(date)) throw bizErr(400, '提醒日期无效')
  if (date && !time) throw bizErr(400, '当日提醒必须设置时间')
  return {
    name: name.slice(0, 20),
    icon: String(input.icon || '◎').slice(0, 8),
    reminderTime: time,
    date,
    weekdays: weekdays.length ? weekdays.sort((a, b) => a - b) : WEEKDAYS.slice(),
    wxReminder: !!input.wxReminder,   // 微信订阅消息渠道
    miniprogramState: ['developer','trial','formal'].includes(input.miniprogramState) ? input.miniprogramState : '',
    enabled: input.enabled !== false
  }
}

async function listAll(ctx) {
  const { db, OPENID } = ctx
  await getUser(ctx)
  const habits = await readAll(db.collection('habits').where({ userId: OPENID }).orderBy('createdAt', 'asc'))
  return { habits }
}

/** 保存（新建或更新）：客户端生成 _id，天然幂等 */
async function save(ctx) {
  const { db, OPENID, payload } = ctx
  await getUser(ctx)
  const habit = normalizeHabit(payload)
  const _id = String(payload._id || '').slice(0, 40)
  if (!_id) throw bizErr(400, '缺少习惯 ID')

  const existed = await db.collection('habits').doc(_id).get().catch(() => null)
  habit.miniprogramState = habit.miniprogramState || (existed && existed.data && existed.data.miniprogramState) || 'formal'
  if (habit.date && habit.date < ctx.bizToday() && !(existed && existed.data)) throw bizErr(400, '不能新增过去日期的提醒')
  let doc
  if (existed && existed.data) {
    assertOwner(existed.data, OPENID)
    doc = Object.assign({}, existed.data, habit, { version: (existed.data.version || 1) + 1, updatedAt: db.serverDate() })
    await db.collection('habits').doc(_id).update({ data: {
      name: doc.name, icon: doc.icon, reminderTime: doc.reminderTime, date: doc.date,
      weekdays: doc.weekdays, wxReminder: doc.wxReminder, miniprogramState: doc.miniprogramState,
      enabled: doc.enabled, version: doc.version, updatedAt: doc.updatedAt
    } })
  } else {
    doc = Object.assign({ _id, userId: OPENID, version: 1, createdAt: db.serverDate(), updatedAt: db.serverDate() }, habit)
    await db.collection('habits').add({ data: doc })
  }

  // 同步提醒配置（调度器数据源）；微信渠道关闭时调度器自动跳过
  if (doc.reminderTime) {
    const reminder = {
      userId: OPENID, reminderId: _id, type: 'habit', refId: _id,
      title: doc.name, time: doc.reminderTime, weekdays: doc.weekdays, date: doc.date,
      wechatEnabled: doc.wxReminder !== false && doc.enabled,
      miniprogramState: doc.miniprogramState,
      enabled: doc.enabled, updatedAt: db.serverDate()
    }
    const r = await db.collection('reminders').where({ userId: OPENID, reminderId: _id }).get()
    if (r.data.length) {
      await db.collection('reminders').doc(r.data[0]._id).update({ data: reminder })
    } else {
      await db.collection('reminders').add({ data: reminder })
    }
  } else {
    // 未设提醒时间 → 移除提醒配置（保留历史打卡）
    await db.collection('reminders').where({ userId: OPENID, reminderId: _id }).remove().catch(() => {})
  }
  return { habit: doc }
}

/** 删除习惯：停用提醒，保留历史打卡记录 */
async function remove(ctx) {
  const { db, OPENID, payload } = ctx
  const habitId = String(payload.habitId || '')
  const existed = await db.collection('habits').doc(habitId).get().catch(() => null)
  if (existed && existed.data) {
    assertOwner(existed.data, OPENID)
    await db.collection('habits').doc(habitId).remove()
  }
  await db.collection('reminders').where({ userId: OPENID, reminderId: habitId }).remove().catch(() => {})
  return { removed: true }
}

/** 打卡/跳过：_id = date_habitId 幂等 */
async function logStatus(ctx) {
  const { db, OPENID, payload } = ctx
  await getUser(ctx)
  const habitId = String(payload.habitId || '')
  const date = String(payload.date || '')
  if (!habitId || !isValidDate(date)) throw bizErr(400, '参数错误')
  if (date > ctx.bizToday()) throw bizErr(400, '未来日期不能提前打卡')
  const parent = await db.collection('habits').doc(habitId).get().catch(() => null)
  assertOwner(parent && parent.data, OPENID)
  if (parent.data.date && parent.data.date !== date) throw bizErr(400, '该提醒仅在指定日期生效')
  const status = ['done', 'skipped', 'none'].indexOf(payload.status) >= 0 ? payload.status : 'none'
  const _id = date + '_' + habitId
  const existingLog = await db.collection('habitLogs').doc(_id).get().catch(() => null)
  if (existingLog && existingLog.data) assertOwner(existingLog.data, OPENID)
  if (status === 'none') {
    await db.collection('habitLogs').doc(_id).remove().catch(() => {})
    return { status }
  }
  const existed = await db.collection('habitLogs').doc(_id).get().catch(() => null)
  if (existed && existed.data) {
    if (existed.data.status !== status) {
      await db.collection('habitLogs').doc(_id).update({ data: { status, updatedAt: db.serverDate() } })
    }
  } else {
    await db.collection('habitLogs').add({
      data: { _id, userId: OPENID, habitId, date, status, createdAt: db.serverDate(), updatedAt: db.serverDate() }
    })
  }
  return { status }
}

/** 订阅消息模板 ID（在小程序后台申请后写入 configs 集合：{key:'subscribe', templateId:'...'}） */
async function getTemplate(ctx) {
  const { db } = ctx
  const res = await db.collection('configs').where({ key: 'subscribe' }).limit(1).get().catch(() => ({ data: [] }))
  return { templateId: res.data.length ? res.data[0].templateId : '' }
}

module.exports = { listAll, save, remove, logStatus, getTemplate }

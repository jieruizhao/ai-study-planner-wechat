/** 学习记录模块 */
const { getUser, assertOwner, bizErr, isValidDate, readAll } = require('./helper')

const VALID_TYPES = ['listening', 'reading', 'writing', 'speaking', 'vocab', 'other']
function longText(value) {
  const text = String(value == null ? '' : value)
  if (text.length > 10000) throw bizErr(400, '每项文本最多10000字')
  return text
}

/** 新增记录：_id 使用客户端生成的 clientTempId，天然幂等（重复提交返回同一记录） */
async function add(ctx) {
  const { db, OPENID, payload } = ctx
  const user = await getUser(ctx)
  const date = String(payload.date || '')
  if (!isValidDate(date)) throw bizErr(400, '日期格式错误')
  if (date > ctx.bizToday()) throw bizErr(400, '未来日期不能提前记录')
  const type = VALID_TYPES.indexOf(payload.type) >= 0 ? payload.type : 'other'
  const minutes = Math.max(0, Math.min(1440, Number(payload.durationMinutes) || 0))
  const _id = String(payload.clientTempId || '').slice(0, 40)
  if (!_id) throw bizErr(400, '缺少记录 ID')

  const existed = await db.collection('logs').doc(_id).get().catch(() => null)
  if (existed && existed.data) {
    assertOwner(existed.data, OPENID)
    return { serverIdMap: { [_id]: _id }, doc: existed.data }
  }

  const sessionId = String(payload.sessionId || '')
  if (sessionId) {
    const result = await db.collection('sessions').doc(sessionId).get().catch(() => null)
    assertOwner(result && result.data, OPENID)
    if (result.data.date !== date) throw bizErr(400, '任务日期与记录日期不一致')
  }
  const doc = {
    _id,
    userId: OPENID,
    date,
    type,
    sessionId,
    durationMinutes: minutes,
    content: String(payload.content || '').slice(0, 200),
    note: longText(payload.note),
    nextTip: longText(payload.nextTip),
    version: 1,
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  }
  await db.collection('logs').add({ data: doc })
  return { serverIdMap: { [_id]: _id }, doc }
}

/** 更新：版本检查，长文本冲突不静默覆盖（返回双方版本由用户端处理） */
async function update(ctx) {
  const { db, OPENID, payload } = ctx
  const logId = String(payload.logId || '')
  const res = await db.collection('logs').doc(logId).get().catch(() => null)
  const doc = res && res.data
  assertOwner(doc, OPENID)

  if (!payload.patch || typeof payload.patch !== 'object') throw bizErr(400, '缺少修改内容')
  const patch = {}
  if ('durationMinutes' in payload.patch) patch.durationMinutes = Math.max(0, Math.min(1440, Number(payload.patch.durationMinutes) || 0))
  if ('content' in payload.patch) patch.content = String(payload.patch.content || '').slice(0, 200)
  if ('note' in payload.patch) patch.note = longText(payload.patch.note)
  if ('nextTip' in payload.patch) patch.nextTip = longText(payload.patch.nextTip)
  if ('type' in payload.patch && VALID_TYPES.indexOf(payload.patch.type) >= 0) patch.type = payload.patch.type

  // 幂等重放：目标值与服务器一致视为成功
  const replay = Object.keys(patch).every(k => doc[k] === patch[k])
  if (replay) return { doc }

  const baseVersion = Number(payload.baseVersion) || 0
  if (doc.version !== baseVersion) {
    throw bizErr(409, '该记录已在其他设备被修改', {
      kind: 'log.update',
      serverDoc: doc,
      clientDoc: Object.assign({}, doc, patch)
    })
  }
  const updated = Object.assign({}, patch, { version: doc.version + 1, updatedAt: db.serverDate() })
  const result = await db.collection('logs').where({ _id: logId, userId: OPENID, version: doc.version }).update({ data: updated })
  if (!result.stats || result.stats.updated !== 1) throw bizErr(409, '记录已变更，请刷新重试')
  return { doc: Object.assign({}, doc, updated) }
}

/** 删除：幂等 */
async function remove(ctx) {
  const { db, OPENID, payload } = ctx
  const logId = String(payload.logId || '')
  const res = await db.collection('logs').doc(logId).get().catch(() => null)
  if (!res || !res.data) return { removed: true }
  assertOwner(res.data, OPENID)
  await db.collection('logs').doc(logId).remove()
  return { removed: true }
}

async function listByDate(ctx) {
  const { db, _, OPENID, payload } = ctx
  const res = await db.collection('logs')
    .where({ userId: OPENID, date: payload.date })
    .orderBy('createdAt', 'asc').get()
  return { logs: res.data }
}

module.exports = { add, update, remove, listByDate }

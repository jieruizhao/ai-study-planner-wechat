/**
 * 离线同步模块
 * - 每个 operationId 只处理一次（syncOps 集合幂等去重，重复提交返回首次结果）
 * - 版本检查：不匹配返回 409 + 双方文档，客户端「保留双方版本」，绝不静默覆盖
 */
const user = require('./user')
const log = require('./log')
const habit = require('./habit')
const plan = require('./plan')

const HANDLERS = {
  'log.add': (ctx, p) => log.add(ctx, p),
  'log.update': (ctx, p) => log.update(ctx, p),
  'log.delete': (ctx, p) => log.remove(ctx, p),
  'session.status': (ctx, p) => plan.setSessionStatus(ctx, p),
  'habit.log': (ctx, p) => habit.logStatus(ctx, p),
  'habit.save': (ctx, p) => habit.save(ctx, p),
  'habit.delete': (ctx, p) => habit.remove(ctx, p),
  'profile.update': (ctx, p) => user.updateProfile(ctx, p)
}

async function batch(ctx) {
  const { db, OPENID, payload } = ctx
  const operations = (payload.operations || []).slice(0, 50)
  const results = []
  for (const op of operations) {
    const operationId = String(op.operationId || '')
    if (!operationId || !Object.prototype.hasOwnProperty.call(HANDLERS, op.type)) {
      results.push({ operationId, code: 400, msg: '无效操作' })
      continue
    }
    // 幂等：已有处理结果直接返回
    const existed = await db.collection('syncOps').doc(operationId).get().catch(() => null)
    if (existed && existed.data) {
      if (existed.data.userId !== OPENID) {
        results.push({ operationId, code: 403, msg: '无权访问该同步操作' })
        continue
      }
      if (existed.data.result && (existed.data.result.code === 0 || (existed.data.result.code === 409 && existed.data.result.data && existed.data.result.data.serverDoc))) {
        results.push(Object.assign({ operationId }, existed.data.result))
        continue
      }
      // 旧版本留下的失败结果允许修复后重试。
      await db.collection('syncOps').doc(operationId).remove()
    }
    let result
    try {
      const operationPayload = Object.assign({}, op.payload || {})
      if (op.baseVersion != null && operationPayload.baseVersion == null) operationPayload.baseVersion = op.baseVersion
      const operationContext = Object.assign({}, ctx, { payload: operationPayload })
      const data = await HANDLERS[op.type](operationContext, operationPayload)
      result = { code: 0, data }
    } catch (e) {
      if (e && e.biz) {
        result = { code: e.code, msg: e.message, data: e.data }
      } else {
        console.error('[sync] op failed', operationId, op.type, e)
        result = { code: 500, msg: e.message || '处理失败' }
      }
    }
    if (result.code === 0 || (result.code === 409 && result.data && result.data.serverDoc)) try {
      await db.collection('syncOps').add({
        data: {
          _id: operationId, userId: OPENID, type: op.type,
          result, createdAt: db.serverDate()
        }
      })
    } catch (e) { /* _id 冲突即并发重复处理，结果一致 */ }
    results.push(Object.assign({ operationId }, result))
  }
  return { results }
}

module.exports = { batch }

/**
 * api 云函数：业务 API 聚合入口（模块化单体）
 * 客户端统一调用：wx.cloud.callFunction({ name:'api', data:{ module, action, payload } })
 * 身份：从微信上下文 OPENID 获取，绝不信任客户端传入的 userId
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const COLLECTIONS = [
  'users', 'plans', 'sessions', 'logs', 'habits', 'habitLogs',
  'reminders', 'dispatches', 'syncOps', 'configs', 'reorderLogs', 'deletionJobs',
  'coachReports', 'coachBatches', 'coachGuards'
]

let ensurePromise = null
function ensureCollections(cloud) {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const db = cloud.database()
      for (const name of COLLECTIONS) {
        try { await db.createCollection(name) } catch (e) { /* 已存在 */ }
      }
    })().catch(e => { ensurePromise = null; throw e })
  }
  return ensurePromise
}

const modules = {
  user: require('./modules/user'),
  plan: require('./modules/plan'),
  log: require('./modules/log'),
  habit: require('./modules/habit'),
  stats: require('./modules/stats'),
  sync: require('./modules/sync'),
  data: require('./modules/data'), coach: require('./modules/coach')
}

const ACTIONS = {
  user: ['login','authorize','updateProfile'], plan: ['getDay','getRange','previewReorder','confirmReorder','setSessionStatus','addSession','updateSession','removeSession'],
  log: ['add','update','remove','listByDate'], habit: ['listAll','save','remove','logStatus','getTemplate'],
  coach: ['overview','analyze','history','importPlan','undo','deleteReport','deleteBatch'],
  stats: ['overview'], sync: ['batch'], data: ['exportAll','exportExcel','requestDeletion','resetPlan','importPreview','importApply']
}
// 业务日期以用户本地时区（默认 Asia/Shanghai）计算
const TZ_OFFSET_MIN = 8 * 60

function bizToday(offsetMin) {
  const off = (typeof offsetMin === 'number' ? offsetMin : TZ_OFFSET_MIN) * 60000
  const d = new Date(Date.now() + off)
  const p = n => (n < 10 ? '0' + n : '' + n)
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { module, action, payload = {} } = event || {}
  if (!OPENID) return { code: 401, msg: '无法获取微信身份' }
  const m = Object.prototype.hasOwnProperty.call(modules, module) ? modules[module] : null
  if (!m || !ACTIONS[module] || ACTIONS[module].indexOf(action) < 0 || typeof m[action] !== 'function') {
    return { code: 404, msg: `未知接口 ${module}.${action}` }
  }
  try {
    await ensureCollections(cloud)
    const ctx = {
      cloud,
      db: cloud.database(),
      _: cloud.database().command,
      OPENID,
      payload: payload || {},
      bizToday: () => bizToday(payload && payload.timezoneOffsetMin)
    }
    const data = await m[action](ctx)
    return { code: 0, data }
  } catch (e) {
    if (e && e.biz) return { code: e.code, msg: e.message, data: e.data }
    console.error(`[api] ${module}.${action} failed:`, e)
    return { code: 500, msg: e.message || '服务异常' }
  }
}

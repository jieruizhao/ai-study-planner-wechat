/** 云函数模块公共工具 */
function bizErr(code, msg, data) {
  const e = new Error(msg)
  e.biz = true
  e.code = code
  if (data) e.data = data
  return e
}

function pad(n) { return n < 10 ? '0' + n : '' + n }

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const time = Date.parse(value + 'T00:00:00.000Z')
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

/** 云数据库按 100 条分页，避免默认/单页上限截断任务。 */
async function readAll(query) {
  const result = []
  for (let offset = 0; ; offset += 100) {
    const page = await query.skip(offset).limit(100).get()
    result.push(...page.data)
    if (page.data.length < 100) return result
  }
}

/** 按 OPENID 取用户，不存在则创建（登录即注册，不强制头像昵称手机号） */
async function getUser(ctx) {
  const { db, OPENID } = ctx
  const res = await db.collection('users').where({ openid: OPENID }).orderBy('createdAt', 'asc').limit(1).get()
  if (res.data.length) return res.data[0]
  const userId = 'user_' + require('crypto').createHash('sha1').update(OPENID).digest('hex').slice(0, 24)
  const doc = {
    _id: userId,
    openid: OPENID,
    openidMask: 'wx_' + OPENID.slice(-6),
    examDate: null,
    timezone: 'Asia/Shanghai',
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  }
  try {
    await db.collection('users').add({ data: doc })
    return doc
  } catch (error) {
    const existing = await db.collection('users').doc(userId).get().catch(() => null)
    if (existing && existing.data && existing.data.openid === OPENID) return existing.data
    throw error
  }
}

/** 校验资源归属，防止越权访问他人数据 */
function assertOwner(doc, OPENID) {
  if (!doc) throw bizErr(404, '数据不存在')
  if (doc.userId !== OPENID) throw bizErr(403, '无权访问该数据')
}

module.exports = { bizErr, getUser, assertOwner, pad, isValidDate, readAll }


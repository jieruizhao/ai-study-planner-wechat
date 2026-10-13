/** 用户模块：登录与资料 */
const { getUser, bizErr, isValidDate } = require('./helper')

async function login(ctx) {
  const user = await getUser(ctx)
  if (ctx.payload && ctx.payload.authorize === true && !user.accountAuthorized) {
    await ctx.db.collection('users').doc(user._id).update({ data: { accountAuthorized: true, updatedAt: ctx.db.serverDate() } })
    user.accountAuthorized = true
  }
  return {
    openidMask: user.openidMask,
    accountId: user._id,
    examDate: user.examDate || null,
    timezone: user.timezone,
    nickname: user.nickname || '',
    avatarUrl: user.avatarUrl || '',
    accountAuthorized: !!user.accountAuthorized
  }
}

async function updateProfile(ctx) {
  const { db, _, OPENID, payload } = ctx
  const user = await getUser(ctx)
  const patch = {}
  if ('examDate' in payload) {
    if (payload.examDate && !isValidDate(payload.examDate)) throw bizErr(400, '考试日期无效')
    patch.examDate = payload.examDate || null
  }
  if ('nickname' in payload) patch.nickname = String(payload.nickname || '').slice(0, 30)
  if ('avatarUrl' in payload) {
    const avatar = String(payload.avatarUrl || '')
    if (avatar && (!/^cloud:\/\//.test(avatar) || avatar.length > 500)) throw bizErr(400, '头像文件无效，请重新选择')
    patch.avatarUrl = avatar
  }
  if (!Object.keys(patch).length) return login(ctx)
  await db.collection('users').doc(user._id).update({
    data: Object.assign(patch, { updatedAt: db.serverDate() })
  })
  return login(ctx)
}
async function authorize(ctx) {
  const user = await getUser(ctx)
  await ctx.db.collection('users').doc(user._id).update({ data: { accountAuthorized: true, updatedAt: ctx.db.serverDate() } })
  return login(ctx)
}

module.exports = { login, updateProfile, authorize }

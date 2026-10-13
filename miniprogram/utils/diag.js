/**
 * 开发期自检（仅在开发版/体验版生效，正式版静默）
 * 用途：集中暴露 undefined/NaN 渲染、图标缺失、云函数失败、离线队列堆积等问题
 * 使用：开发者工具 Console 过滤 "[self-check]" 查看；也可在页面调用 wx.__diag() 手动输出
 */
let issues = []
let inited = false

function isDev() {
  try {
    const info = wx.getAccountInfoSync ? wx.getAccountInfoSync() : null
    const env = info && info.miniProgram ? info.miniProgram.envVersion : 'develop'
    return env !== 'release'
  } catch (e) { return true }
}

function report(kind, detail) {
  if (!isDev()) return
  const item = { kind, detail, at: new Date().toLocaleTimeString('zh-CN') }
  issues.push(item)
  console.warn('[self-check]', kind, detail)
}

/** 扫描对象里值为 undefined / NaN / 空字符串的字段（用于页面 setData 前自检） */
function scanUndefined(obj, path, out) {
  path = path || ''
  out = out || []
  if (obj === null || obj === undefined) { out.push({ path, value: obj }); return out }
  if (typeof obj === 'number' && isNaN(obj)) { out.push({ path, value: 'NaN' }); return out }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => scanUndefined(v, path + '[' + i + ']', out))
    return out
  }
  if (typeof obj === 'object') {
    // 跳过云数据库时间对象等特殊对象
    if (obj.$date || obj instanceof Date) return out
    Object.keys(obj).forEach(k => scanUndefined(obj[k], path ? path + '.' + k : k, out))
  }
  return out
}

/** 记录一次云函数调用失败 */
function reportApi(module, action, err) {
  const msg = (err && (err.msg || err.errMsg || err.message)) || String(err)
  report('api-fail', `${module}.${action} → ${msg} (code=${err && err.code})`)
}

/** 图标资源缺失（在 config 中声明后由 checkAssets 校验） */
function checkAssets(list) {
  if (!isDev()) return
  list.forEach(path => {
    wx.getFileSystemManager().access({
      path: path,
      fail: () => report('asset-missing', path)
    })
  })
}

/** 离线队列堆积提醒 */
function checkQueue(count) {
  if (count >= 20) report('queue-backlog', `待同步操作 ${count} 条，可能长时间离线或云函数未部署`)
}

function dump() {
  if (!issues.length) {
    console.log('[self-check] 未发现问题 ✅')
    return []
  }
  console.table(issues)
  return issues.slice()
}

function init() {
  if (inited || !isDev()) return
  inited = true
  wx.__diag = dump   // 控制台执行 wx.__diag() 查看全部问题
  console.log('[self-check] 已启用，控制台执行 wx.__diag() 查看诊断结果')
}

module.exports = { init, report, scanUndefined, reportApi, checkAssets, checkQueue, dump }

// 云函数调用封装：api.call(module, action, payload)
// 返回 data 部分；code!==0 时 reject {code, msg}
const diag = require('./diag')
const store = require('./store')

function cloudError(err) {
  const raw = String(err && (err.errMsg || err.message) || '')
  let message = '云服务调用失败，请检查云环境和 api 部署状态'
  if (/res?ource is not found|资源不存在/i.test(raw)) message = '云资源不存在，请核对 app.js 中的云环境 ID 与 api 部署环境是否一致'
  else if (/FUNCTION_NOT_FOUND|function.*not.*found|Cannot find module|云函数不存在|依赖/i.test(raw)) message = 'api 云函数未部署或依赖缺失，请上传并部署（云端安装依赖）'
  else if (/timeout|timed.?out|超时/i.test(raw)) message = '云服务响应超时，操作结果尚未确认，请刷新后重试'
  else if (/network|offline|ENET|断网|网络/i.test(raw)) message = '网络连接失败，请检查手机网络后重试'
  else if (/permission|auth|access.*denied|权限/i.test(raw)) message = '云服务权限异常，请检查云环境配置'
  return Object.assign(new Error(message), { code: -1, errCode: err && err.errCode, errMsg: raw })
}

function call(module, action, payload, opt) {
  const accountState = store.get()
  if (accountState.accountSignedOut && !(module === 'user' && action === 'login')) return Promise.reject(new Error('请先登录微信账号'))
  const profileRevision = store.get().profileRevision || 0
  const scheduleRevision = store.get().scheduleRevision || 0
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'api',
      data: { module, action, payload: Object.assign({ timezoneOffsetMin: -new Date().getTimezoneOffset() }, payload || {}) },
      success: (res) => {
        if (store.get() !== accountState && !(module === 'user' && action === 'login')) return reject(new Error('账号状态已变化，请重新操作'))
        const r = res.result || {}
        if (r.code === 0) {
          if (r.data && r.data.buckets) {
            r.data.buckets.profileRevision = profileRevision
            r.data.buckets.scheduleRevision = scheduleRevision
          }
          resolve(r.data)
        }
        else {
          const err = Object.assign(new Error(r.msg || '请求失败'), { code: r.code, data: r.data })
          diag.reportApi(module, action, err)
          reject(err)
        }
      },
      fail: (err) => {
        diag.reportApi(module, action, err)
        const failure = cloudError(err)
        if (!(opt && opt.silent)) wx.showToast({ title: failure.message, icon: 'none' })
        reject(failure)
      }
    })
  })
}

module.exports = { call }

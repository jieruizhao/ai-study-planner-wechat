const https = require('https')
const crypto = require('crypto')
const prompt = require('./prompt')
function invoke(url, body, token) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body))
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Content-Length': bytes.length,
        },
      },
      (res) => {
        let output = '',
          size = 0
        res.on('data', (chunk) => {
          size += chunk.length
          if (size > 1024 * 1024) {
            res.destroy()
            reject(new Error('Agent返回内容过大'))
            return
          }
          output += chunk
        })
        res.on('error', reject)
        res.on('end', () => {
          try {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const error = new Error(res.statusCode === 402
                ? 'AI服务暂不可用：Coze返回计费或额度限制（HTTP 402），请管理员核对服务额度'
                : 'Coze HTTP ' + res.statusCode)
              // 只在后端保留错误摘要；不记录令牌、请求体或原始响应。
              let detail = {}
              try { detail = JSON.parse(output) } catch (_) {}
              const redact = (value) => String(value || '')
                .split(token).join('[redacted]')
                .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
                .replace(/\bpat_[A-Za-z0-9_-]+/g, '[redacted]')
                .slice(0, 500)
              error.upstream = {
                status: res.statusCode,
                code: redact(detail.code || detail.error_code),
                message: redact(detail.msg || detail.message || detail.detail),
                requestId: redact(detail.request_id || detail.logid ||
                  (res.headers && (res.headers['x-tt-logid'] || res.headers['x-request-id']))),
              }
              throw error
            }
            try {
              resolve(JSON.parse(output))
            } catch (_) {
              throw new Error('Coze返回不是有效JSON，请检查工作流输出')
            }
          } catch (e) {
            reject(e)
          }
        })
      },
    )
    req.setTimeout(45000, () =>
      req.destroy(new Error('Agent分析超时，请稍后重试')),
    )
    req.on('error', reject)
    req.end(bytes)
  })
}
exports.main = async (event) => {
  const secret = process.env.STUDY_AGENT_BRIDGE_SECRET,
    token = process.env.COZE_API_TOKEN,
    workflow = process.env.COZE_WORKFLOW_ID,
    apiUrl = process.env.COZE_API_URL
  if (!secret || !token || (!workflow && !apiUrl))
    return {
      code: 503,
      msg: 'AI尚未配置：请配置studyAgent的桥接密钥、Coze令牌及API地址或工作流ID',
    }
  const supplied = String((event && event.bridgeSecret) || '')
  if (
    !crypto.timingSafeEqual(
      crypto.createHash('sha256').update(supplied).digest(),
      crypto.createHash('sha256').update(secret).digest(),
    )
  )
    return { code: 403, msg: 'Agent调用未授权' }
  try {
    if (!event.input || JSON.stringify(event.input).length > 200000)
      throw new Error('分析输入为空或过大')
    const parameters = {
      system_prompt: prompt,
      input: JSON.stringify(event.input),
    }
    let url = 'https://api.coze.cn/v1/workflow/run'
    if (apiUrl) {
      let endpoint
      try {
        endpoint = new URL(apiUrl)
      } catch (_) {
        throw new Error('COZE_API_URL不是有效地址')
      }
      if (
        endpoint.protocol !== 'https:' ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.port ||
        !endpoint.hostname.endsWith('.coze.site') ||
        endpoint.pathname !== '/run'
      )
        throw new Error(
          'COZE_API_URL必须是扣子部署的https://域名.coze.site/run地址',
        )
      url = endpoint.href
    }
    const result = await invoke(
      url,
      apiUrl
        ? parameters
        : {
            workflow_id: workflow,
            parameters,
          },
      token,
    )
    if (!apiUrl && Number(result.code) !== 0)
      throw new Error('Coze调用失败，代码 ' + result.code)
    let data = apiUrl ? result : result.data
    const parse = (value) => {
      if (typeof value !== 'string') return value
      try {
        return JSON.parse(value)
      } catch (_) {
        throw new Error('Coze输出格式错误：output必须是JSON对象或JSON字符串')
      }
    }
    data = parse(data)
    if (data && data.output != null) data = parse(data.output)
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      typeof data.strengths !== 'string' ||
      typeof data.difficulties !== 'string' ||
      typeof data.suggestions !== 'string' ||
      !Array.isArray(data.tasks) ||
      !Array.isArray(data.habits)
    )
      throw new Error('Coze输出字段不匹配，请检查学习导师工作流的结束节点')
    return { code: 0, data }
  } catch (e) {
    if (e.upstream) console.error('[studyAgent:upstream]', JSON.stringify(e.upstream))
    console.error('[studyAgent]', e.message)
    return { code: 503, msg: e.message || 'Agent调用失败' }
  }
}

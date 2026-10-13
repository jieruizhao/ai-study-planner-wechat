const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const response = {
  strengths: '规律学习',
  difficulties: '定位困难',
  suggestions: '留出缓冲',
  tasks: [],
  habits: [],
}
function setup(env = {}, payload = { output: response }, status = 200) {
  const calls = [], errors = []
  const https = {
    request(url, options, callback) {
      const req = new EventEmitter()
      req.setTimeout = () => {}
      req.end = (bytes) => {
        calls.push({ url, options, body: JSON.parse(bytes) })
        const res = new EventEmitter()
        res.statusCode = status
        res.destroy = () => {}
        callback(res)
        res.emit(
          'data',
          Buffer.from(
            typeof payload === 'string' ? payload : JSON.stringify(payload),
          ),
        )
        res.emit('end')
      }
      return req
    },
  }
  const exports = {}
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, '../cloudfunctions/studyAgent/index.js'),
      'utf8',
    ),
    {
      exports,
      Buffer,
      URL,
      console: { error(...args) { errors.push(args.join(' ')) } },
      process: {
        env: {
          STUDY_AGENT_BRIDGE_SECRET: 'test-secret',
          COZE_API_TOKEN: 'test-token',
          COZE_API_URL: 'https://example.coze.site/run',
          ...env,
        },
      },
      require: (name) =>
        name === 'https'
          ? https
          : name === './prompt'
            ? '学习导师'
            : require(name),
    },
  )
  return { calls, errors, main: exports.main }
}
const event = {
  bridgeSecret: 'test-secret',
  input: { settings: { goal: '英语' }, logs: [] },
}
test('扣子编程API直接传入两个字符串参数并解析output', async () => {
  const r = setup()
  const result = await r.main(event)
  assert.equal(result.code, 0)
  assert.equal(result.data.strengths, response.strengths)
  assert.equal(r.calls[0].body.system_prompt, '学习导师')
  assert.deepEqual(JSON.parse(r.calls[0].body.input), event.input)
  assert.equal(r.calls[0].body.workflow_id, undefined)
  assert.equal(r.calls[0].options.headers.Authorization, 'Bearer test-token')
})
test('保留低代码工作流调用及JSON字符串输出兼容', async () => {
  const r = setup(
    { COZE_API_URL: '', COZE_WORKFLOW_ID: '12345' },
    { code: 0, data: JSON.stringify({ output: JSON.stringify(response) }) },
  )
  assert.equal((await r.main(event)).code, 0)
  assert.equal(r.calls[0].url, 'https://api.coze.cn/v1/workflow/run')
  assert.equal(r.calls[0].body.workflow_id, '12345')
  assert.equal(typeof r.calls[0].body.parameters.input, 'string')
})
test('无效地址或未授权调用不会向外发送数据', async () => {
  for (const url of [
    'http://example.coze.site/run',
    'https://code.coze.cn/p/123',
    'https://example.coze.site/run?token=secret',
    'https://example.coze.site.evil.test/run',
  ]) {
    const r = setup({ COZE_API_URL: url })
    assert.equal((await r.main(event)).code, 503)
    assert.equal(r.calls.length, 0)
  }
  const r = setup()
  assert.equal((await r.main({ ...event, bridgeSecret: 'wrong' })).code, 403)
  assert.equal(r.calls.length, 0)
})
test('鉴权失败、非JSON和不匹配字段不会伪报成功', async () => {
  for (const [payload, status] of [
    [{ detail: 'bad-token' }, 401],
    ['<html>error</html>', 200],
    [{ output: { message: 'hello' } }, 200],
  ]) {
    const result = await setup({}, payload, status).main(event)
    assert.equal(result.code, 503)
    assert.equal(result.data, undefined)
  }
})
test('402保留后端脱敏错误摘要，前端显示可操作提示且不泄露凭据', async () => {
  const r = setup({}, { code: 'InsufficientQuota', msg: 'quota unavailable test-token Bearer example pat_secret', request_id: 'req-test' }, 402)
  const result = await r.main(event)
  assert.equal(result.code, 503)
  assert.match(result.msg, /计费或额度限制/)
  assert.ok(!result.msg.includes('InsufficientQuota'))
  const logs = r.errors.join('\n')
  assert.match(logs, /InsufficientQuota/)
  assert.match(logs, /req-test/)
  assert.ok(!logs.includes('test-token'))
  assert.ok(!logs.includes('pat_secret'))
  assert.ok(!logs.includes('Bearer example'))
})

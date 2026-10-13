const { test } = require('node:test')
const assert = require('node:assert/strict')
const { runtime, database, context } = require('./helpers.cjs')

function setup(time, reminderTime, options = {}) {
  return runtime({ now: Date.parse('2026-10-07T' + time + ':00+08:00'), ...options, db: database({
    configs: [{ _id: 'cfg', key: 'subscribe', templateId: 'template' }],
    reminders: [{ _id: 'r', reminderId: 'h', userId: 'user_a', enabled: true, wechatEnabled: true, time: reminderTime, weekdays: [3] }]
  }) })
}
test('调度不提前发送未来分钟的提醒，不留下失败预约', async () => {
  const r = setup('18:25', '18:27')
  assert.equal((await r.load('cloudfunctions/scheduler/index.js').main()).scanned, 0)
  assert.equal((r.db.tables.dispatches || []).length, 0)
})
test('整点调度补发上一个小时内延迟的提醒且只发送一次', async () => {
  const r = setup('19:00', '18:59'), s = r.load('cloudfunctions/scheduler/index.js')
  assert.equal((await s.main()).sent, 1)
  assert.equal((await s.main()).sent, 0)
})
test('午夜不把昨天的提醒当作今天发送', async () => {
  const r = setup('00:01', '23:59')
  assert.equal((await r.load('cloudfunctions/scheduler/index.js').main()).scanned, 0)
})
test('没有订阅额度时保留错误码供云端排查', async () => {
  const r = setup('18:27', '18:27', { sendError: { errCode: '43101', errMsg: 'user refuse' } })
  assert.equal((await r.load('cloudfunctions/scheduler/index.js').main()).noAuth, 1)
  assert.match(r.db.tables.dispatches[0].error, /43101/)
})
test('微信返回非零错误码不能记录为已发送', async () => {
  for (const sendResult of [{errCode:47003,errMsg:'invalid data'},{errcode:43101,errmsg:'no quota'}]) {
    const r=setup('18:27','18:27',{sendResult})
    const result=await r.load('cloudfunctions/scheduler/index.js').main()
    assert.equal(result.sent,0)
    assert.equal(result.failed+result.noAuth,1)
    assert.match(r.db.tables.dispatches[0].error,/47003|43101/)
  }
})
test('订阅时记录开发、体验、正式版本，云端保存并发送对应版本，编辑不重置版本',async()=>{
  for(const [envVersion,state] of [['develop','developer'],['trial','trial'],['release','formal']]) {
    const r=setup('18:27','18:27');r.getApp();r.options.offline=true
    r.store().upsertHabit({_id:'h',name:'复习',enabled:true,reminderTime:'18:27',weekdays:[3]})
    r.wx.getAccountInfoSync=()=>({miniProgram:{envVersion}})
    r.wx.requestSubscribeMessage=o=>o.complete({template:'accept'})
    const p=r.page('habits');p._templateId='template';p.requestWechat({currentTarget:{dataset:{id:'h'}}})
    await new Promise(resolve=>setImmediate(resolve))
    const queued=r.store().get().queue[0].payload
    assert.equal(queued.miniprogramState,state)
    const service=r.load('cloudfunctions/api/modules/habit.js')
    await service.save(context(r.db,queued,'user_a','2026-10-07'))
    delete queued.miniprogramState
    await service.save(context(r.db,queued,'user_a','2026-10-07'))
    assert.equal(r.db.tables.reminders[0].miniprogramState,state)
    assert.equal((await r.load('cloudfunctions/scheduler/index.js').main()).sent,1)
    assert.equal(r.calls.find(x=>x.name==='subscribe').miniprogramState,state)
  }
})

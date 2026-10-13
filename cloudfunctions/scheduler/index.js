/**
 * 提醒调度任务（定时触发器，每分钟）
 * 流程：扫描到期提醒 → 幂等检查当日发送记录 → 尝试微信订阅消息 → 记录发送状态/失败原因
 * 约束：受用户订阅授权与平台规则限制，不承诺必达；未授权记为 no-auth，应用内待办不受影响
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const TZ_MIN = 8 * 60 // Asia/Shanghai

function pad(n) { return n < 10 ? '0' + n : '' + n }

/** 北京时间 now */
function bjNow() { return new Date(Date.now() + TZ_MIN * 60000) }

function bjDateStr(d) {
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
}

/** 当前及过去 4 分钟；补偿短暂延迟，绝不提前消耗订阅授权。 */
function slotHMList(d) {
  const list = []
  for (let offset = 0; offset < 5; offset++) {
    const due = new Date(d.getTime() - offset * 60000)
    if (bjDateStr(due) !== bjDateStr(d)) break
    list.push(pad(due.getUTCHours()) + ':' + pad(due.getUTCMinutes()))
  }
  return list
}

exports.main = async () => {
  const db = cloud.database()
  const _ = db.command
  const now = bjNow()
  const today = bjDateStr(now)
  const hms = slotHMList(now)
  const weekday = now.getUTCDay() === 0 ? 7 : now.getUTCDay()
  const stats = { scanned: 0, sent: 0, noAuth: 0, failed: 0, skipped: 0 }

  try {
    // 提醒模板：configs 集合 { key:'subscribe', templateId:'xxx', dataMap?: {...} }
    const cfg = await db.collection('configs').where({ key: 'subscribe' }).limit(1).get().catch(() => ({ data: [] }))
    const templateId = cfg.data.length ? cfg.data[0].templateId : ''
    console.log('[scheduler] start', JSON.stringify({ date: today, dueTimes: hms, templateId: templateId || '未配置' }))
    if (!templateId) {
      console.warn('[scheduler] 未配置订阅消息模板（configs.subscribe.templateId），本次跳过发送')
    }

    const reminders = []
    for (let offset = 0; ; offset += 100) {
      const page = await db.collection('reminders').where({ enabled: true, time: _.in(hms) })
        .orderBy('_id', 'asc').skip(offset).limit(100).get()
      reminders.push(...page.data)
      if (page.data.length < 100) break
    }
    stats.scanned = reminders.length

    for (const r of reminders) {
      const weekdays = r.weekdays && r.weekdays.length ? r.weekdays : [1, 2, 3, 4, 5, 6, 7]
      const dispatchId = today + '_' + r.reminderId
      try {
        if (weekdays.indexOf(weekday) < 0) { stats.skipped++; continue }
        if (r.date && r.date !== today) { stats.skipped++; continue }
        if (!templateId || r.wechatEnabled === false) { stats.skipped++; continue } // 用户关闭微信渠道

        // 幂等：当日已尝试过则不再发
        const existed = await db.collection('dispatches').doc(dispatchId).get().catch(() => null)
        if (existed && existed.data) { stats.skipped++; continue }
        // 先以唯一 ID 预约，防止两个定时实例同时发送同一条提醒。
        try {
          await db.collection('dispatches').add({ data: {
            _id: dispatchId, userId: r.userId, reminderId: r.reminderId, type: r.type,
            date: today, time: r.time, status: 'sending', sentAt: db.serverDate()
          } })
        } catch (e) { stats.skipped++; continue }

        let status = 'skipped', error = ''
        if (!templateId) {
          status = 'skipped'
          error = 'no template'
        } else {
          try {
            const sessions = []
            for (let offset = 0; ; offset += 100) {
              const part = await db.collection('sessions').where({ userId: r.userId, date: today }).skip(offset).limit(100).get()
              sessions.push(...part.data.filter(s => !s.deleted))
              if (part.data.length < 100) break
            }
            const completed = sessions.filter(s => s.status === 'done').length
            const response = await cloud.openapi.subscribeMessage.send({
              touser: r.userId,
              templateId,
              page: 'pages/today/index',
              miniprogramState: ['developer','trial','formal'].includes(r.miniprogramState) ? r.miniprogramState : 'formal',
              // 打卡提醒模板：活动、时间、当日任务完成进度。
              data: {
                thing1: { value: (r.title || '学习打卡').slice(0, 20) },
                time5: { value: today + ' ' + r.time },
                character_string2: { value: completed + '/' + sessions.length }
              }
            })
            const code = response && (response.errCode == null ? response.errcode : response.errCode)
            if (code != null && Number(code) !== 0) {
              throw { errCode: code, errMsg: response.errMsg || response.errmsg || '微信拒绝发送' }
            }
            status = 'sent'
            stats.sent++
          } catch (e) {
            const code = e.errCode == null ? e.errcode : e.errCode
            error = (code || '') + ' ' + (e.errMsg || e.errmsg || e.message || '发送失败')
            if (Number(code) === 43101) { status = 'no-auth'; stats.noAuth++ } // 用户未订阅/已拒收
            else { status = 'failed'; stats.failed++ }
            console.error('[scheduler] subscribe send failed', JSON.stringify({ reminderId: r.reminderId, date: today, status, error }))
          }
        }

        await db.collection('dispatches').doc(dispatchId).update({
          data: { status, error, sentAt: db.serverDate() }
        })
      } catch (e) {
        console.error('[scheduler] reminder failed', r.reminderId, e)
      }
    }
  } catch (e) {
    console.error('[scheduler] run failed', e)
    return { ok: false, error: e.message }
  }
  console.log('[scheduler] done', JSON.stringify(stats))
  return { ok: true, ...stats }
}

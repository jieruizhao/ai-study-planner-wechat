// 本地数据库（离线优先）：所有页面读写这里，persist 后落 storage
// 结构与云端集合保持一致，便于同步
const KEY = 'study_app_db_v1'

const defaultDb = {
  profileRevision: 0,
  scheduleRevision: 0,
  profile: { openidMask: '本地模式', examDate: null, timezone: 'Asia/Shanghai' },
  planDraft: null,
  plan: null,                          // 当前计划 { _id, version, startDate, studyWeekdays, extraRestDates, dailyMaxSessions, template, title }
  sessions: {},                        // { [date]: [ {_id, date, order, subject, content, suggestedMinutes, status, version} ] }
  logs: {},                            // { [date]: [ {_id, date, type, subject, durationMinutes, content, note, nextTip, version} ] }
  habits: [],                          // [ {_id, name, icon, reminderTime, weekdays, wxReminder, enabled} ]
  habitLogs: {},                       // { [date]: { [habitId]: 'done'|'skipped' } }
  snooze: {},                          // { [date]: [habitId] } 「稍后」状态
  queue: [],                           // 待同步操作
  conflicts: [],                       // 冲突自动保留记录提示
  lastSync: 0,
  serverIdMap: {}                      // clientTempId -> 服务端 _id
}

let db = null

function load() {
  if (db) return db
  try {
    db = Object.assign({}, JSON.parse(JSON.stringify(defaultDb)), wx.getStorageSync(KEY) || {})
  } catch (e) {
    db = JSON.parse(JSON.stringify(defaultDb))
  }
  if (db.plan && db.plan.version === 0) { db.planDraft = db.planDraft || db.plan; db.plan = null }
  return db
}

function persist() {
  try { wx.setStorageSync(KEY, db) } catch (e) { console.warn('persist fail', e) }
}

function get() { return load() }
function signOut() {
  const current = load()
  const owner = current.profile.accountId || current.profile.openidMask
  if (!owner || owner === '本地模式') throw new Error('请先确认账号身份后再退出')
  // 先备份成功再清空展示，离线未同步记录和队列也保留。
  wx.setStorageSync(KEY + '_account_' + owner, JSON.parse(JSON.stringify(current)))
  db = JSON.parse(JSON.stringify(defaultDb))
  db.accountSignedOut = true
  persist()
}
function signIn(profile) {
  const current = load(), id = profile.accountId
  if (!id) throw new Error('请重新部署api以启用账号数据恢复')
  let archived = wx.getStorageSync(KEY + '_account_' + id)
  if (!archived && profile.openidMask) archived = wx.getStorageSync(KEY + '_account_' + profile.openidMask)
  if (current.accountSignedOut || (current.profile.accountId && current.profile.accountId !== id)) {
    if (!current.accountSignedOut && current.profile.accountId) wx.setStorageSync(KEY + '_account_' + current.profile.accountId, JSON.parse(JSON.stringify(current)))
    db = Object.assign({}, JSON.parse(JSON.stringify(defaultDb)), archived || {})
  }
  db.accountSignedOut = false
  db.profile = Object.assign({}, db.profile, profile, { accountAuthorized: true })
  persist()
}

function reset() {
  db = JSON.parse(JSON.stringify(defaultDb))
  persist()
}

/** 恢复初始状态：清空计划/任务/学习记录/习惯打卡，保留账号资料与习惯定义 */
function resetPlanData() {
  const d = load()
  d.scheduleRevision = (d.scheduleRevision || 0) + 1
  d.plan = null
  d.planDraft = null
  d.sessions = {}
  d.logs = {}
  d.habitLogs = {}
  d.snooze = {}
  d.queue = []      // 本地数据已清空，历史队列操作不再重放
  d.conflicts = []
  persist()
}

// ---- 常用读写 ----
function sessionsOf(date) { return load().sessions[date] || [] }
function logsOf(date) { return load().logs[date] || [] }
function habitLogOf(date) { return load().habitLogs[date] || {} }

function setSessions(date, list) { load().sessions[date] = list; persist() }
function setLogs(date, list) { load().logs[date] = list; persist() }

function setSessionStatus(date, sessionId, status) {
  const s = (load().sessions[date] || []).find(x => x._id === sessionId)
  if (s) { s.status = status; persist() }
}

function setHabitLog(date, habitId, status) {
  const d = load()
  if (!d.habitLogs[date]) d.habitLogs[date] = {}
  d.habitLogs[date][habitId] = status
  persist()
}

function upsertLog(log) {
  const d = load()
  const list = d.logs[log.date] = d.logs[log.date] || []
  const i = list.findIndex(x => x._id === log._id)
  if (i >= 0) list[i] = Object.assign(list[i], log)
  else list.push(log)
  persist()
}

function removeLog(date, logId) {
  const d = load()
  d.logs[date] = (d.logs[date] || []).filter(x => x._id !== logId)
  persist()
}

function upsertHabit(habit) {
  const d = load()
  const i = d.habits.findIndex(x => x._id === habit._id)
  if (i >= 0) d.habits[i] = Object.assign(d.habits[i], habit)
  else d.habits.push(habit)
  persist()
}

function removeHabit(habitId) {
  const d = load()
  d.habits = d.habits.filter(x => x._id !== habitId)
  persist()
}

function setPlan(plan) { load().plan = plan; persist() }

// 刷新云端快照后重放尚未确认的本地操作，避免弱网时待办/考试日期闪回。
function applyServerBuckets(buckets) {
  if (load().accountSignedOut) return
  if (!buckets) return
  const d = load()
  if (buckets.scheduleRevision != null && buckets.scheduleRevision !== (d.scheduleRevision || 0)) return
  if (buckets.plan && d.plan && buckets.plan._id === d.plan._id && buckets.plan.version < d.plan.version) return
  const localLogs = d.logs, localHabits = d.habits
  const pendingLogs = {}
  Object.keys(localLogs).forEach(date => localLogs[date].forEach(log => { pendingLogs[log._id] = Object.assign({}, log) }))
  if (buckets.sessions) Object.keys(buckets.sessions).forEach(k => { d.sessions[k] = buckets.sessions[k].map(x => Object.assign({}, x)) })
  if (buckets.logs) Object.keys(buckets.logs).forEach(k => { d.logs[k] = buckets.logs[k].map(x => Object.assign({}, x)) })
  if (buckets.habitLogs) Object.keys(buckets.habitLogs).forEach(k => { d.habitLogs[k] = Object.assign({}, buckets.habitLogs[k]) })
  if (Object.prototype.hasOwnProperty.call(buckets, 'plan')) d.plan = buckets.plan
  if (buckets.habits) d.habits = buckets.habits.map(x => Object.assign({}, x))
  if (buckets.profile && (buckets.profileRevision == null || buckets.profileRevision === (d.profileRevision || 0))) d.profile = Object.assign({}, d.profile, buckets.profile)
  for (const op of d.queue) {
    const p = op.payload || {}
    if (op.type === 'profile.update') Object.assign(d.profile, p)
    if (op.type === 'session.status') {
      const record = (d.sessions[p.date] || []).find(x => x._id === p.sessionId)
      if (record) record.status = p.status
    }
    if (op.type === 'habit.log') {
      if (!d.habitLogs[p.date]) d.habitLogs[p.date] = {}
      d.habitLogs[p.date][p.habitId] = p.status
    }
    if (op.type === 'habit.save') {
      const habit = localHabits.find(x => x._id === p._id) || p
      const at = d.habits.findIndex(x => x._id === p._id)
      if (at < 0) d.habits.push(habit); else d.habits[at] = habit
    }
    if (op.type === 'habit.delete') d.habits = d.habits.filter(x => x._id !== p.habitId)
    if (op.type === 'log.add') {
      const log = pendingLogs[p.clientTempId] || Object.assign({}, p, { _id: p.clientTempId, version: 1, pendingNew: true })
      const list = d.logs[p.date] = d.logs[p.date] || []
      const at = list.findIndex(x => x._id === log._id)
      if (at < 0) list.push(log); else list[at] = log
    }
    if (op.type === 'log.update' || op.type === 'log.delete') {
      Object.keys(d.logs).forEach(date => {
        if (op.type === 'log.delete') d.logs[date] = d.logs[date].filter(x => x._id !== p.logId)
        else {
          const log = d.logs[date].find(x => x._id === p.logId)
          if (log) Object.assign(log, p.patch || {})
        }
      })
    }
  }
  persist()
}

module.exports = {
  load, persist, get, reset, resetPlanData, signOut, signIn,
  sessionsOf, logsOf, habitLogOf,
  setSessions, setLogs, setSessionStatus, setHabitLog,
  upsertLog, removeLog, upsertHabit, removeHabit, setPlan,
  applyServerBuckets
}

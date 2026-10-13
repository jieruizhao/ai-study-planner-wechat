// 本地先行；同一资源按顺序提交，失败保留待同步操作。
const store = require('./store')
const api = require('./api')
let inFlight = null
function genId() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }
function resourceKey(op) {
  const p = op.payload || {}
  if (op.type === 'profile.update') return 'profile'
  if (op.type.indexOf('log.') === 0) return 'log:' + (p.logId || p.clientTempId)
  if (op.type === 'session.status') return 'session:' + p.sessionId
  if (op.type === 'habit.log') return 'habitLog:' + p.habitId + ':' + p.date
  return 'habit:' + (p._id || p.habitId)
}
function enqueue(type, payload, baseVersion) {
  const db = store.get()
  const op = { operationId: genId(), type, payload: JSON.parse(JSON.stringify(payload)), baseVersion: baseVersion == null ? null : baseVersion, ts: Date.now() }
  if (type === 'profile.update') db.profileRevision = (db.profileRevision || 0) + 1
  db.queue.push(op)
  store.persist()
  flush().catch(() => {})
  return op
}
function pendingCount() { return store.get().queue.length }
function flush() {
  if (inFlight) return inFlight
  inFlight = run().finally(() => { inFlight = null })
  return inFlight
}
async function run() {
  const db = store.get(), attempted = new Set(), blocked = new Set()
  let sent = 0, conflicts = 0
  const errors = []
  while (db.queue.length) {
    const keys = new Set()
    const ops = db.queue.filter(op => {
      const key = resourceKey(op)
      if (attempted.has(op.operationId) || blocked.has(key) || keys.has(key) || keys.size >= 50) return false
      keys.add(key); return true
    }).map(op => {
      const copy = JSON.parse(JSON.stringify(op))
      if (copy.payload.logId && db.serverIdMap[copy.payload.logId]) copy.payload.logId = db.serverIdMap[copy.payload.logId]
      return copy
    })
    if (!ops.length) break
    const res = await api.call('sync', 'batch', { operations: ops }, { silent: true })
    if (!res || !Array.isArray(res.results)) throw new Error('同步返回格式错误')
    // 清空/重置发生在请求期间时，旧响应不能恢复被清理的数据。
    if (store.get() !== db) return { sent, remain: pendingCount(), conflicts, errors }
    for (const op of ops) {
      attempted.add(op.operationId)
      if (!db.queue.some(x => x.operationId === op.operationId)) continue
      const r = res.results.find(x => x.operationId === op.operationId)
      const isConflict = r && r.code === 409 && r.data && r.data.serverDoc
      if (!r || (r.code !== 0 && !isConflict)) {
        blocked.add(resourceKey(op))
        const error = { operationId: op.operationId, code: r ? r.code : -1, msg: r ? r.msg : '缺少同步结果' }
        errors.push(error)
        const queued = db.queue.find(x => x.operationId === op.operationId)
        if (queued) queued.lastError = error.msg
        continue
      }
      db.queue = db.queue.filter(x => x.operationId !== op.operationId)
      sent++
      if (isConflict) { conflicts++; handleConflict(r, db); continue }
      const data = r.data || {}
      if (data.serverIdMap) {
        Object.assign(db.serverIdMap, data.serverIdMap)
        Object.keys(data.serverIdMap).forEach(id => Object.values(db.logs).forEach(list => {
          const log = list.find(x => x._id === id)
          if (log) { log._id = data.serverIdMap[id]; log.pendingNew = false }
        }))
      }
      const doc = data.doc || data.habit
      if (doc && doc.version != null) db.queue.forEach(next => {
        if (resourceKey(next) === resourceKey(op)) { next.baseVersion = doc.version; if (next.payload.baseVersion != null) next.payload.baseVersion = doc.version }
      })
      if (doc && op.type.indexOf('log.') === 0) {
        const list = (db.logs[doc.date] || []).filter(x => x._id !== doc._id)
        list.push(Object.assign({}, doc, { pendingNew: false }))
        store.applyServerBuckets({ logs: { [doc.date]: list } })
      } else if (doc && op.type === 'session.status') {
        const list = (db.sessions[doc.date] || []).map(x => x._id === doc._id ? doc : x)
        store.applyServerBuckets({ sessions: { [doc.date]: list } })
      } else if (data.habit) {
        const habits = db.habits.filter(x => x._id !== data.habit._id).concat(data.habit)
        store.applyServerBuckets({ habits })
      } else if (op.type === 'profile.update') store.applyServerBuckets({ profile: data })
    }
    if (sent) db.lastSync = Date.now()
    store.persist()
  }
  if (conflicts) {
    db.conflicts = (db.conflicts || []).concat({ ts: Date.now(), count: conflicts }).slice(-20)
    store.persist()
  }
  return { sent, remain: db.queue.length, conflicts, errors }
}
function handleConflict(r, db) {
  const info = r.data || {}, doc = info.serverDoc
  if (info.kind === 'log.update' && doc) {
    store.applyServerBuckets({ logs: { [doc.date]: (db.logs[doc.date] || []).filter(x => x._id !== doc._id).concat(doc) } })
    if (info.clientDoc) {
      const copy = Object.assign({}, doc, info.clientDoc, { _id: genId(), version: 1, pendingNew: true,
        note: info.clientDoc.note || '',
        content: '【未同步的本地修改】' + (info.clientDoc.content || '') })
      store.upsertLog(copy)
      db.queue.push({ operationId: genId(), type: 'log.add', payload: {
        clientTempId: copy._id, date: copy.date, type: copy.type, durationMinutes: copy.durationMinutes,
        content: copy.content, note: copy.note, nextTip: copy.nextTip, sessionId: copy.sessionId || ''
      }, ts: Date.now() })
    }
  } else if (doc && doc.date && doc.status !== undefined) {
    store.applyServerBuckets({ sessions: { [doc.date]: (db.sessions[doc.date] || []).map(x => x._id === doc._id ? doc : x) } })
  }
}
module.exports = { enqueue, flush, pendingCount, genId }

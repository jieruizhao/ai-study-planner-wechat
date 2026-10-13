/**
 * Excel 学习计划解析（纯函数，不依赖 wx-server-sdk，便于单元测试）
 *
 * 支持的模板（《学习计划导入模板.xlsx》，同时兼容常见打卡表如"雅思备考优化任务计划"）：
 *  - 在前 10 行内自动识别表头行，列名模糊匹配：
 *      日期      → 必填（支持 Date / Excel 序列数 / 2026-9-26 / 2026/9/26 / 9月26日）
 *      星期      → 选填（仅校验，与日期冲突时以日期为准）
 *      阶段/科目 → 选填（默认"学习"）
 *      任务内容  → 必填（匹配"任务/内容/验收/安排"）
 *      计划时长  → 选填（列名含"小时"按小时×60，含"分钟"按分钟，缺省 30 分钟）
 *      备注      → 选填（仅匹配"备注"）
 *  - 明确排除"实际时长/完成状态/错因"等打卡过程列
 */
const { isValidDate } = require('./helper')
const MIN_MINUTES = 5
const MAX_MINUTES = 720
const MAX_ROWS = 800

function normKey(s) {
  return String(s == null ? '' : s)
    .replace(/[（(]/g, '(').replace(/[）)]/g, ')')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** 在前 10 行内识别表头行与列下标 */
function detectHeader(rows) {
  const limit = Math.min(rows.length, 10)
  for (let i = 0; i < limit; i++) {
    const cells = (rows[i] || []).map(normKey)
    const hasDate = cells.some(c => /^(日期|date|学习日期|打卡日期)$/.test(c))
    const dateIdx = cells.findIndex(c => /^(日期|date|学习日期|打卡日期)$/.test(c))
    if (!hasDate || dateIdx < 0) continue
    const cols = { date: dateIdx, weekday: -1, subject: -1, content: -1, minutes: -1, minutesUnit: 'minute', note: -1 }
    cells.forEach((c, j) => {
      if (j === dateIdx) return
      if (cols.weekday < 0 && /^(星期|周|weekday)$/.test(c)) cols.weekday = j
      else if (cols.subject < 0 && /(阶段|科目|类别)/.test(c)) cols.subject = j
      else if (cols.content < 0 && /(任务|内容|验收|安排)/.test(c)) cols.content = j
      else if (cols.minutes < 0 && /(计划时长|时长|计划时间)/.test(c) && !/实际/.test(c)) {
        cols.minutes = j
        cols.minutesUnit = /小时/.test(c) ? 'hour' : 'minute'
      }
      else if (cols.note < 0 && /(备注|说明)/.test(c) && !/填表|模板/.test(c)) cols.note = j
    })
    if (cols.content >= 0) return { headerRowIndex: i, cols }
  }
  return null
}

/** 日期单元格 → YYYY-MM-DD；无法识别返回 null */
function parseDateCell(v, baseYear) {
  if (v == null || v === '') return null
  if (v instanceof Date && !isNaN(v)) {
    // xlsx 库 cellDates 有浮点误差（00:00 会表示成 23:59:1x），
    // 距午夜 2 分钟内时进位一天；主路径建议传序列数（cellDates:false）
    const d2 = new Date(v.getTime())
    if (d2.getHours() === 23 && d2.getMinutes() >= 58) d2.setDate(d2.getDate() + 1)
    return d2.getFullYear() + '-' + pad2(d2.getMonth() + 1) + '-' + pad2(d2.getDate())
  }
  // Excel 序列数（1900 日期系统，epoch 1899-12-30）
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const ms = Math.round((v - 25569) * 86400000)
    const d = new Date(ms)
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
  }
  const s = String(v).trim()
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/)
  if (m) return mk(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})[-/.月](\d{1,2})日?$/)
  if (m) {
    const y = baseYear || new Date().getFullYear()
    return mk(y, +m[1], +m[2])
  }
  const t = Date.parse(s)
  if (!isNaN(t)) {
    const d = new Date(t)
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
  }
  return null
}

function mk(y, mo, dd) {
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null
  const d = new Date(y, mo - 1, dd)
  if (d.getMonth() !== mo - 1 || d.getDate() !== dd) return null
  return y + '-' + pad2(mo) + '-' + pad2(dd)
}

function pad2(n) { return n < 10 ? '0' + n : '' + n }

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const w = new Date(y, m - 1, d).getDay()
  return w === 0 ? 7 : w
}

/** 时长单元格 → 分钟 */
function parseMinutes(v, unit) {
  if (v == null || v === '') return 30
  if (typeof v === 'string') {
    const m = v.match(/(\d+(?:\.\d+)?)/)
    if (!m) return 30
    v = parseFloat(m[1])
  }
  let min = Number(v)
  if (!isFinite(min) || min <= 0) return 30
  if (unit === 'hour') min = Math.round(min * 60)
  return Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, Math.round(min)))
}

const WEEK_CN = ['一', '二', '三', '四', '五', '六', '日']
function weekdayFromText(s) {
  const t = String(s || '')
  const m = t.match(/[一二三四五六日末]/)
  if (!m) return null
  if (m[0] === '末') return null
  return WEEK_CN.indexOf(m[0]) + 1
}

/**
 * 主入口：sheet_to_json(header:1) 的二维数组 → 解析结果
 * 返回 { ok, error?, result? }
 * result: { rows:[{date,weekday,subject,content,minutes,note}], stats:{days,tasks,totalMinutes,firstDate,lastDate,weekdays[]} }
 */
function parsePlanRows(rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : []
  if (!rows.length) return { ok: false, error: '表格为空' }
  const head = detectHeader(rows)
  if (!head) return { ok: false, error: '未找到表头：需要包含「日期」和「任务内容」两列，可参考《学习计划导入模板.xlsx》' }
  const { cols } = head
  const baseYear = new Date().getFullYear()
  const out = []
  const byDate = {}
  let skipped = 0

  for (let i = head.headerRowIndex + 1; i < rows.length; i++) {
    const r = rows[i] || []
    const date = parseDateCell(r[cols.date], baseYear)
    if (!date) { if (r.some(c => c != null && c !== '')) skipped++; continue }
    const content = String(r[cols.content] == null ? '' : r[cols.content]).trim()
    if (!content) { skipped++; continue }
    const subjectRaw = cols.subject >= 0 ? String(r[cols.subject] == null ? '' : r[cols.subject]).trim() : ''
    const weekdayCell = cols.weekday >= 0 ? weekdayFromText(r[cols.weekday]) : null
    const note = cols.note >= 0 ? String(r[cols.note] == null ? '' : r[cols.note]).trim() : ''
    const item = {
      date,
      weekday: weekdayOf(date),
      subject: (subjectRaw || '学习').slice(0, 20),
      content: content.slice(0, 200),
      minutes: parseMinutes(cols.minutes >= 0 ? r[cols.minutes] : null, cols.minutesUnit),
      note: note.slice(0, 100)
    }
    if (out.length >= MAX_ROWS) return { ok: false, error: '任务超过 ' + MAX_ROWS + ' 条，请拆分后导入' }
    out.push(item)
    ;(byDate[date] = byDate[date] || []).push(item)
  }

  if (!out.length) return { ok: false, error: '没有解析到有效任务行：每行需要「日期」和「任务内容」' }

  const dates = Object.keys(byDate).sort()
  const weekdays = []
  dates.forEach(dt => {
    const w = weekdayOf(dt)
    if (weekdays.indexOf(w) < 0) weekdays.push(w)
  })
  weekdays.sort((a, b) => a - b)
  const totalMinutes = out.reduce((t, x) => t + x.minutes, 0)

  return {
    ok: true,
    result: {
      rows: out,
      stats: {
        days: dates.length,
        tasks: out.length,
        totalMinutes,
        firstDate: dates[0],
        lastDate: dates[dates.length - 1],
        weekdays,
        weekdaysText: weekdays.map(w => WEEK_CN[w - 1]).join('、'),
        skipped
      }
    }
  }
}

/** 服务端校验（importApply 时不信任客户端） */
function sanitizeRows(rows) {
  if (!Array.isArray(rows)) return null
  if (!rows.length || rows.length > MAX_ROWS) return null
  const out = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') return null
    const date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null
    if (!isValidDate(date)) return null
    const content = String(r.content || '').trim().slice(0, 200)
    if (!content) return null
    let minutes = parseInt(r.minutes, 10)
    if (!isFinite(minutes)) minutes = 30
    minutes = Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, minutes))
    out.push({
      date,
      subject: String(r.subject || '学习').trim().slice(0, 20) || '学习',
      content,
      minutes
    })
  }
  return out
}

module.exports = { parsePlanRows, sanitizeRows, parseDateCell, detectHeader, parseMinutes, MAX_ROWS }

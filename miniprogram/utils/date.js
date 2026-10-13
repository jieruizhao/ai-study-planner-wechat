// 日期工具：业务日期一律用用户本地日期字符串 YYYY-MM-DD
function pad(n) { return n < 10 ? '0' + n : '' + n }

function dateStr(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function parse(s) {
  const [y, m, d] = (s || '').split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

function todayStr() {
  return dateStr(new Date())
}

function addDays(s, n) {
  const d = parse(s)
  d.setDate(d.getDate() + n)
  return dateStr(d)
}

// 1=周一 ... 7=周日
function weekdayOf(s) {
  const w = parse(s).getDay()
  return w === 0 ? 7 : w
}

function diffDays(a, b) {
  return Math.round((parse(a) - parse(b)) / 86400000)
}

// 本周周一
function startOfWeek(s) {
  return addDays(s, 1 - weekdayOf(s))
}

function monthOf(s) { return s.slice(0, 7) } // YYYY-MM

function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m, 0).getDate()
}

// 生成月历 6x7=42 格（周一起始），格子里是 'YYYY-MM-DD' 或 ''
function monthMatrix(ym) {
  const first = ym + '-01'
  const lead = weekdayOf(first) - 1
  const total = daysInMonth(ym)
  const cells = []
  const prevYm = addDays(first, -1).slice(0, 7)
  const prevTotal = daysInMonth(prevYm)
  for (let i = 0; i < 42; i++) {
    const dayNo = i - lead + 1
    if (dayNo < 1) cells.push({ date: prevYm + '-' + pad(prevTotal + dayNo), dim: true })
    else if (dayNo > total) cells.push({ date: addDays(first, dayNo - 1), dim: true })
    else cells.push({ date: ym + '-' + pad(dayNo), dim: false })
  }
  return cells
}

function fmtCN(s) {
  const d = parse(s)
  return (d.getMonth() + 1) + '月' + d.getDate() + '日'
}

function fmtWeekCN(s) {
  return '周' + '一二三四五六日'[weekdayOf(s) - 1]
}

function nowHM() {
  const d = new Date()
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

module.exports = {
  pad, dateStr, parse, todayStr, addDays, weekdayOf,
  diffDays, startOfWeek, monthOf, daysInMonth, monthMatrix,
  fmtCN, fmtWeekCN, nowHM
}

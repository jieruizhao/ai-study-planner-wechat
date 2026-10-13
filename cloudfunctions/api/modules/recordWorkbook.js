/** 学习数据导出模板；文本保持原值，明确写为字符串，避免公式注入。 */
function buildWorkbook(payload, XLSX) {
  const wb = XLSX.utils.book_new()
  const sessions = (payload.sessions || []).filter(x => !x.deleted)
  const logs = (payload.logs || []).filter(x => !x.deleted).sort((a,b) => String(a.date).localeCompare(String(b.date)))
  const tasks = new Map(sessions.map(x => [x._id, x]))
  const types = { reading:'阅读', listening:'听力', writing:'写作', speaking:'口语', vocab:'词汇', other:'其他' }
  const state = { done:'已完成', pending:'未完成', skipped:'已跳过', partial:'部分完成', missed:'未完成' }
  const text = x => String(x == null ? '' : x)
  function sheet(name, rows, widths) {
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!cols'] = widths.map(wch => ({wch}))
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(0,rows.length-1),c:widths.length-1}}) }
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  sheet('学习记录', [['学习日期','学习名称','学习类型','关联任务','实际时长（分钟）','哪里卡住了？','下一步想做什么？','记录ID'],
    ...logs.map(l => [text(l.date),text(l.content),types[l.type] || text(l.type),text((tasks.get(l.sessionId) || {}).content),Number(l.durationMinutes) || 0,text(l.note),text(l.nextTip),text(l._id)])], [14,30,12,30,20,60,60,32])
  sheet('任务计划', [['日期','科目','任务名称','建议时长（分钟）','完成状态','任务ID'],
    ...sessions.sort((a,b) => String(a.date).localeCompare(String(b.date)) || (a.order || 0)-(b.order || 0)).map(s => [text(s.date),text(s.subject),text(s.content),Number(s.suggestedMinutes) || 0,state[s.status] || text(s.status),text(s._id)])], [14,16,40,20,14,32])
  const habits = new Map((payload.habits || []).map(h => [h._id,h]))
  sheet('习惯打卡', [['日期','习惯名称','打卡状态','习惯ID'], ...(payload.habitLogs || []).map(h => [text(h.date),text((habits.get(h.habitId) || {}).name),state[h.status] || text(h.status),text(h.habitId)])], [14,30,16,32])
  sheet('导出说明', [['项目','内容'], ['导出时间',text(payload.exportedAt)], ['学习记录数',logs.length], ['实际学习总分钟',logs.reduce((n,l) => n+(Number(l.durationMinutes) || 0),0)], ['说明','仅包含当前账号云端数据；已删除任务不导出，学习记录保留。备注中的换行和空格原样保留。'], ['文件用途','用于查阅和备份；任务导入请使用学习计划导入模板。']], [24,90])
  return wb
}
module.exports = { buildWorkbook }

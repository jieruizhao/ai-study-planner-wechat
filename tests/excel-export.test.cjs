const { test } = require('node:test')
const assert = require('node:assert/strict')
const XLSX = require('xlsx')
const { runtime, database, context } = require('./helpers.cjs')

test('实际生成的Excel完整导出超过100条记录，只包含当前账号，保留长文本且不执行公式', async () => {
  const note = '第一行  两个空格\n第二行' + '字'.repeat(9900)
  const logs = Array.from({length:125},(_,i) => ({_id:'l'+i,userId:'user_a',date:'2026-10-07',content:'=1+1',durationMinutes:30,note,nextTip:'  下一步\n继续',type:'reading',sessionId:'s'}))
  logs.push({_id:'foreign',userId:'user_b',content:'他人私密记录'})
  const r = runtime({db:database({users:[{_id:'u',openid:'user_a'}],logs,sessions:[{_id:'s',userId:'user_a',content:'阅读任务',date:'2026-10-07',suggestedMinutes:45,status:'done'},{_id:'deleted',userId:'user_a',deleted:true}],habits:[{_id:'h',userId:'user_a',name:'复习'}],habitLogs:[{_id:'hl',userId:'user_a',habitId:'h',date:'2026-10-07',status:'done'}]})})
  let upload
  const ctx = context(r.db,{},'user_a','2026-10-07')
  ctx.cloud = {uploadFile:async value => {upload=value;return {fileID:'cloud://export'}}}
  const result = await r.load('cloudfunctions/api/modules/data.js').exportExcel(ctx)
  assert.equal(result.count,125);assert.equal(result.fileName,'学习记录_2026-10-07.xlsx')
  assert.ok(!upload.cloudPath.includes('user_a'))
  const wb = XLSX.read(upload.fileContent,{type:'buffer'})
  assert.deepEqual(wb.SheetNames,['学习记录','任务计划','习惯打卡','导出说明'])
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['学习记录'],{header:1})
  assert.equal(rows.length,126);assert.equal(rows[1][5],note);assert.equal(rows[1][6],'  下一步\n继续')
  assert.equal(wb.Sheets['学习记录'].B2.t,'s');assert.equal(wb.Sheets['学习记录'].B2.f,undefined)
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['任务计划']).length,1)
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['习惯打卡'])[0]['习惯名称'],'复习')
})
test('空记录也生成带表头的Excel',()=>{
  const {buildWorkbook}=require('../cloudfunctions/api/modules/recordWorkbook')
  const wb=buildWorkbook({},XLSX)
  assert.equal(wb.Sheets['学习记录'].A1.v,'学习日期')
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['学习记录']).length,0)
})
test('导出生成文件后点击下载并打开xlsx，重复点击不并发下载且不使用剪贴板',async()=>{
  const r=runtime();r.getApp();const p=r.page('profile');let clipboard=0,downloads=0,opened
  r.wx.setClipboardData=()=>clipboard++
  r.options.transport=()=>({fileID:'cloud://export',fileName:'学习记录.xlsx',count:3})
  await p.exportData();assert.equal(p.data.exportFile.count,3)
  r.wx.env={USER_DATA_PATH:'/local'}
  r.wx.cloud.downloadFile=o=>{downloads++;o.success({tempFilePath:'/temp/file'})}
  r.wx.getFileSystemManager=()=>({copyFile:o=>o.success()})
  r.wx.openDocument=o=>{opened=o;o.success()}
  await Promise.all([p.downloadExport(),p.downloadExport()])
  assert.equal(downloads,1);assert.equal(opened.fileType,'xlsx');assert.equal(opened.showMenu,true)
  assert.equal(opened.filePath,'/local/学习记录.xlsx');assert.equal(clipboard,0)
})
test('导出和下载失败允许重试，未同步数据不导出',async()=>{
  const r=runtime();r.getApp();const p=r.page('profile');r.options.offline=true
  r.store().get().queue.push({operationId:'op',type:'habit.save',payload:{_id:'h'}})
  await p.exportData();assert.match(p.data.exportError,/未同步|网络/);assert.equal(p.data.exportFile,null);assert.equal(p.data.exporting,false)
  r.store().get().queue=[];r.options.offline=false;r.options.transport=()=>({fileID:'cloud://f',fileName:'f.xlsx',count:0})
  await p.exportData();r.wx.cloud.downloadFile=o=>o.fail({errMsg:'offline'})
  await p.downloadExport();assert.match(p.data.exportError,/下载/);assert.equal(p.data.downloading,false)
})
test('后台未声明文件用途与用户拒绝隐私授权分别提示',()=>{
  const r=runtime(),p=r.page('profile')
  r.wx.chooseMessageFile=o=>o.fail({errMsg:'chooseMessageFile:fail api scope is not declared in the privacy agreement'})
  p.importExcel();assert.match(p.data.importError,/后台未声明/);assert.match(p.data.importError,/不是你拒绝/)
})

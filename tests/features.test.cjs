const { test } = require('node:test')
const assert = require('node:assert/strict')
const { runtime, database, context, clone } = require('./helpers.cjs')
const TODAY = '2026-10-07'
const NOW = Date.parse(TODAY + 'T04:00:00Z')
const plan = { title: '测试计划', startDate: TODAY, studyWeekdays: [1,2,3,4,5,6,7], extraRestDates: [], dailyMaxSessions: 6, template: [{subject:'阅读',content:'原计划',minutes:30}] }
const request = { date:TODAY,subject:'口语',content:'新增练习',suggestedMinutes:25,clientRequestId:'request_001' }

test('提醒有效项优先，过期单次和停用项沉底，重复提醒不按当天时刻过期',()=>{
  const r=runtime({now:new Date(2026,9,8,21,39).getTime()});r.getApp()
  r.store().get().habits=[{_id:'past',date:'2026-10-07',reminderTime:'23:59'}, {_id:'daily',reminderTime:'08:00'}, {_id:'off',enabled:false}, {_id:'future',date:'2026-10-09',reminderTime:'08:00'}, {_id:'earlier',date:'2026-10-08',reminderTime:'21:38'}, {_id:'now',date:'2026-10-08',reminderTime:'21:39'}]
  const p=r.page('habits');p.render()
  assert.deepEqual(Array.from(p.data.habits,x=>x._id),['daily','future','now','past','off','earlier'])
  assert.equal(p.data.invalidCount,3)
})
test('批量清理先确认，删除同步到云端，保留有效提醒、他人提醒和历史打卡',async()=>{
  const seed=[{_id:'past',userId:'user_a',date:'2026-10-07',name:'旧提醒',enabled:true},{_id:'off',userId:'user_a',enabled:false,name:'停用'},{_id:'daily',userId:'user_a',enabled:true,name:'每天'}]
  const r=runtime({now:new Date(2026,9,8,21,39).getTime(),confirm:false,db:database({users:[{_id:'u',openid:'user_a'}],habits:[...seed,{_id:'other',userId:'other',enabled:false}],reminders:[{_id:'r',userId:'user_a',reminderId:'past'}],habitLogs:[{_id:'log',userId:'user_a',habitId:'past',status:'done'}]})});r.getApp()
  r.store().get().habits=clone(seed);const p=r.page('habits')
  p.clearInvalid();assert.equal(r.store().get().habits.length,3);assert.equal(p.data.clearing,false)
  r.options.confirm=true;await p.clearInvalid();await r.sync().flush()
  assert.deepEqual(Array.from(r.store().get().habits,x=>x._id),['daily'])
  assert.deepEqual(r.db.tables.habits.map(x=>x._id).sort(),['daily','other'])
  assert.equal(r.db.tables.reminders.length,0);assert.equal(r.db.tables.habitLogs.length,1)
})
test('离线清理保留删除队列，过期提醒不能订阅，确认期间恢复的提醒不删除',async()=>{
  const r=runtime({now:new Date(2026,9,8,21,39).getTime(),offline:true,confirm:true});r.getApp()
  r.store().get().habits=[{_id:'past',date:'2026-10-07',enabled:true,reminderTime:'12:00'}]
  const p=r.page('habits');let subscriptions=0;r.wx.requestSubscribeMessage=()=>subscriptions++
  p.requestWechat({currentTarget:{dataset:{id:'past'}}});assert.equal(subscriptions,0)
  await p.clearInvalid();assert.equal(r.store().get().habits.length,0)
  assert.ok(r.store().get().queue.some(x=>x.type==='habit.delete'))
  assert.equal(p.data.clearing,false)
  r.store().get().habits=[{_id:'restored',enabled:false}]
  let modal;r.wx.showModal=o=>{modal=o};p.clearInvalid()
  r.store().get().habits[0].enabled=true
  await modal.success({confirm:true});assert.equal(r.store().get().habits.length,1)
})
function setup(seed={}) { return runtime({now:NOW,db:database({users:[{_id:'u',openid:'user_a'}],...seed})}) }
function ctx(r,payload,user='user_a') { return context(r.db,payload,user,TODAY) }

test('首页记一笔优先当前未完成任务，名称可编辑且备注独立保存',async()=>{
  const r=setup({sessions:[{_id:'current',userId:'user_a',date:TODAY,status:'pending',version:1}]});r.getApp();r.store().setSessions(TODAY,[
    {_id:'done',date:TODAY,order:0,status:'done',subject:'阅读',content:'已完成'},
    {_id:'current',date:TODAY,order:1,status:'pending',subject:'听力',content:'当前练习',version:1}
  ]);
  const home=r.page('today');home.quickLog();
  assert.match(r.calls.at(-1).url,/sessionId=current/);
  const page=r.page('log-edit');page.onLoad({date:TODAY,sessionId:'current'});
  assert.equal(page.data.content,'当前练习');
  page.onContent({detail:{value:'修改后的学习名称'}});page.onStuck({detail:{value:'学习备注'}});
  page.save();await r.sync().flush();
  assert.equal(r.db.tables.logs[0].content,'修改后的学习名称');
  assert.equal(r.db.tables.logs[0].note,'学习备注');
  assert.equal(r.store().sessionsOf(TODAY)[1].content,'当前练习');
});

test('无待办时自由记录可填写名称，全部完成不关联旧任务',async()=>{
  const r=setup();r.getApp();r.store().setSessions(TODAY,[{_id:'done',status:'done',order:0}]);
  r.page('today').quickLog();assert.ok(!r.calls.at(-1).url.includes('sessionId'));
  const page=r.page('log-edit');page.onLoad({date:TODAY});assert.equal(page.data.content,'');
  page.onContent({detail:{value:'自主阅读'}});page.save();await r.sync().flush();
  assert.equal(r.db.tables.logs[0].content,'自主阅读');
});

test('新增任务当天保存后详情、首页及日历立即显示，刷新保持',async()=>{
  const r=setup();r.getApp();const page=r.page('day');page.onLoad({date:TODAY});page.openAddTask();
  page.onTaskContent({detail:{value:'新增练习'}});page.onTaskMinutes({detail:{value:'25'}});
  await page.saveTask();assert.equal(page.data.addTaskShow,false);assert.equal(page.data.plan.length,1);
  assert.equal(r.store().get().plan,null);assert.equal(r.db.tables.sessions.length,1);
  const home=r.page('today');home.render();assert.equal(home.data.tasks[0].content,'新增练习');
  const cal=r.page('calendar');cal.data.ym='2026-10';cal.render();assert.match(cal.data.todayRow.title,/新增练习/);
  await page.refresh();assert.match(page.data.plan[0].title,/新增练习/);
});

test('日历所选过去、今天、未来均可新增任务，日期不被改为今天',async()=>{
  for(const date of ['2026-10-06',TODAY,'2026-10-09']){
    const r=setup();r.getApp();const page=r.page('day');page.onLoad({date});page.openAddTask();page.data.taskContent='所选日期练习';
    await page.saveTask();assert.equal(r.db.tables.sessions[0].date,date);assert.equal(page.data.plan.length,1);
  }
});

test('任务保存失败保留表单，不虚报成功；重复点击只新增一次',async()=>{
  const r=setup();r.getApp();const page=r.page('day');page.onLoad({date:TODAY});page.openAddTask();page.data.taskContent='待重试';
  r.options.offline=true;await page.saveTask();assert.equal(page.data.addTaskShow,true);assert.equal(page.data.taskContent,'待重试');assert.ok(page.data.taskError);
  assert.ok(!r.calls.some(x=>x.icon==='success'));
  r.options.offline=false;await Promise.all([page.saveTask(),page.saveTask()]);assert.equal(r.db.tables.sessions.length,1);
});

test('新增任务同一请求并发与重试幂等；不同用户互不覆盖',async()=>{
  const r=setup(),service=r.load('cloudfunctions/api/modules/plan.js');
  const values=await Promise.all([service.addSession(ctx(r,request)),service.addSession(ctx(r,request))]);
  assert.equal(values[0].doc._id,values[1].doc._id);assert.equal(r.db.tables.sessions.length,1);
  await service.addSession(ctx(r,request));assert.equal(r.db.tables.sessions.length,1);
  const other=await service.addSession(ctx(r,request,'user_b'));assert.notEqual(other.doc._id,values[0].doc._id);assert.equal(r.db.tables.sessions.length,2);
  await assert.rejects(service.addSession(ctx(r,{...request,content:'改变原请求'})),{code:409});
});

test('新增任务拒绝非法日期、空名称与异常时长，不写入数据',async()=>{
  const r=setup(),service=r.load('cloudfunctions/api/modules/plan.js');
  for(const patch of [{date:'2026-02-30'},{content:''},{suggestedMinutes:0},{suggestedMinutes:601},{suggestedMinutes:25.5},{subject:''},{clientRequestId:''}]){
    await assert.rejects(service.addSession(ctx(r,{...request,...patch})),{code:400});
  }
  assert.equal((r.db.tables.sessions||[]).length,0);
});

test('手动任务不修改每日模板，修改模板与Excel重排均保留手动项',async()=>{
  const r=setup(),service=r.load('cloudfunctions/api/modules/plan.js');
  await service.confirmReorder(ctx(r,{plan,baseVersion:0}));
  const added=await service.addSession(ctx(r,request));
  const result=await service.confirmReorder(ctx(r,{plan:{...plan,template:[{subject:'阅读',content:'更新模板',minutes:30}]},baseVersion:1}));
  assert.equal(result.plan.template.length,1);assert.equal(result.sessionsByDate[TODAY].length,2);
  assert.ok(r.db.tables.sessions.some(x=>x._id===added.doc._id));
  await r.load('cloudfunctions/api/modules/data.js').importApply(ctx(r,{rows:[{date:TODAY,subject:'单词',content:'导入练习',minutes:20}],baseVersion:2}));
  assert.ok(r.db.tables.sessions.some(x=>x._id===added.doc._id));
});

test('计划正在重排时新增返回可重试提示，既有任务不变',async()=>{
  const r=setup({plans:[{_id:'p',userId:'user_a',version:2,scheduling:true}]});
  await assert.rejects(r.load('cloudfunctions/api/modules/plan.js').addSession(ctx(r,request)),{code:409});
  assert.equal((r.db.tables.sessions||[]).length,0);
});

test('结束立即暂停；取消记录期间不计时，继续从原时长累加',()=>{
  let now=NOW;
  const r=runtime({now:NOW,clock:()=>now});r.getApp();
  const focus=r.page('focus');focus.onLoad({date:TODAY});focus.onShow();
  now+=125000;focus.finish();
  assert.equal(focus.data.running,false);assert.equal(focus.data.elapsed,125);assert.equal(focus.data.mmss,'02:05');
  const nav=r.calls.at(-1);assert.equal(nav.name,'navigateTo');assert.match(nav.url,/minutes=2$/);
  const log=r.page('log-edit');log.onLoad(Object.fromEntries(new URL('https://local'+nav.url).searchParams));
  assert.equal(log.data.minutes,2);assert.equal(log.data.actualTimeText,'2 分 5 秒');
  now+=300000;log.back();focus.onShow();assert.equal(focus.data.running,false);assert.equal(focus.data.elapsed,125);
  assert.equal(r.store().logsOf(TODAY).length,0);assert.equal(r.sync().pendingCount(),0);
  focus.toggleRun();now+=35000;focus.tick();assert.equal(focus.data.elapsed,160);
  focus.finish();assert.equal(focus.data.running,false);assert.match(r.calls.at(-1).url,/elapsedSeconds=160&minutes=3$/);
});

test('暂停后结束不新增暂停时长，重复结束只打开一次记录页',()=>{
  let now=NOW;const r=runtime({now:NOW,clock:()=>now}),focus=r.page('focus');
  focus.onLoad({date:TODAY});focus.onShow();now+=90000;focus.toggleRun();now+=60000;
  focus.finish();focus.finish();assert.equal(focus.data.elapsed,90);assert.equal(focus.data.running,false);
  assert.equal(r.calls.filter(x=>x.name==='navigateTo').length,1);
});

test('打开记录失败仍保持暂停，可继续或重试打开',()=>{
  let now=NOW;const r=runtime({now:NOW,clock:()=>now}),focus=r.page('focus');
  focus.onLoad({date:TODAY});focus.onShow();now+=60000;
  r.wx.navigateTo=options=>{options.fail()};focus.finish();
  assert.equal(focus.data.running,false);assert.equal(focus.data.elapsed,60);assert.equal(focus._openingLog,false);
  now+=50000;focus.tick();assert.equal(focus.data.elapsed,60);focus.toggleRun();now+=10000;focus.tick();assert.equal(focus.data.elapsed,70);
});

test('专注记录保存后结束该轮计时，返回首页路径，不会继续同一轮重复记录',async()=>{
  const r=setup();r.getApp();const focus=r.page('focus');focus.onLoad({date:TODAY});
  focus._base=1800;focus.data.running=false;focus.finish();const nav=r.calls.at(-1);
  const log=r.page('log-edit');log.onLoad(Object.fromEntries(new URL('https://local'+nav.url).searchParams));
  log.getOpenerEventChannel=()=>({emit:name=>nav.events[name]()});
  log.save();await r.sync().flush();assert.equal(r.db.tables.logs[0].durationMinutes,30);
  assert.equal(focus._logSaved,true);focus.onShow();assert.equal(r.calls.at(-1).name,'navigateBack');
  const before=r.calls.filter(x=>x.name==='navigateTo').length;focus.finish();assert.equal(r.calls.filter(x=>x.name==='navigateTo').length,before);
});

test('日期详情编辑单条任务预填原值，保存更新首页并保留同日其他任务和学习记录',async()=>{
  const r=setup();r.getApp();const service=r.load('cloudfunctions/api/modules/plan.js');
  const created=await service.confirmReorder(ctx(r,{plan,baseVersion:0}));r.store().applyServerBuckets(created.buckets);
  const other=await service.addSession(ctx(r,request));r.store().setSessions(TODAY,r.store().sessionsOf(TODAY).concat(other.doc));
  r.store().setLogs(TODAY,[{_id:'log',date:TODAY,content:'原计划',durationMinutes:20}]);
  const target=r.store().sessionsOf(TODAY)[0],page=r.page('day');page.onLoad({date:TODAY});
  page.editTask({currentTarget:{dataset:{id:target._id}}});
  assert.equal(page.data.taskContent,'原计划');assert.equal(page.data.taskMinutes,30);
  page.onTaskContent({detail:{value:'修改后的任务'}});page.onTaskMinutes({detail:{value:40}});
  await page.saveTask();assert.equal(page.data.addTaskShow,false);
  const updated=r.store().sessionsOf(TODAY).find(x=>x._id===target._id);assert.equal(updated.content,'修改后的任务');assert.equal(updated.suggestedMinutes,40);
  assert.equal(r.store().sessionsOf(TODAY).find(x=>x._id===other.doc._id).content,request.content);
  assert.equal(r.store().logsOf(TODAY)[0].content,'原计划');
  const home=r.page('today');home.render();assert.ok(home.data.tasks.some(x=>x.content==='修改后的任务'));
  await page.refresh();assert.ok(page.data.plan.some(x=>x.title.includes('修改后的任务')));
});

test('日期详情删除先确认，取消不删除；确认只移除目标任务并保留学习记录',async()=>{
  const r=setup();r.getApp();const service=r.load('cloudfunctions/api/modules/plan.js');
  const first=(await service.addSession(ctx(r,request))).doc;
  const second=(await service.addSession(ctx(r,{...request,clientRequestId:'request_002',content:'另一条任务'}))).doc;
  r.store().setSessions(TODAY,[first,second]);r.store().setLogs(TODAY,[{_id:'l',date:TODAY,content:'历史学习',durationMinutes:10}]);
  const page=r.page('day');page.onLoad({date:TODAY});
  r.options.confirm=false;await page.removeTask({currentTarget:{dataset:{id:first._id}}});assert.equal(r.store().sessionsOf(TODAY).length,2);
  r.options.confirm=true;await page.removeTask({currentTarget:{dataset:{id:first._id}}});
  assert.equal(r.store().sessionsOf(TODAY).length,1);assert.equal(r.store().sessionsOf(TODAY)[0]._id,second._id);
  assert.equal(r.store().logsOf(TODAY).length,1);await page.refresh();assert.equal(page.data.plan.length,1);
});

test('任务编辑和删除失败时保留数据，编辑输入可以重试',async()=>{
  const r=setup();r.getApp();const doc=(await r.load('cloudfunctions/api/modules/plan.js').addSession(ctx(r,request))).doc;
  r.store().setSessions(TODAY,[doc]);const page=r.page('day');page.onLoad({date:TODAY});
  page.editTask({currentTarget:{dataset:{id:doc._id}}});page.data.taskContent='未保存的修改';r.options.offline=true;
  await page.saveTask();assert.equal(page.data.addTaskShow,true);assert.equal(page.data.taskContent,'未保存的修改');
  assert.equal(r.store().sessionsOf(TODAY)[0].content,request.content);
  await page.deleteTask(doc);assert.equal(r.store().sessionsOf(TODAY).length,1);assert.ok(page.data.taskActionError);
  r.options.offline=false;await page.saveTask();assert.equal(r.store().sessionsOf(TODAY)[0].content,'未保存的修改');
});

test('任务编辑删除按用户和日期隔离，版本冲突不覆盖新内容',async()=>{
  const r=setup(),service=r.load('cloudfunctions/api/modules/plan.js'),doc=(await service.addSession(ctx(r,request))).doc;
  const patch={sessionId:doc._id,date:TODAY,baseVersion:1,subject:'写作',content:'改后的任务',suggestedMinutes:50};
  await assert.rejects(service.updateSession(ctx(r,patch,'user_b')),{code:403});
  await assert.rejects(service.removeSession(ctx(r,patch,'user_b')),{code:403});
  await assert.rejects(service.updateSession(ctx(r,{...patch,date:'2026-10-08'})),{code:400});
  const updated=await service.updateSession(ctx(r,patch));assert.equal(updated.doc.version,2);
  await assert.rejects(service.updateSession(ctx(r,{...patch,content:'旧版本覆盖'})),{code:409});
  await assert.rejects(service.removeSession(ctx(r,patch)),{code:409});
  assert.equal(r.db.tables.sessions[0].content,'改后的任务');
});

test('已完成任务拒绝编辑，仍可删除且保留学习记录，重复删除幂等',async()=>{
  const r=setup(),service=r.load('cloudfunctions/api/modules/plan.js'),doc=(await service.addSession(ctx(r,request))).doc;
  r.db.tables.sessions[0].status='done';r.db.tables.logs=[{_id:'l',userId:'user_a',date:TODAY,content:'真实学习',durationMinutes:25}];
  await assert.rejects(service.updateSession(ctx(r,{...request,sessionId:doc._id,baseVersion:1,content:'新标题'})),{code:403});
  await assert.rejects(service.updateSession(ctx(r,{...request,sessionId:doc._id,baseVersion:1})),{code:403});
  assert.equal(r.db.tables.sessions[0].content,request.content);
  const payload={sessionId:doc._id,date:TODAY,baseVersion:1};
  await service.removeSession(ctx(r,payload));await service.removeSession(ctx(r,payload));
  const day=await service.getDay(ctx(r,{date:TODAY}));assert.equal(day.buckets.sessions[TODAY].length,0);assert.equal(day.buckets.logs[TODAY].length,1);
  await assert.rejects(service.setSessionStatus(ctx(r,{sessionId:doc._id,status:'pending',baseVersion:3})),{code:404});
});

test('已完成任务不打开编辑；编辑过程中完成后保存被拦截',async()=>{
  const r=setup();r.getApp();const doc=(await r.load('cloudfunctions/api/modules/plan.js').addSession(ctx(r,request))).doc;
  r.store().setSessions(TODAY,[doc]);const page=r.page('day');page.onLoad({date:TODAY});
  r.store().setSessionStatus(TODAY,doc._id,'done');page.editTask({currentTarget:{dataset:{id:doc._id}}});
  assert.equal(page.data.addTaskShow,false);
  r.store().setSessionStatus(TODAY,doc._id,'pending');page.editTask({currentTarget:{dataset:{id:doc._id}}});
  page.data.taskContent='不应保存的修改';r.store().setSessionStatus(TODAY,doc._id,'done');
  await page.saveTask();assert.match(page.data.taskError,/已完成/);
  assert.equal(r.db.tables.sessions[0].content,request.content);
});

test('模板任务单日修改后重排保留修改，不重复生成旧任务；其他日期不变',async()=>{
  const r=setup(),service=r.load('cloudfunctions/api/modules/plan.js');
  const result=await service.confirmReorder(ctx(r,{plan,baseVersion:0})),doc=result.sessionsByDate[TODAY][0];
  await service.updateSession(ctx(r,{sessionId:doc._id,date:TODAY,baseVersion:1,subject:'阅读',content:'当天定制',suggestedMinutes:35}));
  const replan=await service.confirmReorder(ctx(r,{plan,baseVersion:1}));
  assert.equal(replan.sessionsByDate[TODAY].length,1);assert.equal(replan.sessionsByDate[TODAY][0].content,'当天定制');
  assert.equal(replan.sessionsByDate['2026-10-08'][0].content,'原计划');
});

test('单日删除模板任务后刷新、重排、区间查询均不恢复已删除项',async()=>{
  const r=setup(),service=r.load('cloudfunctions/api/modules/plan.js');
  const result=await service.confirmReorder(ctx(r,{plan,baseVersion:0})),doc=result.sessionsByDate[TODAY][0];
  await service.removeSession(ctx(r,{sessionId:doc._id,date:TODAY,baseVersion:1}));
  const replan=await service.confirmReorder(ctx(r,{plan,baseVersion:1}));assert.equal(replan.sessionsByDate[TODAY].length,0);
  assert.equal(replan.sessionsByDate['2026-10-08'].length,1);
  const range=await service.getRange(ctx(r,{from:TODAY,to:'2026-10-08'}));assert.equal(range.buckets.sessions[TODAY].length,0);
});

test('重复模板任务只删除一条，另一条同名同日任务仍保留',async()=>{
  const r=setup(),service=r.load('cloudfunctions/api/modules/plan.js'),repeated={...plan,template:plan.template.concat(plan.template)};
  const result=await service.confirmReorder(ctx(r,{plan:repeated,baseVersion:0})),doc=result.sessionsByDate[TODAY][0];
  await service.removeSession(ctx(r,{sessionId:doc._id,date:TODAY,baseVersion:1}));
  const reordered=await service.confirmReorder(ctx(r,{plan:repeated,baseVersion:1}));assert.equal(reordered.sessionsByDate[TODAY].length,1);
});

test('删除编辑期间与其他设备并发修改，只有一个版本写入成功',async()=>{
  const r=setup(),service=r.load('cloudfunctions/api/modules/plan.js'),doc=(await service.addSession(ctx(r,request))).doc;
  const payload={...request,sessionId:doc._id,baseVersion:1,content:'并发编辑'};
  const results=await Promise.allSettled([service.updateSession(ctx(r,payload)),service.removeSession(ctx(r,payload))]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.code===409).length,1);
});


test('任务记录入口使用卡片ID，列表仅展示该任务的记录且详情不生成新记录',async()=>{
  const {r,page}=homeWithCards();
  page.goTaskRecords({currentTarget:{dataset:{id:'done'}}});assert.match(r.calls.at(-1).url,/sessionId=done$/);
  r.store().setLogs(TODAY,[{_id:'one',date:TODAY,sessionId:'done',content:'第一条',durationMinutes:20,note:'  第一行\n第二行  ',nextTip:'\n下一步  '},
    {_id:'two',date:TODAY,sessionId:'second',durationMinutes:90},{_id:'free',date:TODAY,durationMinutes:10}]);
  const records=r.page('task-records');records.onLoad({date:TODAY,sessionId:'done'});records.render();
  assert.equal(records.data.logs.length,1);assert.equal(records.data.minutes,20);
  records.openLog({currentTarget:{dataset:{id:'one'}}});assert.match(r.calls.at(-1).url,/logId=one&sessionId=done$/);
  const detail=r.page('log-edit');detail.onLoad({date:TODAY,logId:'one',sessionId:'done'});
  assert.equal(detail.data.readOnly,true);assert.equal(detail.data.stuck,'  第一行\n第二行  ');assert.equal(detail.data.next,'\n下一步  ');
  detail.save();assert.equal(r.store().logsOf(TODAY).length,3);
  detail.onLoad({date:TODAY,logId:'two',sessionId:'done'});assert.equal(detail.data.missing,true);
});

test('10000字含换行空格在本地保存、同步和刷新后原样保留',async()=>{
  const r=setup({sessions:[{_id:'s',userId:'user_a',date:TODAY,status:'done',subject:'阅读',content:'任务'}]});r.getApp();
  r.store().setSessions(TODAY,clone(r.db.tables.sessions));
  const value='  \n'+ '字'.repeat(9994)+'\n  ';
  assert.equal(value.length,10000);
  const page=r.page('log-edit');page.onLoad({date:TODAY,sessionId:'s'});page.onStuck({detail:{value}});page.onNext({detail:{value}});page.save();
  assert.equal(r.store().logsOf(TODAY)[0].sessionId,'s');await r.sync().flush();
  const saved=r.db.tables.logs[0];assert.equal(saved.note,value);assert.equal(saved.nextTip,value);assert.equal(saved.sessionId,'s');
  const records=r.page('task-records');records.onLoad({date:TODAY,sessionId:'s'});await records.refresh();
  assert.equal(records.data.logs[0].note,value);
});

test('前端限制10000字，后端拒绝超限新增和更新，不静默截断',async()=>{
  const r=setup(),service=r.load('cloudfunctions/api/modules/log.js'),page=r.page('log-edit');
  page.onStuck({detail:{value:'字'.repeat(10001)}});assert.equal(page.data.stuck.length,10000);
  page.onNext({detail:{value:'字'.repeat(10001)}});assert.equal(page.data.next.length,10000);
  await assert.rejects(service.add(ctx(r,{clientTempId:'big',date:TODAY,note:'字'.repeat(10001)})),{code:400});assert.equal(r.db.tables.logs.length,0);
  const saved=await service.add(ctx(r,{clientTempId:'ok',date:TODAY,note:'  原文\n ',nextTip:'  下一步\n '}));
  await assert.rejects(service.update(ctx(r,{logId:'ok',baseVersion:1,patch:{nextTip:'字'.repeat(10001)}})),{code:400});
  const updated=await service.update(ctx(r,{logId:'ok',baseVersion:1,patch:{note:'字'.repeat(10000)}}));assert.equal(updated.doc.note.length,10000);assert.equal(saved.doc.nextTip,'  下一步\n ');
});

test('任务记录不能关联其他用户或错误日期任务，同名任务不串记录',async()=>{
  const r=setup({sessions:[{_id:'foreign',userId:'other',date:TODAY},{_id:'wrong',userId:'user_a',date:'2026-10-06'}]});
  const service=r.load('cloudfunctions/api/modules/log.js');
  await assert.rejects(service.add(ctx(r,{clientTempId:'a',date:TODAY,sessionId:'foreign'})),{code:403});
  await assert.rejects(service.add(ctx(r,{clientTempId:'b',date:TODAY,sessionId:'wrong'})),{code:400});
  assert.equal(r.db.tables.logs.length,0);
});

test('任务记录离线保留待同步内容，刷新不覆盖本地新增，空任务安全显示',async()=>{
  const r=setup();r.getApp();r.options.offline=true;
  const log={_id:'pending',date:TODAY,sessionId:'s',content:'本地记录',durationMinutes:30,note:'\n  '};
  r.store().upsertLog(log);r.sync().enqueue('log.add',{...log,clientTempId:log._id});
  const page=r.page('task-records');page.onLoad({date:TODAY,sessionId:'s'});await page.refresh();
  assert.equal(page.data.logs[0].note,'\n  ');assert.ok(page.data.error);
  r.store().applyServerBuckets({logs:{[TODAY]:[]}});page.render();assert.equal(page.data.logs.length,1);
  page.onLoad({date:TODAY});page.render();assert.equal(page.data.logs.length,0);
});

test('任务记录超过100条完整加载，同名其他任务及其他用户记录不会混入',async()=>{
  const logs=Array.from({length:125},(_,i)=>({_id:'many'+i,userId:'user_a',date:TODAY,sessionId:'s',content:'同名任务',durationMinutes:1}));
  logs.push({_id:'otherTask',userId:'user_a',date:TODAY,sessionId:'another',content:'同名任务',durationMinutes:99});
  logs.push({_id:'foreign',userId:'other',date:TODAY,sessionId:'s',durationMinutes:99});
  const r=setup({logs});r.getApp();const page=r.page('task-records');page.onLoad({date:TODAY,sessionId:'s'});await page.refresh();
  assert.equal(page.data.logs.length,125);assert.equal(page.data.minutes,125);
  assert.ok(!page.data.logs.some(l=>l._id==='foreign'||l._id==='otherTask'));
});

test('记录左滑展开删除，右滑关闭，纵向滚动不展开，滑动不误打开详情',()=>{
  const r=setup();r.getApp();r.store().setLogs(TODAY,[{_id:'l',date:TODAY,sessionId:'s',durationMinutes:30}]);
  const page=r.page('task-records');page.onLoad({date:TODAY,sessionId:'s'});page.render();
  const start={currentTarget:{dataset:{id:'l'}},touches:[{clientX:10,clientY:10}]};
  page.touchStart(start);page.touchEnd({changedTouches:[{clientX:-80,clientY:12}]});assert.equal(page.data.openSwipeId,'l');
  page.openLog({currentTarget:{dataset:{id:'l'}}});assert.ok(!r.calls.some(c=>c.name==='navigateTo'));
  page.touchStart(start);page.touchEnd({changedTouches:[{clientX:90,clientY:12}]});assert.equal(page.data.openSwipeId,'');
  page.touchStart(start);page.touchEnd({changedTouches:[{clientX:90,clientY:180}]});assert.equal(page.data.openSwipeId,'');
});

test('列表删除取消保留，确认只删除选中记录，刷新同步后统计更新',async()=>{
  const logs=[{_id:'a',userId:'user_a',date:TODAY,sessionId:'s',durationMinutes:30},{_id:'b',userId:'user_a',date:TODAY,sessionId:'s',durationMinutes:20}];
  const r=setup({logs});r.getApp();r.store().setLogs(TODAY,clone(logs));
  const page=r.page('task-records');page.onLoad({date:TODAY,sessionId:'s'});page.render();
  r.options.confirm=false;page.deleteRecord({currentTarget:{dataset:{id:'a'}}});assert.equal(page.data.logs.length,2);
  r.options.confirm=true;page.deleteRecord({currentTarget:{dataset:{id:'a'}}});assert.equal(page.data.logs.length,1);assert.equal(page.data.minutes,20);
  await r.sync().flush();await page.refresh();assert.equal(page.data.logs[0]._id,'b');assert.equal(r.db.tables.logs.length,1);
});

test('详情编辑保存更新原记录，任务关联与10000字格式保留，重复保存不新增',async()=>{
  const log={_id:'l',userId:'user_a',date:TODAY,sessionId:'s',type:'reading',durationMinutes:30,content:'原名称',note:'原文',version:1};
  const r=setup({logs:[log]});r.getApp();r.store().setLogs(TODAY,[clone(log)]);
  const page=r.page('log-edit');page.onLoad({date:TODAY,logId:'l',sessionId:'s'});page.editRecord();assert.equal(page.data.readOnly,false);
  const note=' \n'+'字'.repeat(9996)+'\n ';page.onStuck({detail:{value:note}});page.onNext({detail:{value:'  下一步\n '}});page.onContent({detail:{value:'新名称'}});page.onMinutes({detail:{value:'45'}});
  const pending=page.save();page.save();await pending;
  assert.equal(r.db.tables.logs.length,1);assert.equal(r.db.tables.logs[0].sessionId,'s');assert.equal(r.db.tables.logs[0].note,note);assert.equal(r.db.tables.logs[0].durationMinutes,45);
  assert.equal(page.data.readOnly,true);assert.equal(page.data.saving,false);assert.equal(page.data.content,'新名称');
});

test('详情离线保存保留修改和队列，返回列表可见；详情删除二次确认',async()=>{
  const log={_id:'l',date:TODAY,sessionId:'s',durationMinutes:30,content:'原文',version:1};
  const r=setup();r.getApp();r.options.offline=true;r.store().setLogs(TODAY,[log]);
  const page=r.page('log-edit');page.onLoad({date:TODAY,logId:'l',sessionId:'s'});page.editRecord();page.onStuck({detail:{value:'离线修改\n  '}});await page.save();
  assert.equal(r.store().logsOf(TODAY)[0].note,'离线修改\n  ');assert.equal(r.store().get().queue[0].type,'log.update');
  r.options.confirm=false;page.deleteRecord();assert.equal(r.store().logsOf(TODAY).length,1);
  r.options.confirm=true;page.deleteRecord();assert.equal(r.store().logsOf(TODAY).length,0);assert.equal(page.data.missing,true);
  r.store().applyServerBuckets({logs:{[TODAY]:[log]}});assert.equal(r.store().logsOf(TODAY).length,0);
});

test('编辑记录在其他设备被修改时保留本地副本，不覆盖服务器版本',async()=>{
  const remote={_id:'l',userId:'user_a',date:TODAY,sessionId:'s',type:'reading',content:'服务器内容',note:'服务器笔记',durationMinutes:30,version:2};
  const r=setup({logs:[remote],sessions:[{_id:'s',userId:'user_a',date:TODAY,status:'done'}]});r.getApp();
  r.store().setLogs(TODAY,[{...remote,content:'旧内容',version:1}]);const page=r.page('log-edit');page.onLoad({date:TODAY,logId:'l',sessionId:'s'});page.editRecord();page.onStuck({detail:{value:'我的修改'}});await page.save();
  assert.equal(r.db.tables.logs.find(l=>l._id==='l').note,'服务器笔记');
  const copy=r.db.tables.logs.find(l=>l._id!=='l');assert.equal(copy.note,'我的修改');assert.equal(copy.sessionId,'s');
  assert.equal(page.data.stuck,'服务器笔记');
});

test('手机日历添加每日重复提醒，传秒时间戳及准点通知，成功才记录本机状态',()=>{
  const r=setup();r.getApp();r.options.confirm=true;
  const h={_id:'h',name:'复习',enabled:true,reminderTime:'12:00',weekdays:[3]};r.store().upsertHabit(h);
  let options;r.wx.addPhoneRepeatCalendar=o=>{options=o;o.success()};const page=r.page('habits');page.render();page.addCalendar({currentTarget:{dataset:{id:'h'}}});
  assert.equal(options.repeatInterval,'day');assert.equal(options.alarm,true);assert.equal(options.alarmOffset,0);
  assert.ok(options.startTime>NOW/1000);assert.ok(options.startTime<=NOW/1000+86400);
  assert.equal(options.title,'复习');assert.equal(page.data.habits[0].calendarAdded,true);
});

test('日历取消不写入，失败不标记添加，重复添加先提示，隐私拒绝不写日历',()=>{
  const r=setup();r.getApp();const h={_id:'h',name:'复习',enabled:true,reminderTime:'12:00'};r.store().upsertHabit(h);
  let writes=0;r.wx.addPhoneRepeatCalendar=o=>{writes++;o.fail({errMsg:'auth deny'})};const page=r.page('habits');
  r.options.confirm=false;page.addCalendar({currentTarget:{dataset:{id:'h'}}});assert.equal(writes,0);
  r.options.confirm=true;page.addCalendar({currentTarget:{dataset:{id:'h'}}});assert.equal(writes,1);assert.ok(!r.store().get().phoneCalendarAdds);
  r.wx.requirePrivacyAuthorize=o=>o.fail({errMsg:'privacy deny'});page.addCalendar({currentTarget:{dataset:{id:'h'}}});assert.equal(writes,1);
  r.store().get().phoneCalendarAdds={h:{time:'12:00'}};r.options.confirm=false;page.addCalendar({currentTarget:{dataset:{id:'h'}}});
  assert.ok(r.calls.filter(c=>c.name==='modal').some(c=>c.title==='再次添加手机日历？'));assert.equal(writes,1);
});

test('日历添加不支持、无时间、停用时给出提示，重复点击不创建重复日程',()=>{
  const r=setup();r.getApp();const page=r.page('habits');r.store().upsertHabit({_id:'h',name:'复习',enabled:true,reminderTime:''});
  page.addCalendar({currentTarget:{dataset:{id:'h'}}});assert.ok(r.calls.some(c=>c.title==='请先启用提醒并设置时间'));
  r.store().upsertHabit({_id:'h',reminderTime:'12:00'});page.addCalendar({currentTarget:{dataset:{id:'h'}}});assert.ok(r.calls.some(c=>c.title==='请在手机微信中添加'));
  r.options.confirm=true;let writes=0;r.wx.addPhoneRepeatCalendar=()=>writes++;
  page.addCalendar({currentTarget:{dataset:{id:'h'}}});page.addCalendar({currentTarget:{dataset:{id:'h'}}});assert.equal(writes,1);
});

test('微信只在明确点击时请求一次订阅，接受开启渠道，离线不冒充已同步',async()=>{
  const r=setup();r.getApp();r.options.offline=true;r.store().upsertHabit({_id:'h',name:'复习',enabled:true,reminderTime:'12:00',wxReminder:false});
  const page=r.page('habits');page._templateId='tmpl';let response='reject',count=0;
  r.wx.requestSubscribeMessage=o=>{count++;assert.equal(o.tmplIds[0],'tmpl');o.complete({tmpl:response})};
  page.requestWechat({currentTarget:{dataset:{id:'h'}}});assert.equal(r.store().get().habits[0].wxReminder,false);
  response='accept';page.requestWechat({currentTarget:{dataset:{id:'h'}}});assert.equal(count,2);assert.equal(r.store().get().habits[0].wxReminder,true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(r.calls.some(c=>c.title==='订阅已允许，提醒待同步'));assert.ok(!r.calls.some(c=>c.title==='已订阅一次提醒'));assert.ok(r.store().get().queue.some(op=>op.type==='habit.save'));
});

test('模板未配置不调用订阅接口，保存习惯不自动请求授权',async()=>{
  const r=setup();r.getApp();r.options.offline=true;r.store().upsertHabit({_id:'h',name:'复习',enabled:true,reminderTime:'12:00'});
  let count=0;r.wx.requestSubscribeMessage=()=>count++;
  const page=r.page('habits');page.requestWechat({currentTarget:{dataset:{id:'h'}}});assert.equal(count,0);
  const edit=r.page('habit-edit');edit.onLoad({});edit.onName({detail:{value:'新提醒'}});edit.onTime({detail:{value:'12:00'}});edit.toggleWx();await edit.save();
  assert.equal(count,0);assert.equal(r.store().get().habits.length,2);
});

test('截图模板字段发送名称、日期时间和当天任务进度，不发送提醒文案',async()=>{
  const sessions=Array.from({length:125},(_,i)=>({_id:'s'+i,userId:'user_a',date:TODAY,status:i<80?'done':'pending'}));
  sessions.push({_id:'deleted',userId:'user_a',date:TODAY,status:'done',deleted:true},{_id:'foreign',userId:'other',date:TODAY,status:'done'});
  const r=setup({sessions,configs:[{_id:'cfg',key:'subscribe',templateId:'tmpl'}],reminders:[{_id:'r',reminderId:'h',userId:'user_a',title:'复习',enabled:true,wechatEnabled:true,time:'12:00',weekdays:[3]}]});
  const result=await r.load('cloudfunctions/scheduler/index.js').main();assert.equal(result.sent,1);
  const message=r.calls.find(c=>c.name==='subscribe');assert.equal(message.data.thing1.value,'复习');assert.equal(message.data.time5.value,TODAY+' 12:00');
  assert.equal(message.data.character_string2.value,'80/125');assert.deepEqual(Object.keys(message.data).sort(),['character_string2','thing1','time5']);
});

test('当日提醒只有指定日期发送，同星期其他日期不重复，空任务进度0/0',async()=>{
  const reminders=['2026-10-07','2026-10-14','2026-09-30'].map((date,i)=>({_id:'r'+i,reminderId:'h'+i,userId:'user_a',date,title:'一次提醒',enabled:true,wechatEnabled:true,time:'12:00',weekdays:[3]}));
  const r=setup({reminders,configs:[{_id:'cfg',key:'subscribe',templateId:'tmpl'}]});const result=await r.load('cloudfunctions/scheduler/index.js').main();
  assert.equal(result.sent,1);assert.equal(r.calls.find(c=>c.name==='subscribe').data.character_string2.value,'0/0');assert.equal(r.db.tables.dispatches.length,1);
});

test('日期详情新增提醒关联所选日期，保存后当天可见其他日期不显示',async()=>{
  const r=setup();r.getApp();const day=r.page('day');day.onLoad({date:'2026-10-08'});day.render();day.addReminder();
  assert.equal(r.calls.at(-1).url,'/pages/habit-edit/index?date=2026-10-08');
  const edit=r.page('habit-edit');edit.onLoad({date:'2026-10-08'});edit.onName({detail:{value:'考试资料检查'}});edit.onTime({detail:{value:'09:00'}});await edit.save();await r.sync().flush();
  const h=r.db.tables.habits[0];assert.equal(h.date,'2026-10-08');assert.equal(r.db.tables.reminders[0].date,'2026-10-08');
  day.render();assert.equal(day.data.habitItems.length,1);assert.equal(day.data.habitItems[0].time,'09:00');
  r.store().setPlan(plan);const home=r.page('today');home.render();assert.equal(home.data.habits.length,0);
  day.onLoad({date:'2026-10-15'});day.render();assert.equal(day.data.habitItems.length,0);
});

test('当日提醒拒绝无时间、非法及过去日期，打卡不能跨日期；刷新超过100条提醒完整返回',async()=>{
  const r=setup(),service=r.load('cloudfunctions/api/modules/habit.js');
  await assert.rejects(service.save(ctx(r,{_id:'a',name:'提醒',date:'2026-02-30',reminderTime:'09:00'})),{code:400});
  await assert.rejects(service.save(ctx(r,{_id:'a',name:'提醒',date:TODAY})),{code:400});
  await assert.rejects(service.save(ctx(r,{_id:'a',name:'提醒',date:'2026-10-06',reminderTime:'09:00'})),{code:400});
  await service.save(ctx(r,{_id:'a',name:'提醒',date:TODAY,reminderTime:'09:00'}));
  await assert.rejects(service.logStatus(ctx(r,{habitId:'a',date:'2026-10-06',status:'done'})),{code:400});
  r.db.tables.habits.push(...Array.from({length:125},(_,i)=>({_id:'more'+i,userId:'user_a',name:'提醒'})));
  assert.equal((await service.listAll(ctx(r,{}))).habits.length,126);
});

test('指定日期手机日历使用单次接口，取消后不创建每日重复',()=>{
  const r=setup();r.getApp();r.options.confirm=true;const h={_id:'h',name:'单次提醒',enabled:true,date:'2026-10-08',reminderTime:'09:00'};r.store().upsertHabit(h);
  let options;r.wx.addPhoneCalendar=o=>{options=o;o.success()};r.wx.addPhoneRepeatCalendar=()=>assert.fail('不应每日重复');
  const page=r.page('habits');page.addCalendar({currentTarget:{dataset:{id:'h'}}});
  assert.equal(options.repeatInterval,undefined);assert.equal(new Date(options.startTime*1000).getDate(),8);
});

test('头像卡片入口打开资料弹层，取消不修改昵称头像或学习数据',()=>{
  const r=setup();r.getApp();r.store().setSessions(TODAY,[{_id:'s',content:'保留任务'}]);
  const page=r.page('profile');page.render();page.openAccount();assert.equal(page.data.accountShow,true);
  page.accountName({detail:{value:'未保存'}});page.chooseAvatar({detail:{avatarUrl:'/tmp/avatar.png'}});page.closeAccount();
  assert.equal(page.data.accountShow,false);assert.ok(!r.store().get().profile.nickname);assert.equal(r.store().sessionsOf(TODAY)[0].content,'保留任务');
});

test('微信授权登录使用云端微信身份，保持原任务和考试日期，不创建重复账号',async()=>{
  const r=setup({users:[{_id:'u',openid:'user_a',openidMask:'wx_user',examDate:'2026-12-29'}]});r.getApp();
  r.store().setSessions(TODAY,[{_id:'s',content:'已有任务'}]);const page=r.page('profile');page.openAccount();await page.loginAccount();
  assert.equal(page.data.accountAuthorized,true);assert.equal(r.db.tables.users.length,1);assert.equal(r.db.tables.users[0].accountAuthorized,true);
  assert.equal(r.store().sessionsOf(TODAY).length,1);assert.equal(r.store().get().profile.examDate,'2026-12-29');
  const result=await r.load('cloudfunctions/api/index.js').main({module:'user',action:'authorize',payload:{userId:'other'}});
  assert.equal(result.code,0);assert.equal(r.db.tables.users.length,1);
});

test('头像上传后保存云文件ID和昵称，重新登录仍显示，其他用户资料不变',async()=>{
  const r=setup({users:[{_id:'u',openid:'user_a',accountAuthorized:true},{_id:'other',openid:'other',nickname:'其他用户'}]});r.getApp();
  r.store().get().profile.accountAuthorized=true;r.store().get().profile.examDate='2026-12-29';
  const page=r.page('profile');page.render();page.openAccount();page.accountName({detail:{value:'新的昵称'}});page.chooseAvatar({detail:{avatarUrl:'/tmp/selected.png'}});
  let uploads=0;r.wx.cloud.uploadFile=o=>{uploads++;assert.equal(o.filePath,'/tmp/selected.png');assert.match(o.cloudPath,/^avatars\//);o.success({fileID:'cloud://env/avatar.png'})};
  await page.saveAccount();assert.equal(uploads,1);assert.equal(page.data.avatarUrl,'cloud://env/avatar.png');assert.equal(page.data.nickname,'新的昵称');
  assert.equal(r.db.tables.users.find(u=>u._id==='other').nickname,'其他用户');assert.equal(r.store().get().profile.examDate,'2026-12-29');
  const p=await r.load('cloudfunctions/api/modules/user.js').login(ctx(r,{}));assert.equal(p.avatarUrl,'cloud://env/avatar.png');assert.equal(p.nickname,'新的昵称');
});

test('登录失败不显示已登录，上传失败保留草稿，未登录禁止保存',async()=>{
  const r=setup();r.getApp();r.options.offline=true;const page=r.page('profile');page.openAccount();await page.loginAccount();
  assert.equal(page.data.accountAuthorized,false);assert.ok(page.data.accountError);assert.equal(page.data.accountBusy,false);
  page.accountName({detail:{value:'草稿'}});await page.saveAccount();assert.match(page.data.accountError,/先点击/);
  page.setData({accountAuthorized:true});page.chooseAvatar({detail:{avatarUrl:'/tmp/selected.png'}});
  r.wx.cloud.uploadFile=o=>o.fail({errMsg:'上传失败'});await page.saveAccount();assert.equal(page.data.accountShow,true);assert.equal(page.data.accountNickname,'草稿');assert.equal(page.data.accountBusy,false);assert.ok(page.data.accountError);
});

test('资料保存重复点击仅提交一次，头像临时路径不能写入云端资料',async()=>{
  const r=setup({users:[{_id:'u',openid:'user_a',accountAuthorized:true}]});r.getApp();r.store().get().profile.accountAuthorized=true;
  const page=r.page('profile');page.render();page.openAccount();page.accountName({detail:{value:'学习者'}});page.chooseAvatar({detail:{avatarUrl:'/tmp/a.png'}});
  let finish,count=0;r.wx.cloud.uploadFile=o=>{count++;finish=()=>o.success({fileID:'cloud://env/a.png'})};
  const promise=page.saveAccount();page.saveAccount();assert.equal(count,1);finish();await promise;
  await assert.rejects(r.load('cloudfunctions/api/modules/user.js').updateProfile(ctx(r,{avatarUrl:'/tmp/avatar.png'})),{code:400});
});

test('旧云端只有user.login也能登录，不再请求未知authorize接口',async()=>{
  const r=setup();r.getApp();const actions=[];
  r.options.transport=data=>{actions.push(data.action);assert.equal(data.action,'login');return {openidMask:'wx_legacy',nickname:'旧昵称'}};
  const page=r.page('profile');page.openAccount();await page.loginAccount();
  assert.equal(page.data.accountAuthorized,false);assert.match(page.data.accountError,/重新部署api/);assert.equal(actions.length,1);
});

test('旧云端忽略头像字段时不虚报保存成功，保留草稿并提示部署api',async()=>{
  const r=setup();r.getApp();r.store().get().profile.accountAuthorized=true;
  r.options.transport=()=>({nickname:'测试',openidMask:'wx_legacy'});
  const page=r.page('profile');page.render();page.openAccount();page.accountName({detail:{value:'测试'}});page.chooseAvatar({detail:{avatarUrl:'cloud://env/avatar'}});
  await page.saveAccount();assert.equal(page.data.accountShow,true);assert.match(page.data.accountError,/重新部署api/);assert.equal(page.data.accountAvatar,'cloud://env/avatar');
  assert.ok(!r.calls.some(c=>c.title==='资料已保存'));
});

test('退出取消保留登录，确认退出隐藏资料但保留任务，启动刷新不自动恢复登录',async()=>{
  const r=setup({users:[{_id:'u',openid:'user_a',nickname:'昵称',accountAuthorized:true}]});r.getApp();
  r.store().get().profile={accountId:'u',openidMask:'wx_user_a',nickname:'昵称',avatarUrl:'cloud://env/a',accountAuthorized:true};r.store().setSessions(TODAY,[{_id:'s',content:'保留任务'}]);
  const page=r.page('profile');page.render();page.openAccount();r.options.confirm=false;page.logoutAccount();assert.equal(page.data.accountAuthorized,true);
  r.options.confirm=true;await page.logoutAccount();assert.equal(page.data.accountAuthorized,false);assert.equal(page.data.nickname,'学习者');assert.equal(page.data.avatarUrl,'');
  assert.equal(r.store().sessionsOf(TODAY).length,0);await r.getApp().login();page.render();assert.equal(page.data.accountAuthorized,false);
  page.openAccount();assert.equal(page.data.accountNickname,'');await page.loginAccount();assert.equal(page.data.accountAuthorized,true);assert.equal(page.data.nickname,'昵称');
});

test('退出隔离全部数据和未同步队列，同账号恢复，其他账号不读取旧账号备份',()=>{
  const r=setup();r.getApp();const store=r.store();store.get().profile={accountId:'a',accountAuthorized:true};
  store.setPlan(plan);store.setSessions(TODAY,[{_id:'s'}]);store.setLogs(TODAY,[{_id:'l'}]);store.upsertHabit({_id:'h'});
  store.get().queue=[{operationId:'offline',type:'log.add',payload:{clientTempId:'l',date:TODAY,content:'未同步'}}];
  store.signOut();assert.equal(store.get().plan,null);assert.equal(store.logsOf(TODAY).length,0);assert.equal(store.get().queue.length,0);
  store.applyServerBuckets({logs:{[TODAY]:[{_id:'stale'}]}});assert.equal(store.logsOf(TODAY).length,0);
  store.signIn({accountId:'b'});assert.equal(store.logsOf(TODAY).length,0);
  store.signOut();store.signIn({accountId:'a'});assert.equal(store.logsOf(TODAY)[0]._id,'l');assert.equal(store.get().queue[0].operationId,'offline');
});

test('再次登录从云端加载所有日期记录，排除已删除任务，不混入其他用户',async()=>{
  const r=setup({logs:[{_id:'past',userId:'user_a',date:'2026-09-01',durationMinutes:30},{_id:'foreign',userId:'other',date:TODAY}],
    sessions:[{_id:'deleted',userId:'user_a',date:TODAY,deleted:true},{_id:'keep',userId:'user_a',date:TODAY}]});
  r.getApp();const page=r.page('profile');page.openAccount();await page.loginAccount();
  assert.equal(r.store().logsOf('2026-09-01')[0]._id,'past');assert.equal(r.store().logsOf(TODAY).length,0);
  assert.equal(r.store().sessionsOf(TODAY).length,1);
});

test('头像选择失败给出原因，相册入口可选择并立即预览',()=>{
  const r=setup();r.getApp();const page=r.page('profile');page.openAccount();page.avatarError({detail:{errMsg:'隐私授权未通过'}});
  assert.match(page.data.accountError,/隐私/);r.wx.chooseMedia=o=>o.success({tempFiles:[{tempFilePath:'/tmp/photo.jpg'}]});
  page.chooseAvatarPhoto();assert.equal(page.data.accountAvatar,'/tmp/photo.jpg');assert.equal(page.data.accountError,'');
});

function homeWithCards() {
  const r=setup();r.getApp();
  r.store().setSessions(TODAY,[
    {_id:'done',date:TODAY,order:0,status:'done',subject:'阅读',content:'已完成任务',suggestedMinutes:30},
    {_id:'first',date:TODAY,order:1,status:'pending',subject:'听力',content:'第一项待办',suggestedMinutes:40},
    {_id:'second',date:TODAY,order:2,status:'pending',subject:'口语',content:'第二项待办',suggestedMinutes:25}
  ]);
  const page=r.page('today');page.render();return {r,page}
}

test('日历全量展示当天任务、记录和习惯，完成统计不截断',()=>{
  const r=setup();r.getApp();const store=r.store();
  store.setSessions(TODAY,Array.from({length:25},(_,i)=>({_id:'s'+i,date:TODAY,order:24-i,content:'任务'+i,subject:'阅读',status:i<10?'done':'pending',suggestedMinutes:30})));
  store.setLogs(TODAY,Array.from({length:15},(_,i)=>({_id:'l'+i,date:TODAY,content:'记录'+i,durationMinutes:'20',note:'完整笔记',nextTip:'提醒'})));
  store.upsertHabit({_id:'h',name:'复习',enabled:true,weekdays:[3]});store.setHabitLog(TODAY,'h','done');
  store.upsertHabit({_id:'disabled',name:'停用',enabled:false});store.upsertHabit({_id:'other',name:'周四',enabled:true,weekdays:[4]});
  const page=r.page('calendar');page.setData({ym:'2026-10'});page.render();
  assert.equal(page.data.todayTasks.length,25);assert.equal(page.data.todayTasks[0]._id,'s24');assert.equal(page.data.todayDoneCount,10);
  assert.equal(page.data.todayLogs.length,15);assert.equal(page.data.todayLogs[0]._id,'l14');assert.equal(page.data.todayLogs[0].note,'完整笔记');assert.equal(page.data.todayMinutes,300);
  assert.equal(page.data.todayHabits.length,1);assert.equal(page.data.todayHabits[0].statusText,'已完成');
  page.tapToday();assert.equal(r.calls.at(-1).url,'/pages/day/index?date='+TODAY);
  page.setData({ym:'2026-09'});page.render();assert.equal(page.data.todayRow,null);assert.equal(page.data.todayTasks.length,0);assert.equal(page.data.todayLogs.length,0);
});

test('日历空列表及离线刷新保留当天完整内容',async()=>{
  const r=setup();r.getApp();const page=r.page('calendar');page.setData({ym:'2026-10'});page.render();
  assert.equal(page.data.todayTasks.length,0);assert.equal(page.data.todayMinutes,0);assert.equal(page.data.todayHabits.length,0);
  r.store().setSessions(TODAY,[{_id:'local',date:TODAY,content:'离线任务',status:'pending',order:0}]);r.options.offline=true;
  await page.refresh('2026-10');assert.equal(page.data.todayTasks[0].content,'离线任务');
});

test('日历刷新同步服务端任务、学习记录和习惯定义',async()=>{
  const r=setup({sessions:[{_id:'remote',userId:'user_a',date:TODAY,content:'同步任务',status:'done',order:0}],
    logs:[{_id:'log',userId:'user_a',date:TODAY,content:'同步记录',durationMinutes:45}],
    habits:[{_id:'habit',userId:'user_a',name:'新习惯',enabled:true,weekdays:[3]}]});
  r.getApp();const page=r.page('calendar');page.setData({ym:'2026-10'});await page.refresh('2026-10');
  assert.equal(page.data.todayTasks[0].content,'同步任务');assert.equal(page.data.todayDoneCount,1);assert.equal(page.data.todayMinutes,45);assert.equal(page.data.todayHabits[0].name,'新习惯');
});

test('今日学习卡片默认第一项未完成任务，左右切换后专注和记录关联所选任务',()=>{
  const {r,page}=homeWithCards();assert.equal(page.data.studyCards.length,3);assert.equal(page.data.taskIndex,1);
  page.onTaskChange({detail:{source:'touch',current:2}});assert.equal(page.data.task._id,'second');
  assert.equal(page.data.task.suggestedMinutes,25);
  page.startFocus();assert.match(r.calls.at(-1).url,/sessionId=second$/);
  page.quickLog();assert.match(r.calls.at(-1).url,/sessionId=second$/);
  const log=r.page('log-edit');log.onLoad({date:TODAY,sessionId:'second'});assert.equal(log.data.content,'第二项待办');
  page.onTaskChange({detail:{source:'touch',current:1}});page.startFocus();assert.match(r.calls.at(-1).url,/sessionId=first$/);
});

test('同步刷新、排序和编辑内容后保留所选卡片，删除所选任务后安全回退',()=>{
  const {r,page}=homeWithCards();page.onTaskChange({detail:{source:'touch',current:2}});
  const list=r.store().sessionsOf(TODAY);list.find(s=>s._id==='second').order=-1;list.find(s=>s._id==='second').content='新的任务名称';
  page.render();assert.equal(page.data.task._id,'second');assert.equal(page.data.taskIndex,0);assert.match(page.data.task.title,/新的任务名称/);
  r.store().setSessions(TODAY,list.filter(s=>s._id!=='second'));page.render();assert.equal(page.data.task._id,'first');assert.equal(page.data.taskIndex,1);
  r.store().setSessions(TODAY,[]);page.render();assert.equal(page.data.task,null);assert.equal(page.data.studyCards.length,0);
});

test('已完成卡片能查看记录，不能误进入专注；程序切换不覆盖所选任务',()=>{
  const {r,page}=homeWithCards();page.onTaskChange({detail:{source:'',current:0}});assert.equal(page.data.task._id,'first');
  page.onTaskChange({detail:{source:'touch',current:0}});assert.equal(page.data.task.status,'done');
  page.startFocus();assert.equal(r.calls.at(-1).url,'/pages/task-records/index?date='+TODAY+'&sessionId=done');
  page.quickLog({currentTarget:{dataset:{id:'done'}}});assert.match(r.calls.at(-1).url,/sessionId=done$/);
  page.onTaskChange({detail:{source:'touch',current:99}});assert.equal(page.data.task._id,'done');
});

test('卡片按钮使用该卡片ID，动画或旧页面状态不会启动另一任务',()=>{
  const {r,page}=homeWithCards();page.startFocus({currentTarget:{dataset:{id:'second'}}});assert.match(r.calls.at(-1).url,/sessionId=second$/);
  page.quickLog({currentTarget:{dataset:{id:'second'}}});assert.match(r.calls.at(-1).url,/sessionId=second$/);
  const before=r.calls.filter(x=>x.name==='navigateTo').length;
  r.store().setSessions(TODAY,r.store().sessionsOf(TODAY).filter(s=>s._id!=='second'));
  page.quickLog({currentTarget:{dataset:{id:'second'}}});page.startFocus({currentTarget:{dataset:{id:'second'}}});
  assert.equal(r.calls.filter(x=>x.name==='navigateTo').length,before);
});

test('单任务、全部完成和空任务状态正常，日期切换重置选择',()=>{
  let now=NOW;const r=runtime({now:NOW,clock:()=>now});r.getApp();const page=r.page('today');
  r.store().setSessions(TODAY,[{_id:'one',date:TODAY,order:0,status:'done',subject:'阅读',content:'完成'}]);
  page.render();assert.equal(page.data.taskIndex,0);assert.equal(page.data.taskDone,true);assert.equal(page.data.studyCards.length,1);
  now+=86400000;r.store().setSessions('2026-10-08',[
    {_id:'one',date:'2026-10-08',order:0,status:'done',subject:'阅读'},
    {_id:'next',date:'2026-10-08',order:1,status:'pending',subject:'听力'}
  ]);
  page.render();assert.equal(page.data.task._id,'next');assert.equal(page.data.taskDone,false);
  r.store().setSessions('2026-10-08',[]);page.render();assert.equal(page.data.task,null);assert.equal(page.data.total,0);
});

test('卡片高度按最长内容测量，避免滑动后长名称和操作按钮被裁切',()=>{
  const {r,page}=homeWithCards();let rects=[{height:380},{height:490},{height:420}];
  const query={in(){return this},selectAll(){return this},boundingClientRect(cb){this.callback=cb;return this},exec(){this.callback(rects)}};
  r.wx.createSelectorQuery=()=>query;r.wx.nextTick=callback=>callback();page.measureStudyCards();
  assert.equal(page.data.swiperHeight,490);rects=[{height:380}];page.measureStudyCards();assert.equal(page.data.swiperHeight,380);
});

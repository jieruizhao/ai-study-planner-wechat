const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '..')
const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x))
function database(seed = {}) {
  const tables = clone(seed), faults = [], calls = []
  let transactionChain=Promise.resolve()
  let id = 0
  const testOp = (fn) => ({ match: fn, and(other) { return testOp(x => fn(x) && other.match(x)) } })
  const command = { gte: v => testOp(x => x >= v), lte: v => testOp(x => x <= v),
    gt: v => testOp(x => x > v), lt: v => testOp(x => x < v), neq: v => testOp(x => x !== v),
    in: v => testOp(x => v.includes(x)), eq: v => testOp(x => x === v) }
  const matches = (row, where) => Object.entries(where).every(([k, v]) => v && typeof v.match === 'function' ? v.match(row[k]) : row[k] === v)
  function guard(name, op) {
    calls.push({name, op})
    const f = faults.find(x => x.name === name && x.op === op)
    if (f && --f.after <= 0) { faults.splice(faults.indexOf(f), 1); throw new Error('injected ' + name + '.' + op) }
  }
  function query(name, where = {}, orders = [], offset = 0, limit = 100) {
    if (!tables[name]) tables[name] = []
    const rows = () => {
      let list = tables[name].filter(row => matches(row, where))
      if (orders.length) list.sort((a,b) => { for(const [key,dir] of orders) { if(a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (dir === 'desc' ? -1 : 1) } return 0 })
      return list
    }
    return {
      where: value => query(name, Object.assign({},where,value), orders, offset, limit),
      orderBy: (key, dir) => query(name,where,orders.concat([[key,dir]]),offset,limit),
      limit: n => query(name,where,orders,offset,Math.min(n,100)),
      skip: n => query(name,where,orders,n,limit),
      get: async () => { guard(name,'get'); return {data:clone(rows().slice(offset,offset+limit))} },
      count: async () => ({total:rows().length}),
      update: async ({data}) => { guard(name,'update'); const list=rows(); list.forEach(row=>Object.assign(row,clone(data)));return {stats:{updated:list.length}} },
      remove: async () => { guard(name,'remove'); const list=rows();tables[name]=tables[name].filter(x=>!list.includes(x));return {stats:{removed:list.length}} },
      add: async ({data}) => {
        guard(name,'add'); const docs=Array.isArray(data)?data:[data], ids=[]
        for(const doc of docs) { const row=clone(doc); row._id=row._id || 'mock_'+(++id);if(tables[name].some(x=>x._id===row._id))throw new Error('duplicate _id');tables[name].push(row);ids.push(row._id) }
        return {_id:ids[0],_ids:ids}
      },
      doc: docId => ({
        get: async (options={}) => { guard(name,'get'); const row=tables[name].find(x=>x._id===docId);if(!row&&options.throwOnNotFound!==false)throw new Error('document not found');return {data:clone(row)||null} },
        update: async ({data}) => { guard(name,'update');const row=tables[name].find(x=>x._id===docId);if(!row)throw new Error('document not found');Object.assign(row,clone(data));return {stats:{updated:1}} },
        set: async ({data}) => { guard(name,'set');const row=Object.assign({},clone(data),{_id:docId});const n=tables[name].findIndex(x=>x._id===docId);if(n<0)tables[name].push(row);else tables[name][n]=row;return {_id:docId} },
        remove: async () => { guard(name,'remove');const n=tables[name].length;tables[name]=tables[name].filter(x=>x._id!==docId);return {stats:{removed:n-tables[name].length}} }
      })
    }
  }
  return {tables, calls, command, collection: query, serverDate:()=>new Date().toISOString(), createCollection:async name=>{if(!tables[name])tables[name]=[]},
    runTransaction(fn){const next=transactionChain.then(async()=>{
      const touched=new Map()
      const collection=name=>({doc:id=>{const ref=query(name).doc(id);const capture=()=>{const key=name+':'+id;if(!touched.has(key))touched.set(key,{name,id,before:clone(tables[name].find(x=>x._id===id))})};return {get:ref.get,set:args=>{capture();return ref.set(args)},update:args=>{capture();return ref.update(args)},remove:()=>{capture();return ref.remove()}}}})
      try{return await fn({collection})}catch(e){for(const row of touched.values()){tables[row.name]=tables[row.name].filter(x=>x._id!==row.id);if(row.before)tables[row.name].push(row.before)}throw e}
    });transactionChain=next.catch(()=>{});return next},
    fail(name,op,after=1){faults.push({name,op,after})}}
}
function context(db,payload={},OPENID='user_a',today='2026-09-30') {return {db,_:db.command,payload,OPENID,bizToday:()=>today}}
function runtime(options={}) {
  const memory={}, calls=[], pages=[], cache=new Map(), db=options.db || database()
  const now=options.now || Date.now()
  const currentTime = () => options.clock ? options.clock() : now
  class Clock extends Date {constructor(...a){super(...(a.length?a:[currentTime()]))} static now(){return currentTime()}}
  const wx={getStorageSync:key=>clone(memory[key]),setStorageSync:(key,value)=>{memory[key]=clone(value)},
    getWindowInfo:()=>({statusBarHeight:24}),getAccountInfoSync:()=>({miniProgram:{envVersion:'release'}}),
    getFileSystemManager:()=>({access:()=>{}}), setTabBarStyle:()=>{},setTabBarItem:()=>{},
    onNetworkStatusChange:cb=>{wx.networkChange=cb},
    showToast:value=>{calls.push({name:'toast',...value})},showLoading:()=>{},hideLoading:()=>{},
    showModal:value=>{calls.push({name:'modal',...value});if(options.confirm!==undefined&&value.success)return value.success({confirm:options.confirm})},
    navigateTo:value=>{calls.push({name:'navigateTo',...value})},redirectTo:value=>{calls.push({name:'redirectTo',...value})},
    navigateBack:value=>{calls.push({name:'navigateBack',...value})},switchTab:()=>{},setClipboardData:()=>{},
    cloud:{init:()=>{},callFunction:({data,success,fail})=>Promise.resolve().then(()=> {
      if(options.offline) throw new Error('offline')
      if(options.transport)return options.transport(data)
      const mod=load(path.join(root,'cloudfunctions/api/modules',data.module+'.js'))
      return mod[data.action](context(db,data.payload,options.openid || 'user_a',new Clock().toISOString().slice(0,10)))
    }).then(data=>success({result:{code:0,data}}),e=>e.biz?success({result:{code:e.code,msg:e.message,data:e.data}}):fail({errMsg:e.message}))}}
  const cloud={init:()=>{},DYNAMIC_CURRENT_ENV:'test',database:()=>db,getWXContext:()=>({OPENID:options.openid || 'user_a'}),openapi:{subscribeMessage:{send:async msg=>{calls.push({name:'subscribe',...msg});if(options.sendError)throw options.sendError;return options.sendResult || {errCode:0}}}}}
  let app
  const sandbox=vm.createContext({console: options.console || {log(){},warn(){},error(){},table(){}}, Date:Clock,Buffer,Set,Map,URL,Promise,
    wx,setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1,clearInterval:()=>{},
    App:value=>{app=value},Page:value=>{sandbox.lastPage=value},getApp:()=>app,getCurrentPages:()=>pages})
  function load(file) {
    if(!path.isAbsolute(file))file=path.join(root,file)
    if(!path.extname(file))file+='.js'
    if(cache.has(file))return cache.get(file).exports
    const mod={exports:{}};cache.set(file,mod)
    const req=name=> name==='wx-server-sdk'?cloud: name.startsWith('.')?load(path.resolve(path.dirname(file),name)):require(name)
    const fn=vm.runInContext('(function(require,module,exports){\n'+fs.readFileSync(file,'utf8')+'\n})',sandbox,{filename:file})
    fn(req,mod,mod.exports);return mod.exports
  }
  function page(name) {
    load('miniprogram/pages/'+name+'/index.js');const value=sandbox.lastPage
    value.data=clone(value.data);value.setData=patch=>{for(const [key,v] of Object.entries(patch)){const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');let obj=value.data;for(const p of parts.slice(0,-1))obj=obj[p];obj[parts.at(-1)]=v}}
    pages.push(value);return value
  }
  function getApp(){if(!app)load('miniprogram/app.js');return app}
  return {load,page,getApp,wx,calls,db,memory,options,store:()=>load('miniprogram/utils/store.js'),sync:()=>load('miniprogram/utils/sync.js')}
}
module.exports={database,context,runtime,clone,root}

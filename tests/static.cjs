const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict')
const {root,runtime}=require('./helpers.cjs')
const list=[]
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())walk(p);else list.push(p)}}
walk(path.join(root,'miniprogram'));walk(path.join(root,'cloudfunctions'))
const counts={javascript:0,json:0,pages:0,handlers:0,icons:0}
for(const p of list){if(p.endsWith('.js')){new vm.Script(fs.readFileSync(p,'utf8'),{filename:p});counts.javascript++}else if(p.endsWith('.json')){JSON.parse(fs.readFileSync(p,'utf8'));counts.json++}}
for(const name of ['project.config.json','project.private.config.json']){if(name==='project.private.config.json'&&!fs.existsSync(path.join(root,name)))continue;JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));counts.json++}
const app=JSON.parse(fs.readFileSync(path.join(root,'miniprogram/app.json'),'utf8'))
for(const route of app.pages){for(const ext of ['js','json','wxml','wxss'])assert.ok(fs.existsSync(path.join(root,'miniprogram',route+'.'+ext)),route+'.'+ext)
 const r=runtime();r.getApp();const page=r.page(route.split('/')[1]);const source=fs.readFileSync(path.join(root,'miniprogram',route+'.wxml'),'utf8')
 for(const m of source.matchAll(/\b(?:bind|catch)(?::)?[a-z]+="([A-Za-z_$][\w$]*)"/g)){assert.equal(typeof page[m[1]],'function',route+': '+m[1]);counts.handlers++}
 for(const m of source.matchAll(/\{\{([\s\S]*?)\}\}/g))assert.ok(!/\.\w+\s*\(/.test(m[1]),route+': WXML method call '+m[1])
 counts.pages++
}
for(const tab of app.tabBar.list){for(const p of [tab.iconPath,tab.selectedIconPath,tab.iconPath.replace('icons/','icons/dark/'),tab.selectedIconPath.replace('icons/','icons/dark/')]){assert.ok(fs.existsSync(path.join(root,'miniprogram',p)),p);counts.icons++}}
console.log(JSON.stringify({ok:true,...counts},null,2))

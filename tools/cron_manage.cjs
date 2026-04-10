const __ROOT = require('path').resolve(__dirname, '..')
const fs=require('fs'),{execSync}=require('child_process'),crypto=require('crypto')
const TF=__ROOT + '/workspace/scheduled_tasks.json'
const RN=__ROOT + '/tools/cron_runner.cjs'
function read(){try{return JSON.parse(fs.readFileSync(TF,'utf-8')).tasks||[]}catch{return[]}}
function write(t){fs.writeFileSync(TF,JSON.stringify({tasks:t},null,2))}
function addCron(expr,id){
  const cmd=`${expr} cd ${__ROOT} && /usr/local/bin/node tools/cron_runner.cjs "${id}" >> logs/cron.log 2>&1`
  try{const e=execSync('crontab -l 2>/dev/null').toString();if(!e.includes(id))execSync(`(crontab -l 2>/dev/null;echo '${cmd}')|crontab -`)}
  catch{execSync(`echo '${cmd}'|crontab -`)}
}
function rmCron(id){try{execSync(`crontab -l 2>/dev/null|grep -v "${id}"|crontab -`)}catch{}}
const a=process.argv[2]
if(a==='add'){
  const[,,, cron,prompt,name,uid,rec]=process.argv
  if(!cron||!prompt){console.error('用法: add "cron" "prompt" "name" "userId" [true/false]');process.exit(1)}
  const id=crypto.randomUUID().slice(0,8)
  const task={id,cron,prompt,name:name||'',userId:uid||'',recurring:rec!=='false',createdAt:Date.now()}
  const tasks=read();tasks.push(task);write(tasks);addCron(cron,id)
  const DN=['日','一','二','三','四','五','六'],p=cron.split(' ')
  let sch=cron
  if(p[2]==='*'&&p[3]==='*'&&p[4]==='*')sch=`每天 ${p[1]}:${p[0].padStart(2,'0')}`
  else if(p[2]==='*'&&p[3]==='*')sch=`每周${p[4].split(',').map(d=>DN[+d]||d).join(',')} ${p[1]}:${p[0].padStart(2,'0')}`
  console.log(`✅ 任务已创建\n  ID: ${id}\n  名称: ${name||'未命名'}\n  时间: ${sch}\n  类型: ${task.recurring?'重复':'一次性'}\n  内容: ${prompt.slice(0,60)}`)
}else if(a==='list'){
  const t=read();if(!t.length){console.log('当前没有定时任务');return}
  console.log(`共 ${t.length} 个任务:\n`)
  for(const x of t){
    console.log(`[${x.id}] ${x.name||'未命名'}\n  ${x.cron} | ${x.recurring?'重复':'一次性'} | 创建: ${new Date(x.createdAt).toLocaleString('zh-CN')}\n  上次: ${x.lastFiredAt?new Date(x.lastFiredAt).toLocaleString('zh-CN'):'未执行'}\n  ${x.prompt.slice(0,80)}\n`)
  }
}else if(a==='delete'){
  const id=process.argv[3];if(!id){console.error('用法: delete "taskId"');process.exit(1)}
  const t=read(),r=t.filter(x=>x.id!==id)
  if(r.length===t.length)console.log(`任务 ${id} 不存在`)
  else{write(r);rmCron(id);console.log(`✅ 已删除 ${id}`)}
}else console.log('用法: add|list|delete')

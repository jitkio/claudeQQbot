const __ROOT = require('path').resolve(__dirname, '..')
const {chromium}=require('playwright')
// 预留：浏览器自动化交互工具
// 用法: node web_interact.cjs '{"url":"...", "actions":[{"type":"click","selector":"..."}, {"type":"type","selector":"...","text":"..."}]}'
const input=process.argv[2]
if(!input){console.error('用法: node web_interact.cjs \'{"url":"...", "actions":[...]}\'');process.exit(1)}
;(async()=>{
  const cfg=JSON.parse(input)
  const b=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium-browser',args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']})
  const c=await b.newContext({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'})
  const p=await c.newPage()
  try{
    await p.goto(cfg.url,{waitUntil:'domcontentloaded',timeout:20000})
    for(const act of cfg.actions||[]){
      if(act.type==='click') await p.click(act.selector)
      if(act.type==='type') await p.fill(act.selector,act.text)
      if(act.type==='wait') await p.waitForTimeout(act.ms||1000)
      if(act.type==='screenshot'){
        await p.screenshot({path:act.path||__ROOT + '/workspace/output/interact.png'})
        console.log('截图:',act.path)
      }
    }
    const text=await p.evaluate(()=>document.body.innerText.slice(0,5000))
    console.log(text)
  }catch(e){console.error('交互失败:',e.message)}
  await b.close()
})()

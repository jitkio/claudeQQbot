const {chromium}=require('playwright')
const qs=process.argv.slice(2)
if(!qs.length){console.error('用法: node multi_search.cjs "词1" "词2"');process.exit(1)}
;(async()=>{
  const b=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium-browser',args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']})
  const r=await Promise.all(qs.map(async q=>{
    const c=await b.newContext({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'})
    const p=await c.newPage()
    try{
      await p.goto(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-Hans`,{waitUntil:'domcontentloaded',timeout:15000})
      await p.waitForTimeout(2000)
      const items=await p.evaluate(()=>Array.from(document.querySelectorAll('.b_algo')).slice(0,5).map(el=>{
        const t=el.querySelector('h2')?.innerText||'',l=el.querySelector('a')?.href||'',s=el.querySelector('.b_caption p,.b_lineclamp2')?.innerText||''
        return`- **${t}** (${l})\n  ${s}`}).join('\n'))
      return`## 搜索: ${q}\n${items||'无结果'}`
    }catch(e){return`## 搜索: ${q}\n失败: ${e.message}`}
    finally{await c.close()}
  }))
  console.log(r.join('\n\n'))
  await b.close()
})()

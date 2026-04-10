const {chromium}=require('playwright')
const q=process.argv[2]
if(!q){console.error('用法: node web_search.cjs "关键词"');process.exit(1)}
;(async()=>{
  const b=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium-browser',args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']})
  const p=await b.newPage()
  await p.setExtraHTTPHeaders({'Accept-Language':'zh-CN,zh;q=0.9'})
  try{
    await p.goto(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-Hans`,{waitUntil:'domcontentloaded',timeout:15000})
    await p.waitForTimeout(2000)
    const r=await p.evaluate(()=>Array.from(document.querySelectorAll('.b_algo')).slice(0,8).map(el=>{
      const t=el.querySelector('h2')?.innerText||'',l=el.querySelector('a')?.href||'',s=el.querySelector('.b_caption p,.b_lineclamp2')?.innerText||''
      return`### ${t}\n${l}\n${s}`}).join('\n\n'))
    console.log(r||'未找到结果')
  }catch(e){console.error('搜索失败:',e.message)}
  await b.close()
})()

const {chromium}=require('playwright')
const url=process.argv[2],maxLen=parseInt(process.argv[3]||'10000')
if(!url){console.error('用法: node web_fetch.cjs "URL" [maxLen]');process.exit(1)}
;(async()=>{
  const b=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium-browser',args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']})
  const c=await b.newContext({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'})
  const p=await c.newPage()
  try{
    await p.goto(url,{waitUntil:'domcontentloaded',timeout:20000})
    await p.waitForTimeout(2000)
    const t=await p.evaluate((ml)=>{
      document.querySelectorAll('script,style,nav,footer,header,iframe,aside,.ad,.ads').forEach(e=>e.remove())
      return document.body.innerText.slice(0,ml)
    },maxLen)
    console.log(t||'页面为空')
  }catch(e){console.error('抓取失败:',e.message)}
  await b.close()
})()

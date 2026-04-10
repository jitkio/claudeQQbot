const __ROOT = require('path').resolve(__dirname, '..')
const {chromium}=require('playwright'),path=require('path')
const url=process.argv[2],out=process.argv[3]||__ROOT + '/workspace/output/screenshot.png'
if(!url){console.error('用法: node web_screenshot.cjs "URL" [输出路径]');process.exit(1)}
;(async()=>{
  const b=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium-browser',args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']})
  const p=await b.newPage()
  await p.setViewportSize({width:1280,height:800})
  try{
    await p.goto(url,{waitUntil:'domcontentloaded',timeout:20000})
    await p.waitForTimeout(2000)
    await p.screenshot({path:out,fullPage:false})
    console.log(`截图已保存: ${out}`)
  }catch(e){console.error('截图失败:',e.message)}
  await b.close()
})()

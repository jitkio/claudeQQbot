const __ROOT = require('path').resolve(__dirname, '..')
// 图片处理工具
// 用法:
//   node image_process.cjs info "/path/to/image"
//   node image_process.cjs resize "/path/to/image" 800 600 "/output/path"
//   node image_process.cjs convert "/path/to/image" png "/output/path"
//   node image_process.cjs compress "/path/to/image" 80 "/output/path"
const { execSync } = require('child_process')
const path = require('path')

const action = process.argv[2]
const input = process.argv[3]
if (!action || !input) {
  console.error('用法: node image_process.cjs info|resize|convert|compress "路径" [参数...]')
  process.exit(1)
}

const outDir = __ROOT + '/workspace/output'

try {
  if (action === 'info') {
    // 获取图片信息
    const info = execSync(`ffprobe -v quiet -show_entries stream=width,height,codec_name -of json "${input}" 2>/dev/null`).toString()
    const data = JSON.parse(info)
    const stream = data.streams?.[0]
    if (stream) {
      console.log(`格式: ${stream.codec_name}`)
      console.log(`尺寸: ${stream.width}x${stream.height}`)
    }
    const size = execSync(`stat -c%s "${input}"`).toString().trim()
    console.log(`大小: ${(parseInt(size)/1024).toFixed(1)}KB`)

  } else if (action === 'resize') {
    const w = process.argv[4] || '800'
    const h = process.argv[5] || '-1'  // -1 = 保持比例
    const out = process.argv[6] || `${outDir}/resized_${path.basename(input)}`
    execSync(`ffmpeg -y -i "${input}" -vf "scale=${w}:${h}" "${out}" 2>/dev/null`)
    console.log(`已缩放: ${out}`)

  } else if (action === 'convert') {
    const fmt = process.argv[4] || 'png'
    const out = process.argv[5] || `${outDir}/${path.basename(input, path.extname(input))}.${fmt}`
    execSync(`ffmpeg -y -i "${input}" "${out}" 2>/dev/null`)
    console.log(`已转换: ${out}`)

  } else if (action === 'compress') {
    const quality = process.argv[4] || '80'
    const out = process.argv[5] || `${outDir}/compressed_${path.basename(input)}`
    execSync(`ffmpeg -y -i "${input}" -q:v ${Math.max(1, Math.round((100 - parseInt(quality)) / 3))} "${out}" 2>/dev/null`)
    console.log(`已压缩: ${out}`)

  } else {
    console.error('未知操作:', action)
  }
} catch (e) {
  console.error('图片处理失败:', e.message)
}

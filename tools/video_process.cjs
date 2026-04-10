const __ROOT = require('path').resolve(__dirname, '..')
// 视频处理：抽帧 + 提取音频
// 用法: node video_process.cjs "/path/to/video.mp4" [帧数: 默认5]
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const input = process.argv[2]
const frameCount = parseInt(process.argv[3] || '5')
if (!input) { console.error('用法: node video_process.cjs "视频路径" [帧数]'); process.exit(1) }

const baseName = path.basename(input, path.extname(input))
const outDir = __ROOT + '/workspace/output'
const framesDir = `${outDir}/${baseName}_frames`

try {
  fs.mkdirSync(framesDir, { recursive: true })

  // 获取视频时长
  const duration = parseFloat(
    execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${input}" 2>/dev/null`).toString().trim()
  )
  console.log(`视频时长: ${duration.toFixed(1)}秒`)

  // 均匀抽帧
  const interval = duration / (frameCount + 1)
  for (let i = 1; i <= frameCount; i++) {
    const ts = (interval * i).toFixed(2)
    const outFrame = `${framesDir}/frame_${String(i).padStart(2, '0')}.jpg`
    execSync(`ffmpeg -y -ss ${ts} -i "${input}" -vframes 1 -q:v 2 "${outFrame}" 2>/dev/null`)
  }
  console.log(`已抽取 ${frameCount} 帧到: ${framesDir}/`)

  // 提取音频
  const audioPath = `${outDir}/${baseName}_audio.wav`
  try {
    execSync(`ffmpeg -y -i "${input}" -vn -ar 16000 -ac 1 "${audioPath}" 2>/dev/null`)
    console.log(`音频已提取: ${audioPath}`)
  } catch {
    console.log('视频无音频轨道')
  }

  // 输出文件列表
  const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg'))
  console.log(`\n可用文件:`)
  for (const f of frames) console.log(`  ${framesDir}/${f}`)
  if (fs.existsSync(audioPath)) console.log(`  ${audioPath}`)

} catch (e) {
  console.error('视频处理失败:', e.message)
}

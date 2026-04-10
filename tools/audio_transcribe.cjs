const __ROOT = require('path').resolve(__dirname, '..')
// 音频转文字
// 用法: node audio_transcribe.cjs "/path/to/audio.silk" [输出格式: text|srt]
// QQ 语音是 silk 格式，先转 wav 再用 Claude 分析
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const input = process.argv[2]
if (!input) { console.error('用法: node audio_transcribe.cjs "音频路径"'); process.exit(1) }

const ext = path.extname(input).toLowerCase()
const baseName = path.basename(input, ext)
const outDir = __ROOT + '/workspace/uploads'
const wavPath = `${outDir}/${baseName}.wav`

try {
  // silk/amr/mp3/ogg → wav
  if (ext === '.silk' || ext === '.slk') {
    // silk 需要特殊处理，先尝试 ffmpeg
    try {
      execSync(`ffmpeg -y -i "${input}" -ar 16000 -ac 1 "${wavPath}" 2>/dev/null`)
    } catch {
      // silk 可能需要先转 pcm
      console.log('silk 格式转换失败，尝试直接作为 amr 处理...')
      execSync(`ffmpeg -y -f amr -i "${input}" -ar 16000 -ac 1 "${wavPath}" 2>/dev/null`)
    }
  } else {
    execSync(`ffmpeg -y -i "${input}" -ar 16000 -ac 1 "${wavPath}" 2>/dev/null`)
  }

  // 获取音频时长
  const duration = execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${wavPath}" 2>/dev/null`).toString().trim()
  console.log(`音频已转换: ${wavPath}`)
  console.log(`时长: ${parseFloat(duration).toFixed(1)}秒`)
  console.log(`请使用 Claude 的 Read 工具读取此文件进行语音识别分析`)

} catch (e) {
  console.error('音频处理失败:', e.message)
  console.log('原始文件:', input)
}

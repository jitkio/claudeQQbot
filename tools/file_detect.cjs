// 文件类型检测
// 用法: node file_detect.cjs "/path/to/file"
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const input = process.argv[2]
if (!input) { console.error('用法: node file_detect.cjs "文件路径"'); process.exit(1) }

const ext = path.extname(input).toLowerCase()
const stat = fs.statSync(input)

const IMAGE_EXTS = ['.jpg','.jpeg','.png','.gif','.webp','.bmp','.svg','.ico']
const AUDIO_EXTS = ['.mp3','.wav','.ogg','.flac','.aac','.m4a','.wma','.silk','.slk','.amr']
const VIDEO_EXTS = ['.mp4','.avi','.mkv','.mov','.wmv','.flv','.webm']
const DOC_EXTS = ['.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.txt','.md','.csv','.json']
const CODE_EXTS = ['.js','.ts','.py','.java','.c','.cpp','.go','.rs','.rb','.php','.html','.css','.sh']

let type = 'unknown'
if (IMAGE_EXTS.includes(ext)) type = 'image'
else if (AUDIO_EXTS.includes(ext)) type = 'audio'
else if (VIDEO_EXTS.includes(ext)) type = 'video'
else if (DOC_EXTS.includes(ext)) type = 'document'
else if (CODE_EXTS.includes(ext)) type = 'code'
else {
  // 用 file 命令检测
  try {
    const mime = execSync(`file --mime-type -b "${input}" 2>/dev/null`).toString().trim()
    if (mime.startsWith('image/')) type = 'image'
    else if (mime.startsWith('audio/')) type = 'audio'
    else if (mime.startsWith('video/')) type = 'video'
    else if (mime.startsWith('text/')) type = 'text'
    else type = mime
  } catch {}
}

console.log(JSON.stringify({
  path: input,
  type,
  ext,
  size: stat.size,
  sizeHuman: stat.size > 1024*1024 ? `${(stat.size/1024/1024).toFixed(1)}MB` : `${(stat.size/1024).toFixed(1)}KB`,
  modified: stat.mtime.toISOString(),
}))

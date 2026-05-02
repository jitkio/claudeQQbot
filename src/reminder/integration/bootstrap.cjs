/**
 * 集成入口：懒注入版
 *
 * 区别于上版：startHttpServer 不再要求调用方立刻传 sendC2CMessage。
 * qqbot 可以先启动 HTTP server（占坑），之后随时 setSender() 注入。
 * 这样避免在 index.ts 顶层用 await import。
 */
const { startHttpServer, stopHttpServer, setSender } = require('./qqHttpServer.cjs')
const { isReminderCommand, handleCommand } = require('./commandHandler.cjs')

module.exports = {
  startHttpServer,
  stopHttpServer,
  setSender,            // <-- 新增
  isReminderCommand,
  handleCommand,
}

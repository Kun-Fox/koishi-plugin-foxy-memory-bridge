'use strict'

const { Schema } = require('koishi')
const { createHandlers } = require('./handlers')

const Config = Schema.object({
  path: Schema.string()
    .default('/foxy-memory')
    .description('HTTP 路由前缀。DSH 端 `bridgeUrl` 填到此前缀为止。'),
  token: Schema.string()
    .role('secret')
    .default('')
    .description('Bearer token。留空时只允许本机回环地址访问；公网部署必须设置。'),
  presetId: Schema.string()
    .default('foxy3（Character）')
    .description('写入/读取的 LivingMemory preset。'),
  platform: Schema.string()
    .default('dsh')
    .description('speakerKey 的平台名，默认 dsh。'),
  userId: Schema.string()
    .default('2242711967')
    .description('DSH 侧人类用户 ID；默认 kunfox 的 QQ 号。'),
  userLabel: Schema.string()
    .default('kunfox')
    .description('人类用户在记忆中的显示名。'),
  assistantId: Schema.string()
    .default('2877932816')
    .description('Foxy 的 ID；默认 QQ 机器人账号。'),
  assistantLabel: Schema.string()
    .default('Foxy')
    .description('Foxy 在记忆中的显示名。'),
  conversationPrefix: Schema.string()
    .default('dsh:')
    .description('DSH 会话 ID 前缀，用于生成 LivingMemory conversationId。'),
  maxContext: Schema.number()
    .min(1)
    .max(100)
    .default(20)
    .description('一次召回最多返回多少条记忆。'),
})

function isLoopback(ctx) {
  const address = ctx?.request?.socket?.remoteAddress || ctx?.socket?.remoteAddress || ''
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

function isAuthorized(ctx, token) {
  if (!token) return isLoopback(ctx)
  const header = String(ctx?.headers?.authorization || ctx?.headers?.['x-foxy-token'] || '')
  return header === `Bearer ${token}` || header === token
}

async function readBody(ctx) {
  const body = ctx?.body
  if (body && typeof body === 'object') return body
  if (typeof body === 'string' && body.trim()) {
    try {
      return JSON.parse(body)
    } catch {
      return {}
    }
  }
  const chunks = []
  for await (const chunk of ctx.req) chunks.push(chunk)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function apply(ctx, config = {}) {
  const logger = ctx.logger('foxy-memory-bridge')
  const handlers = createHandlers({
    service: ctx.chatluna_living_memory,
    config,
    logger,
  })
  const path = handlers.path

  const route = async (koa, handler) => {
    if (!isAuthorized(koa, config.token)) {
      koa.status = 401
      koa.body = { ok: false, error: 'unauthorized' }
      return
    }
    try {
      const result = await handler(await readBody(koa))
      koa.status = result.status
      koa.body = result.body
    } catch (error) {
      logger.warn?.(`[foxy-memory-bridge] request failed: ${error instanceof Error ? error.message : String(error)}`)
      koa.status = 500
      koa.body = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  ctx.server.get(`${path}/health`, (koa) => {
    const result = handlers.health()
    koa.status = result.status
    koa.body = result.body
  })

  ctx.server.post(`${path}/record`, (koa) => route(koa, handlers.record))
  ctx.server.post(`${path}/context`, (koa) => route(koa, handlers.context))

  logger.info(`[foxy-memory-bridge] listening at ${path} preset=${config.presetId || 'foxy3（Character）'}`)
}

module.exports = {
  name: 'foxy-memory-bridge',
  inject: ['server', 'chatluna_living_memory'],
  Config,
  apply,
  isAuthorized,
  isLoopback,
}

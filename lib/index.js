'use strict'

const { Schema } = require('koishi')
const { createHandlers } = require('./handlers')

const CHARACTER_SUFFIX = '（Character）'

const Config = Schema.object({
  path: Schema.string()
    .default('/foxy-memory')
    .description('HTTP 路由前缀。DSH 端 `bridgeUrl` 填到此前缀为止。'),
  token: Schema.string()
    .role('secret')
    .default('')
    .description('Bearer token。留空时只允许本机回环地址访问；公网部署必须设置。'),
  presetKind: Schema.union([
    Schema.const('character').description('chatluna-character 伪装插件预设'),
    Schema.const('chatluna').description('ChatLuna 主插件预设'),
  ])
    .default('character')
    .description('选择读取/写入哪一套预设的记忆池。'),
  chatlunaPresetId: Schema.dynamic('preset')
    .default('foxy3')
    .description('ChatLuna 主插件预设（自动从 ChatLuna 拉取）。'),
  characterPresetId: Schema.dynamic('character-preset')
    .default('foxy3')
    .description('Character 伪装插件预设（自动从 chatluna-character 拉取；会自动补（Character）后缀）。'),
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
  botId: Schema.string()
    .default('')
    .description('可选，发送私聊使用的机器人 selfId；留空时优先使用 assistantId。'),
  conversationPrefix: Schema.string()
    .default('dsh:')
    .description('DSH 会话 ID 前缀，用于生成 LivingMemory conversationId。'),
  maxContext: Schema.number()
    .min(1)
    .max(100)
    .default(20)
    .description('一次召回最多返回多少条记忆。'),
  extractModel: Schema.dynamic('model')
    .default('deepseek/deepseek-flash')
    .description('批量提取记忆使用的 ChatLuna 模型。'),
})

function effectivePresetId(config = {}) {
  const kind = config.presetKind === 'chatluna' ? 'chatluna' : 'character'
  let id = String(
    kind === 'chatluna'
      ? config.chatlunaPresetId || 'foxy3'
      : config.characterPresetId || 'foxy3',
  ).trim()
  if (!id || id === '无') id = kind === 'chatluna' ? 'foxy3' : `foxy3${CHARACTER_SUFFIX}`
  if (kind === 'character' && !id.endsWith(CHARACTER_SUFFIX)) id += CHARACTER_SUFFIX
  return id
}

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
  let body = ctx?.request?.body ?? ctx?.request?.rawBody ?? ctx?.body
  if (Buffer.isBuffer(body)) body = body.toString('utf8')
  if (body && typeof body === 'object' && Object.keys(body).length > 0) return body
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
  config = { ...config, presetId: effectivePresetId(config) }
  const logger = ctx.logger('foxy-memory-bridge')
  const handlers = createHandlers({
    service: ctx.chatluna_living_memory,
    chatluna: ctx.get ? ctx.get('chatluna') : ctx.chatluna,
    bots: () => ctx.bots,
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
      const query = koa.query && typeof koa.query === 'object' ? koa.query : {}
      const result = await handler({ ...query, ...(await readBody(koa)) })
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

  const registerRoutes = (serverCtx) => {
    serverCtx.server.get(`${path}/health`, (koa) => {
      const result = handlers.health()
      koa.status = result.status
      koa.body = result.body
    })

    serverCtx.server.post(`${path}/record`, (koa) => route(koa, handlers.record))
    serverCtx.server.post(`${path}/ingest`, (koa) => route(koa, handlers.ingest))
    serverCtx.server.post(`${path}/context`, (koa) => route(koa, handlers.context))
    serverCtx.server.post(`${path}/send-private`, (koa) => route(koa, handlers.sendPrivate))

    logger.info(`[foxy-memory-bridge] listening at ${path} preset=${config.presetId || 'foxy3（Character）'}`)
  }

  if (typeof ctx.inject === 'function') ctx.inject(['server'], registerRoutes)
  else registerRoutes(ctx)
}

module.exports = {
  name: 'foxy-memory-bridge',
  inject: ['chatluna_living_memory'],
  Config,
  apply,
  isAuthorized,
  isLoopback,
}


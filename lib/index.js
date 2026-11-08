'use strict'

const http = require('node:http')
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
  standalonePort: Schema.number()
    .min(0)
    .max(65535)
    .default(0)
    .description('独立 HTTP 端口；大于 0 时不依赖 Koishi 控制台路由，DSH bridgeUrl 可直接指向该端口。'),
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
    const app = serverCtx.server
    const routes = {
      [`${path}/health`]: { method: 'GET', handler: null },
      [`${path}/record`]: { method: 'POST', handler: handlers.record },
      [`${path}/ingest`]: { method: 'POST', handler: handlers.ingest },
      [`${path}/context`]: { method: 'POST', handler: handlers.context },
      [`${path}/send-private`]: { method: 'POST', handler: handlers.sendPrivate },
    }

    // Console registers a catch-all SPA route before plugins loaded from groups.
    // Put the API middleware at the front so /foxy-memory is not swallowed by it.
    if (Array.isArray(app.middleware)) {
      app.middleware.unshift(async (koa, next) => {
        const entry = routes[koa.path]
        if (!entry || koa.method !== entry.method) return next()
        if (!entry.handler) {
          const result = handlers.health()
          koa.status = result.status
          koa.body = result.body
          return
        }
        await route(koa, entry.handler)
      })
    } else {
      app.get(`${path}/health`, (koa) => {
        const result = handlers.health()
        koa.status = result.status
        koa.body = result.body
      })
      app.post(`${path}/record`, (koa) => route(koa, handlers.record))
      app.post(`${path}/ingest`, (koa) => route(koa, handlers.ingest))
      app.post(`${path}/context`, (koa) => route(koa, handlers.context))
      app.post(`${path}/send-private`, (koa) => route(koa, handlers.sendPrivate))
    }

    logger.info(`[foxy-memory-bridge] listening at ${path} preset=${config.presetId || 'foxy3（Character）'}`)
  }

  if (typeof ctx.inject === 'function') ctx.inject(['server'], registerRoutes)
  else registerRoutes(ctx)

  if (Number(config.standalonePort) > 0) {
    const standalone = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const koa = {
        headers: req.headers,
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        request: { socket: req.socket },
        req,
        status: 200,
        body: null,
      }
      try {
        if (!isAuthorized(koa, config.token)) {
          koa.status = 401
          koa.body = { ok: false, error: 'unauthorized' }
        } else if (url.pathname === `${path}/health` && req.method === 'GET') {
          const result = handlers.health()
          koa.status = result.status
          koa.body = result.body
        } else if (url.pathname === `${path}/record` && req.method === 'POST') {
          await route(koa, handlers.record)
        } else if (url.pathname === `${path}/ingest` && req.method === 'POST') {
          await route(koa, handlers.ingest)
        } else if (url.pathname === `${path}/context` && req.method === 'POST') {
          await route(koa, handlers.context)
        } else if (url.pathname === `${path}/send-private` && req.method === 'POST') {
          await route(koa, handlers.sendPrivate)
        } else {
          koa.status = 404
          koa.body = { ok: false, error: 'not found' }
        }
      } catch (error) {
        koa.status = 500
        koa.body = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      res.statusCode = koa.status || 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(koa.body ?? { ok: false }))
    })
    standalone.listen(Number(config.standalonePort), '127.0.0.1', () => {
      logger.info(`[foxy-memory-bridge] standalone listening at http://127.0.0.1:${config.standalonePort}${path}`)
    })
    ctx.on('dispose', () => standalone.close())
  }
}

module.exports = {
  name: 'foxy-memory-bridge',
  inject: ['chatluna_living_memory'],
  Config,
  apply,
  isAuthorized,
  isLoopback,
}


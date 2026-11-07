'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')

const instanceModules = 'C:\\Users\\MECHREV\\AppData\\Roaming\\Koishi\\Desktop\\data\\instances\\default\\node_modules'
process.env.NODE_PATH = [instanceModules, process.env.NODE_PATH].filter(Boolean).join(';')
Module._initPaths()

const plugin = require('../lib/index.js')

async function main() {
  const routes = new Map()
  const calls = []
  const service = {
    createScope(...args) {
      calls.push(['createScope', ...args])
      return { conversationId: args[0], presetId: args[1] }
    },
    async recordPresetSpeaker() {},
    async createMemory(scope, input) {
      calls.push(['createMemory', input])
      return { id: 'real-1', createdAt: new Date().toISOString() }
    },
    async searchMemories() { return [] },
    async listMemories() { return { items: [], page: 1, pageSize: 20, total: 0 } },
  }
  const sent = []
  const ctx = {
    logger: () => ({ info() {}, warn() {}, debug() {} }),
    chatluna_living_memory: service,
    bots: [
      {
        selfId: '2877932816',
        async sendPrivateMessage(userId, text) {
          sent.push([userId, text])
          return ['route-message-1']
        },
      },
    ],
    server: {
      get(path, handler) { routes.set(`GET ${path}`, handler) },
      post(path, handler) { routes.set(`POST ${path}`, handler) },
    },
  }

  plugin.apply(ctx, { token: 'secret', presetId: 'foxy3（Character）' })
  assert.ok(routes.has('POST /foxy-memory/record'))
  assert.ok(routes.has('POST /foxy-memory/context'))
  assert.ok(routes.has('POST /foxy-memory/send-private'))
  assert.ok(routes.has('GET /foxy-memory/health'))

  const unauthorized = { headers: {}, body: {}, status: 0 }
  await routes.get('POST /foxy-memory/record')(unauthorized)
  assert.equal(unauthorized.status, 401)

  const koa = {
    headers: { authorization: 'Bearer secret' },
    body: { role: 'user', text: '你好', sessionId: 's1' },
    status: 0,
  }
  await routes.get('POST /foxy-memory/record')(koa)
  assert.equal(koa.status, 200)
  assert.equal(koa.body.ok, true)
  assert.equal(koa.body.id, 'real-1')
  assert.equal(calls[0][0], 'createScope')

  const privateKoa = {
    headers: { authorization: 'Bearer secret' },
    body: { userId: '10001', text: '来自路由的私聊' },
    status: 0,
  }
  await routes.get('POST /foxy-memory/send-private')(privateKoa)
  assert.equal(privateKoa.status, 200)
  assert.equal(privateKoa.body.ok, true)
  assert.deepEqual(sent[0], ['10001', '来自路由的私聊'])

  const health = { headers: {}, body: {}, status: 0 }
  routes.get('GET /foxy-memory/health')(health)
  assert.equal(health.status, 200)
  assert.equal(health.body.ok, true)

  console.log('foxy-memory-bridge route tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

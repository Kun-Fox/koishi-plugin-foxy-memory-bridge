'use strict'

const assert = require('node:assert/strict')
const { createHandlers, speakerKey } = require('../lib/handlers')

async function main() {
  const calls = []
  const memories = []

  const service = {
    createScope(...args) {
      calls.push(['createScope', ...args])
      return { conversationId: args[0], presetId: args[1], userId: args[2], channelId: args[3], options: args[4] }
    },
    async recordPresetSpeaker(scope, label) {
      calls.push(['recordPresetSpeaker', scope, label])
    },
    async createMemory(scope, input, keys) {
      calls.push(['createMemory', scope, input, keys])
      const memory = { id: `mem-${memories.length + 1}`, createdAt: new Date().toISOString(), ...input }
      memories.push(memory)
      return memory
    },
    async searchMemories(presetId, input) {
      calls.push(['searchMemories', presetId, input])
      return memories.filter((memory) => memory.content.includes(input.searchTexts[0]))
    },
    async listMemories(query) {
      calls.push(['listMemories', query])
      return { items: memories, page: 1, pageSize: query.pageSize, total: memories.length }
    },
  }

  const chatluna = {
    async createChatModel() {
      return {
        invoke: async () => ({
          content: JSON.stringify({
            memories: [
              { type: 'fact', content: 'kunfox 说今天在调 Foxy 的记忆桥。', summary: 'kunfox 在调记忆桥', keywords: ['DSH', 'Foxy'], sentiment: '平静', importance: 0.6 },
            ],
          }),
        }),
      }
    },
  }
  const sent = []
  const bots = [
    {
      selfId: '2877932816',
      async sendPrivateMessage(userId, text) {
        sent.push([userId, text])
        return ['message-1']
      },
    },
  ]
  const handlers = createHandlers({ service, chatluna, bots, config: { presetId: 'foxy3（Character）' } })
  assert.equal(handlers.path, '/foxy-memory')
  assert.equal(handlers.health().body.presetId, 'foxy3（Character）')

  const recorded = await handlers.record({ role: 'user', text: 'kunfox 今天在 DSH 做了插件', sessionId: 's1' })
  assert.equal(recorded.status, 200)
  assert.equal(recorded.body.ok, true)
  assert.equal(recorded.body.id, 'mem-1')
  assert.equal(memories[0].type, 'context')
  assert.match(memories[0].content, /kunfox 在 DSH 说/)
  assert.deepEqual(memories[0].keywords, ['DSH', 'Foxy', 'kunfox'])
  assert.equal(memories[0].importance, 0.6)

  const createCall = calls.find((call) => call[0] === 'createMemory')
  assert.equal(createCall[3][0], speakerKey('dsh', '2242711967'))

  const context = await handlers.context({ query: '插件', limit: 5 })
  assert.equal(context.status, 200)
  assert.equal(context.body.count, 1)
  assert.match(context.body.text, /DSH 平台/)
  assert.match(context.body.text, /kunfox 在 DSH 说/)

  const empty = await handlers.context({ query: '不存在的关键词', limit: 5 })
  assert.equal(empty.status, 200)
  assert.equal(empty.body.count, 1, 'falls back to listMemories')

  const bad = await handlers.record({ role: 'system', text: 'x' })
  assert.equal(bad.status, 400)

  const ingested = await handlers.ingest({
    sessionId: 's1',
    messages: [
      { role: 'user', text: '今天在调 Foxy 的记忆桥。', at: Date.now() },
      { role: 'assistant', text: '好，我记住啦。', at: Date.now() },
    ],
  })
  assert.equal(ingested.status, 200)
  assert.equal(ingested.body.created, 1)
  assert.match(memories.at(-1).content, /^我记得在 DSH 私聊里，/)

  const direct = await handlers.sendPrivate({ text: '这个视频有点意思' })
  assert.equal(direct.status, 200)
  assert.equal(direct.body.ok, true)
  assert.equal(direct.body.userId, '2242711967')
  assert.deepEqual(direct.body.messageIds, ['message-1'])
  assert.deepEqual(sent[0], ['2242711967', '这个视频有点意思'])

  const directTarget = await handlers.sendPrivate({ userId: '10001', text: '私聊测试' })
  assert.equal(directTarget.status, 200)
  assert.equal(sent[1][0], '10001')

  const noText = await handlers.sendPrivate({ userId: '10001' })
  assert.equal(noText.status, 400)

  console.log('foxy-memory-bridge tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

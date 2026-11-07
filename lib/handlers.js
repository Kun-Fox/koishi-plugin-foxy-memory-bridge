'use strict'

const { createHash } = require('node:crypto')

const DEFAULTS = {
  path: '/foxy-memory',
  presetId: 'foxy3（Character）',
  platform: 'dsh',
  userId: '2242711967',
  userLabel: 'kunfox',
  assistantId: '2877932816',
  assistantLabel: 'Foxy',
  conversationPrefix: 'dsh:',
  maxContext: 20,
}

function speakerKey(platform, speakerId) {
  return createHash('sha256').update(`${platform}\0${speakerId}`).digest('hex')
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function asDate(value) {
  const date = value ? new Date(value) : new Date()
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function formatDate(value) {
  const date = asDate(value)
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

function createHandlers({ service, chatluna, bots, config = {}, logger = console }) {
  const path = asText(config.path) || DEFAULTS.path
  const presetId = asText(config.presetId) || DEFAULTS.presetId
  const platform = asText(config.platform) || DEFAULTS.platform
  const userId = asText(config.userId) || DEFAULTS.userId
  const userLabel = asText(config.userLabel) || DEFAULTS.userLabel
  const assistantId = asText(config.assistantId) || DEFAULTS.assistantId
  const assistantLabel = asText(config.assistantLabel) || DEFAULTS.assistantLabel
  const conversationPrefix = asText(config.conversationPrefix) || DEFAULTS.conversationPrefix
  const maxContext = Math.max(1, Number(config.maxContext) || DEFAULTS.maxContext)

  if (!service || typeof service.createMemory !== 'function') {
    throw new Error('livingmemory service is not available')
  }

  function scopeFor(sessionId, preset = presetId) {
    const conversationId = `${conversationPrefix}${sessionId || 'default'}`
    return service.createScope(conversationId, preset, userId, sessionId || undefined, {
      platform,
      isDirect: true,
      speakerId: userId,
      presetLabel: preset,
    })
  }

  function sceneLabel(scene) {
    if (scene === 'bilibili') return 'B站'
    if (scene === 'private') return 'QQ 私聊'
    return 'DSH 私聊'
  }

  function botList() {
    const value = typeof bots === 'function' ? bots() : bots
    if (Array.isArray(value)) return value.filter(Boolean)
    if (value && typeof value.values === 'function') return [...value.values()].filter(Boolean)
    if (value && typeof value === 'object') return Object.values(value).filter(Boolean)
    return []
  }

  function normalizeTranscript(messages = [], scene = 'dsh') {
    const label = sceneLabel(scene)
    return messages
      .map((message) => {
        const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'user' ? 'user' : ''
        const text = asText(message?.text ?? message?.content)
        if (!role || !text) return null
        return `[${formatDate(message?.at)}]（${label}）${role === 'user' ? userLabel : assistantLabel}：${text}`
      })
      .filter(Boolean)
      .join('\n')
  }

  async function extractMemories(transcript, preset, scene = 'dsh') {
    if (!chatluna || typeof chatluna.createChatModel !== 'function') {
      throw new Error('chatluna service is unavailable')
    }
    const modelName = asText(config.extractModel) || 'deepseek/deepseek-flash'
    const ref = await chatluna.createChatModel(modelName)
    const model = ref?.value ?? ref
    if (!model || typeof model.invoke !== 'function') throw new Error(`提取模型不可用：${modelName}`)

    let persona = ''
    try {
      if (typeof service.resolvePresetPersona === 'function') {
        const value = await service.resolvePresetPersona(preset)
        persona = typeof value === 'string' ? value : asText(value?.content || value?.text)
      }
    } catch {}

    const systemPrompt = [
      '<role>',
      `你是 ${assistantLabel}，正在从${sceneLabel(scene)}中整理自己的长期记忆。`,
      '你只能用第一人称、中文、符合 Foxy 人格与语气的方式记录自己的认识；不要用“用户”“对方”等泛称，要写具体昵称。',
      scene === 'bilibili'
        ? '这是 Foxy 在 B 站刷视频后的观后感，不是 QQ/DSH 聊天；每条记忆都要让未来的你知道“这是我在 B 站刷到的”。'
        : scene === 'private'
          ? '这是 Foxy 通过 QQ 私聊主动发给主人的消息；每条记忆都要让未来的你知道“我在 QQ 私聊里主动分享过”。'
          : '这是 DSH 私聊，不是 QQ 群聊；每条记忆都要让未来的你知道“这是在 DSH 私聊里发生的”。',
      '</role>',
      '',
      '<preset_context>',
      persona || '你是 Foxy，一只住在 DSH 里的狐狸角色。',
      '</preset_context>',
      '',
      '<task>',
      `阅读下面的${sceneLabel(scene)}记录，只提取值得长期记住的内容：`,
      '1. 一条记忆只描述一个主题或一个事件，避免流水账和寒暄。',
      '2. 优先记录事实、偏好、关系、计划、重要情境；普通问候、工具调用过程、临时状态不记录。',
      scene === 'bilibili'
        ? '3. 每条记忆的 content 以“我刷到”开头，用 Foxy 第一人称写自己看到了什么、对什么感兴趣；不要写成“kunfox 说/回复”，也不要复述整段推理。summary 也用第一人称。'
        : scene === 'private'
          ? '3. 每条记忆的 content 以“我在 QQ 私聊里，”开头，用 Foxy 第一人称写自己主动分享了什么、为什么觉得有意思；不要写成“kunfox 说/回复”。summary 也用第一人称。'
          : '3. 每条记忆的 content 以“我记得在 DSH 私聊里，”开头，用 Foxy 第一人称写自己的认识；不要写成“kunfox 说/回复”，也不要复述整段推理。summary 也用第一人称。',
      '4. 一条记忆最多 180 字，语气自然、口语化；关键词 1 到 8 个。',
      '5. 没有值得记录的内容就返回空数组，不要硬凑。',
      '</task>',
      '',
      '<output_contract>',
      '只输出一个 JSON 对象，不要 Markdown 代码块、解释或前后缀：',
      '{"memories":[{"type":"identity|preference|fact|plan|context|other","content":"...","summary":"...","keywords":["..."],"sentiment":"平静","importance":0.5}]}',
      '</output_contract>',
    ].join('\n')

    const input = `<chat_history>\n${transcript}\n</chat_history>`
    let content
    try {
      const { SystemMessage, HumanMessage } = require('@langchain/core/messages')
      const response = await model.invoke([new SystemMessage(systemPrompt), new HumanMessage(input)])
      content = response?.content
    } catch (error) {
      if (!/Cannot find module/.test(String(error))) throw error
      const response = await model.invoke(`${systemPrompt}\n\n${input}`)
      content = response?.content
    }

    const text = Array.isArray(content)
      ? content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
      : String(content || '')
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('提取模型没有返回 JSON')
    const parsed = JSON.parse(match[0])
    return Array.isArray(parsed.memories) ? parsed.memories.slice(0, 5) : []
  }

  function firstPerson(text, scene = 'dsh') {
    const value = asText(text)
    if (!value) return value
    if (scene === 'bilibili') {
      if (/^我刷到/.test(value)) return value
      const body = value.replace(/^我记得[，,]?\s*/, '').replace(/^我[，,]?\s*/, '')
      return `我刷到，${body}`
    }
    if (scene === 'private') {
      if (/^我在\s*QQ\s*私聊里/.test(value)) return value
      const body = value.replace(/^我记得[，,]?\s*/, '').replace(/^我[，,]?\s*/, '')
      return `我在 QQ 私聊里，${body}`
    }
    if (/DSH\s*私聊/.test(value)) return value
    const body = value.replace(/^我记得[，,]?\s*/, '').replace(/^我[，,]?\s*/, '')
    return `我记得在 DSH 私聊里，${body}`
  }

  async function ingest(payload = {}) {
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const scene = asText(payload.scene) || 'dsh'
    const transcript = normalizeTranscript(messages, scene)
    if (!transcript) return { status: 400, body: { ok: false, error: 'messages is required' } }
    if (transcript.length > 24000) return { status: 413, body: { ok: false, error: 'transcript too large' } }

    const preset = asText(payload.presetId) || presetId
    const sessionId = asText(payload.sessionId)
    try {
      const memories = await extractMemories(transcript, preset, scene)
      const created = []
      const scope = scopeFor(sessionId, preset)
      for (const memory of memories) {
        const rawContent = asText(memory?.content)
        if (!rawContent) continue
        const content = firstPerson(rawContent, scene)
        const summary = firstPerson(asText(memory?.summary) || rawContent.slice(0, 120), scene)
        const keywords = Array.isArray(memory?.keywords)
          ? memory.keywords.map(asText).filter(Boolean).slice(0, 8)
          : []
        const entry = await service.createMemory(
          scope,
          {
            type: ['identity', 'preference', 'fact', 'plan', 'context', 'other'].includes(memory?.type)
              ? memory.type
              : 'context',
            status: 'active',
            content,
            summary,
            keywords: keywords.length ? keywords : ['DSH', 'Foxy'],
            sentiment: asText(memory?.sentiment) || '平静',
            importance: Math.min(1, Math.max(0, Number(memory?.importance) || 0.5)),
          },
          [speakerKey(platform, userId), speakerKey(platform, assistantId)],
        )
        created.push(entry)
      }
      logger.debug?.(`[foxy-memory-bridge] ingested ${created.length} memories preset=${preset}`)
      return {
        status: 200,
        body: { ok: true, presetId: preset, created: created.length, ids: created.map((entry) => entry.id) },
      }
    } catch (error) {
      logger.warn?.(`[foxy-memory-bridge] ingest failed: ${error instanceof Error ? error.message : String(error)}`)
      return {
        status: 503,
        body: { ok: false, error: error instanceof Error ? error.message : String(error) },
      }
    }
  }

  async function record(payload = {}) {
    const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : ''
    if (!role) return { status: 400, body: { ok: false, error: 'role must be user or assistant' } }

    const text = asText(payload.text)
    if (!text) return { status: 400, body: { ok: false, error: 'text is required' } }
    if (text.length > 12000) return { status: 413, body: { ok: false, error: 'text too large' } }

    const preset = asText(payload.presetId) || presetId
    const sessionId = asText(payload.sessionId)
    const speaker = role === 'user' ? userLabel : assistantLabel
    const speakerId = role === 'user' ? userId : assistantId
    const scope = scopeFor(sessionId, preset)
    const key = speakerKey(platform, speakerId)
    const line = `${speaker} 在 DSH ${role === 'user' ? '说' : '回复'}：${text}`

    try {
      if (typeof service.recordPresetSpeaker === 'function') {
        await service.recordPresetSpeaker(
          { presetId: preset, speakerId, userId, platform },
          speaker,
        )
      }
      const memory = await service.createMemory(
        scope,
        {
          type: 'context',
          content: line,
          keywords: ['DSH', 'Foxy', speaker],
          summary: text.slice(0, 240),
          importance: role === 'user' ? 0.6 : 0.4,
        },
        [key],
      )
      logger.debug?.(`[foxy-memory-bridge] recorded ${memory.id} preset=${preset} role=${role}`)
      return {
        status: 200,
        body: {
          ok: true,
          id: memory.id,
          presetId: preset,
          createdAt: memory.createdAt || new Date(),
        },
      }
    } catch (error) {
      logger.warn?.(`[foxy-memory-bridge] record failed: ${error instanceof Error ? error.message : String(error)}`)
      return {
        status: 500,
        body: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          hint: `检查 preset ${preset} 是否存在，以及 LivingMemory 是否已启用`,
        },
      }
    }
  }

  async function context(payload = {}) {
    const preset = asText(payload.presetId) || presetId
    const limit = Math.min(maxContext, Math.max(1, Number(payload.limit) || maxContext))
    const query = asText(payload.query) || 'DSH'
    let rows = []

    try {
      if (typeof service.searchMemories === 'function') {
        rows = await service.searchMemories(preset, {
          searchTexts: [query],
          memoryTypes: ['all'],
          memoryStatus: 'active',
        })
      }
    } catch (error) {
      logger.warn?.(`[foxy-memory-bridge] search failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      try {
        const page = await service.listMemories({
          presetId: preset,
          status: 'active',
          page: 1,
          pageSize: limit,
        })
        rows = Array.isArray(page?.items) ? page.items : []
      } catch (error) {
        logger.warn?.(`[foxy-memory-bridge] list failed: ${error instanceof Error ? error.message : String(error)}`)
        rows = []
      }
    }

    const picked = rows
      .filter((row) => row && typeof row.content === 'string')
      .slice(-limit)
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))

    const lines = picked.map((row) => {
      const label = row.sourceLabel || 'DSH'
      return `- [${formatDate(row.createdAt)}] [${label} 平台] ${row.content}`
    })

    return {
      status: 200,
      body: { ok: true, presetId: preset, count: lines.length, text: lines.join('\n'), memories: picked },
    }
  }

  async function sendPrivate(payload = {}) {
    const text = asText(payload.text)
    if (!text) return { status: 400, body: { ok: false, error: 'text is required' } }
    if (text.length > 12000) return { status: 413, body: { ok: false, error: 'text too large' } }

    const target = asText(payload.userId) || userId
    const preferred = asText(payload.selfId) || asText(config.botId) || assistantId
    const list = botList()
    const bot =
      list.find((item) => String(item?.selfId ?? item?.sid ?? item?.id ?? '') === preferred) || list[0]
    if (!bot) {
      return { status: 503, body: { ok: false, error: '没有可用的 QQ 机器人，请检查 OneBot 连接' } }
    }

    try {
      let result
      if (typeof bot.sendPrivateMessage === 'function') {
        result = await bot.sendPrivateMessage(target, text)
      } else {
        const channel =
          typeof bot.createDirectChannel === 'function'
            ? await bot.createDirectChannel(target)
            : { id: `private:${target}` }
        const channelId = typeof channel === 'string' ? channel : channel?.id
        if (!channelId) throw new Error('机器人没有返回私聊频道')
        result = await bot.sendMessage(channelId, text)
      }
      const messageIds = (Array.isArray(result) ? result : [result])
        .map((id) => String(id || ''))
        .filter(Boolean)
      logger.info?.(`[foxy-memory-bridge] private message sent to ${target} via ${bot.selfId || bot.id || 'bot'}`)
      return {
        status: 200,
        body: {
          ok: true,
          userId: target,
          botId: String(bot.selfId ?? bot.sid ?? bot.id ?? ''),
          messageIds,
        },
      }
    } catch (error) {
      logger.warn?.(`[foxy-memory-bridge] send-private failed: ${error instanceof Error ? error.message : String(error)}`)
      return {
        status: 502,
        body: { ok: false, error: error instanceof Error ? error.message : String(error) },
      }
    }
  }

  function health() {
    return {
      status: 200,
      body: {
        ok: true,
        presetId,
        platform,
        path,
        service: 'chatluna_living_memory',
      },
    }
  }

  return { path, record, ingest, context, sendPrivate, health }
}

module.exports = {
  DEFAULTS,
  createHandlers,
  speakerKey,
  formatDate,
}




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

function createHandlers({ service, config = {}, logger = console }) {
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
      return `- [${formatDate(row.createdAt)}] [${label}] ${row.content}`
    })

    return {
      status: 200,
      body: { ok: true, presetId: preset, count: lines.length, text: lines.join('\n'), memories: picked },
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

  return { path, record, context, health }
}

module.exports = {
  DEFAULTS,
  createHandlers,
  speakerKey,
  formatDate,
}

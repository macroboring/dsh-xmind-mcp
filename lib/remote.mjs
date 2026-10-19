// Minimal Streamable HTTP client for Xmind's official MCP endpoint.
// Dependency-free on purpose: it must run from a plain `node` process spawned by
// the Harness, without resolving any package from the Harness installation.
import { NotAuthorizedError, accessToken, mcpUrl } from './oauth.mjs'
import { DEBUG, log } from './store.mjs'

// Tried in order; the server answers with the revision it actually speaks.
const PREFERRED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const CLIENT_INFO = { name: 'dsh-xmind-mcp', version: '1.0.0' }
const DEFAULT_TIMEOUT_MS = 230000
const MAX_LIST_PAGES = 20

// Only read-only requests may be retried. A tools/call is never replayed: a lost
// response does not mean the work did not happen, and Xmind's authoring tools
// create or rewrite files (and can spend credits).
const RETRYABLE_METHODS = new Set(['ping', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list'])

let nextId = 1

function parseSse(text) {
  const messages = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('')
    if (!data) continue
    try {
      messages.push(JSON.parse(data))
    } catch {
      log('warn', `ignoring unparsable SSE data: ${data.slice(0, 200)}`)
    }
  }
  return messages
}

const isResponse = (message, id) =>
  message && message.id === id && (message.result !== undefined || message.error !== undefined)

export class RemoteMcp {
  constructor({ url = null, debug = DEBUG } = {}) {
    this.url = url
    this.debug = debug
    this.sessionId = null
    this.protocolVersion = null
    this.serverInfo = null
    this.instructions = ''
    this.ready = null
    this.readyFor = null
  }

  /** Resolved per request so a site switch applies without restarting the bridge. */
  endpoint() {
    return this.url || mcpUrl()
  }

  async #headers() {
    const token = await accessToken()
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion
    return headers
  }

  async #fetchOnce(message, timeoutMs) {
    const endpoint = this.endpoint()
    const headers = await this.#headers()
    if (this.debug) log('info', `-> ${JSON.stringify(message).slice(0, 500)}`)
    let res
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new Error(`无法连接 Xmind MCP（${endpoint}）：${error.message}`)
    }
    const session = res.headers.get('mcp-session-id')
    if (session) this.sessionId = session
    const text = await res.text()
    if (this.debug) log('info', `<- (${res.status} ${res.headers.get('content-type') || '?'}) ${text.slice(0, 800)}`)
    return { res, text, endpoint }
  }

  async #post(message, { timeoutMs = DEFAULT_TIMEOUT_MS, allowRefresh = true } = {}) {
    let { res, text, endpoint } = await this.#fetchOnce(message, timeoutMs)

    // A rejected token is answered before the request is processed, so one forced
    // refresh plus one retry is safe even for tools/call.
    if ((res.status === 401 || res.status === 403) && allowRefresh) {
      log('warn', `Xmind MCP answered ${res.status}; refreshing the token and retrying once`)
      await accessToken({ force: true })
      ;({ res, text } = await this.#fetchOnce(message, timeoutMs))
    }

    if (res.status === 401 || res.status === 403) {
      throw new NotAuthorizedError(
        `Xmind MCP 拒绝授权（HTTP ${res.status}）${text ? `：${text.slice(0, 300)}` : ''}（可调用 login 工具重新授权）`,
      )
    }
    if (res.status === 202 || res.status === 204) return null
    if (!res.ok) throw new Error(`Xmind MCP HTTP ${res.status} ${res.statusText}：${text.slice(0, 400)}`)
    if (!text.trim()) return null

    const contentType = res.headers.get('content-type') || ''
    let messages
    try {
      messages = contentType.includes('text/event-stream') ? parseSse(text) : [JSON.parse(text)]
    } catch (error) {
      throw new Error(`Xmind MCP（${endpoint}）返回了无法解析的响应：${error.message}｜${text.slice(0, 300)}`)
    }
    const flat = messages.flat()
    if (message.id === undefined) return null
    const chosen = flat.find((m) => isResponse(m, message.id))
    if (!chosen) throw new Error(`Xmind MCP 未返回匹配的响应：${text.slice(0, 400)}`)
    if (chosen.error) {
      const error = new Error(`Xmind MCP ${message.method} 失败：${chosen.error.message || JSON.stringify(chosen.error)}`)
      error.rpc = chosen.error
      throw error
    }
    return chosen.result
  }

  async #handshake(protocolVersion) {
    const result = await this.#post({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: { protocolVersion, capabilities: {}, clientInfo: CLIENT_INFO },
    })
    if (result?.instructions) this.instructions = String(result.instructions)
    this.serverInfo = result?.serverInfo ?? null
    this.protocolVersion = result?.protocolVersion || protocolVersion
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    return result
  }

  /** Initialize once; tries the preferred protocol revisions in order. */
  ensureReady() {
    const endpoint = this.endpoint()
    if (this.ready && this.readyFor !== endpoint) {
      // The configured deployment changed under us: start a fresh session.
      this.ready = null
      this.sessionId = null
      this.protocolVersion = null
    }
    if (!this.ready) {
      this.readyFor = endpoint
      this.ready = (async () => {
        let lastError
        for (const version of PREFERRED_VERSIONS) {
          try {
            const result = await this.#handshake(version)
            log('info', `MCP session ready (client asked ${version}, server speaks ${this.protocolVersion})`)
            return result
          } catch (error) {
            if (error instanceof NotAuthorizedError) throw error
            lastError = error
            this.sessionId = null
            this.protocolVersion = null
            log('warn', `initialize with ${version} failed: ${error.message}`)
          }
        }
        throw lastError || new Error('Xmind MCP 握手失败')
      })().catch((error) => {
        this.ready = null
        throw error
      })
    }
    return this.ready
  }

  async request(method, params = {}, options = {}) {
    await this.ensureReady()
    const send = () => this.#post({ jsonrpc: '2.0', id: nextId++, method, params }, options)
    try {
      return await send()
    } catch (error) {
      if (!RETRYABLE_METHODS.has(method)) throw error
      // A dropped session is recoverable for read-only calls: re-handshake, retry once.
      if (error?.rpc?.code === -32001 || /session/i.test(error.message)) {
        log('warn', `session lost during ${method}; re-initializing`)
        this.sessionId = null
        this.ready = null
        await this.ensureReady()
        return send()
      }
      throw error
    }
  }

  async listTools() {
    const tools = []
    let cursor
    const seen = new Set()
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {})
      tools.push(...(result?.tools || []))
      cursor = result?.nextCursor
      if (!cursor) return tools
      if (seen.has(cursor)) {
        log('warn', `tools/list returned a repeated cursor; stopping after ${tools.length} tools`)
        return tools
      }
      seen.add(cursor)
    }
    log('warn', `tools/list hit the ${MAX_LIST_PAGES}-page cap; tool list may be incomplete`)
    return tools
  }

  async callTool(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args })
    if (!result || typeof result !== 'object') return { content: [] }
    // The upstream client validates CallToolResult, where `content` is required.
    if (!Array.isArray(result.content)) return { ...result, content: [] }
    return result
  }

  async ping() {
    try {
      await this.request('ping', {}, { timeoutMs: 15000 })
      return true
    } catch {
      return false
    }
  }
}

/** Flatten an MCP tools/call result into plain text for the model. */
export function renderToolResult(result) {
  if (result == null) return '（Xmind 未返回内容）'
  const blocks = Array.isArray(result.content) ? result.content : []
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text') parts.push(block.text)
    else if (block?.type === 'resource' && block.resource?.text) parts.push(block.resource.text)
    else if (block?.type === 'resource_link') parts.push(`[${block.name || 'resource'}](${block.uri})`)
    else if (block?.type === 'image') parts.push('（图片内容已省略）')
    else parts.push(JSON.stringify(block))
  }
  if (result.structuredContent) {
    const structured = JSON.stringify(result.structuredContent, null, 2)
    if (!parts.some((p) => p.includes(structured))) parts.push(structured)
  }
  return parts.join('\n') || JSON.stringify(result, null, 2)
}

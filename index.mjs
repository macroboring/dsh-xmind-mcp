#!/usr/bin/env node
// Xmind MCP bridge for DeepSeek Harness.
//
// Speaks MCP over stdio to the Harness (newline-delimited JSON-RPC) and forwards
// tool calls to Xmind's official MCP endpoint, which owns the user's cloud
// mind maps ("我的导图"). The bridge adds three local tools so the agent can
// authorize, inspect, and reset the connection on its own.
//
// stdout carries protocol traffic only; every diagnostic goes to stderr.
import readline from 'node:readline'
import { authState, beginLogin, logout, NotAuthorizedError } from './lib/oauth.mjs'
import { RemoteMcp } from './lib/remote.mjs'
import { DEBUG, log, store } from './lib/store.mjs'

const SERVER_INFO = { name: 'xmind-mcp', version: '1.0.0' }
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const FALLBACK_VERSION = '2025-06-18'

const remote = new RemoteMcp()

const text = (value) => ({ content: [{ type: 'text', text: String(value) }] })
const failure = (value) => ({ content: [{ type: 'text', text: String(value) }], isError: true })

const LOCAL_TOOLS = [
  {
    name: 'login',
    description:
      '在默认浏览器中打开 Xmind 授权页，完成 OAuth 授权并把令牌保存到本机。当其它 Xmind 工具报“尚未授权”时先调用它。可选 origin 指定站点：cn=中国大陆站（app.xmind.cn，支持手机号登录）、global=国际站（app.xmind.com，邮箱登录）；若登录页只提供邮箱而用户是手机号账号，请改用 cn。',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: '可选站点：cn 或 global，留空则沿用当前站点' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      // Returns the URL immediately; the flow keeps running in this process and
      // saves the tokens whenever the browser redirect arrives.
      const { url, origin: site, completion } = await beginLogin({ origin: args?.origin })
      completion.then(
        () => {
          log('info', 'Xmind authorization completed')
          // The cloud tools only exist once authorized, so ask the Harness to re-sync.
          write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
        },
        (error) => log('warn', `Xmind authorization failed: ${error.message}`),
      )
      return text(
        [
          '请在浏览器中打开下面的 Xmind 授权链接并点「授权 / 同意」：',
          url,
          '',
          `站点：${site}`,
          '若浏览器里还没有 Xmind 登录态，授权页只会显示邮箱登录表单，手机号账号会卡在「需要用户 id」。',
          '这种情况请先登录对应站点（中国站 https://app.xmind.cn），再打开上面的链接；若它仍弹出登录框，登录后按 F5 刷新该页。',
          '授权完成后本工具无需再次调用，用 status 可确认结果。',
        ].join('\n'),
      )
    },
  },
  {
    name: 'status',
    description: '查看 Xmind 授权状态、当前站点、连接信息与可用的云端导图工具数量。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const state = authState()
      const lines = [
        `授权状态：${state.authorized ? '已授权' : '未授权'}`,
        `站点：${state.origin}`,
        state.pending_authorize_url ? `待完成的授权链接（${state.pending_since || '刚刚'}）：${state.pending_authorize_url}` : null,
        state.token_origin && !state.origin_matches ? `⚠️ 已保存的令牌属于 ${state.token_origin}` : null,
        state.expires_at ? `令牌过期时间：${state.expires_at}${state.expired ? '（已过期，将自动刷新）' : ''}` : null,
        state.has_refresh_token ? '刷新令牌：已保存' : null,
        `OAuth 客户端：${state.client_id || '未注册'}`,
        `凭据目录：${state.home}`,
      ].filter(Boolean)
      try {
        const cache = store.getToolsCache()
        // Avoid a full remote sync on every status call; refresh only when stale.
        const stale = !cache?.fetchedAt || Date.now() - cache.fetchedAt > 5 * 60 * 1000
        const tools = await getRemoteTools({ allowNetwork: Boolean(state.authorized) && stale })
        lines.push(`Xmind 云端工具：${tools.length} 个${tools.length ? `（${tools.map((t) => t.name).slice(0, 12).join(', ')}${tools.length > 12 ? ', …' : ''}）` : ''}`)
        lines.push(`MCP 会话：协议 ${remote.protocolVersion || '未握手'}，会话 ID ${remote.sessionId ? '已建立' : '未建立'}`)
      } catch (error) {
        lines.push(`Xmind 云端工具：不可用（${error.message}）`)
      }
      return text(lines.join('\n'))
    },
  },
  {
    name: 'logout',
    description: '清除本机保存的 Xmind 授权令牌。下次使用需要重新调用 login。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      logout()
      return text(`已清除 Xmind 授权令牌（${store.home}）。`)
    },
  },
]

const LOCAL_NAMES = new Set(LOCAL_TOOLS.map((tool) => tool.name))
/** exposed tool name -> raw name on Xmind's server; replaced on every sync */
let remoteNameMap = new Map()

/**
 * Public names are a pure function of the remote tool list, and the map is rebuilt
 * from scratch each time: the Harness pins tool names in session history and
 * permission rules, so a re-sync of the same tool set must reproduce the same
 * names instead of drifting.
 */
function exposeRemoteTools(remoteTools) {
  const map = new Map()
  const exposed = remoteTools.map((tool) => {
    let name = LOCAL_NAMES.has(tool.name) ? `remote_${tool.name}` : tool.name
    if (map.has(name)) name = `remote_${tool.name}`
    let counter = 2
    while (map.has(name)) name = `remote_${counter++}_${tool.name}`
    map.set(name, tool.name)
    return {
      name,
      description: tool.description || tool.title || `Xmind cloud tool: ${tool.name}`,
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    }
  })
  remoteNameMap = map
  return exposed
}

/**
 * Remote tools, cached between starts so the tool list survives a restart or a
 * temporary outage. Network failures degrade to the cache instead of failing.
 */
async function getRemoteTools({ allowNetwork = true } = {}) {
  const state = authState()
  const cache = store.getToolsCache()
  if (!allowNetwork || !state.authorized) return exposeRemoteTools(cache?.tools || [])
  try {
    const tools = await remote.listTools()
    store.saveToolsCache({ fetchedAt: Date.now(), protocolVersion: remote.protocolVersion, tools })
    log('info', `synced ${tools.length} Xmind tools`)
    return exposeRemoteTools(tools)
  } catch (error) {
    if (error instanceof NotAuthorizedError) throw error
    log('warn', `tools/list failed, using cache: ${error.message}`)
    return exposeRemoteTools(cache?.tools || [])
  }
}

async function callTool(name, args) {
  const local = LOCAL_TOOLS.find((tool) => tool.name === name)
  if (local) return local.handler(args || {})
  // The agent may ask for a raw Xmind tool name that has not been synced yet.
  if (!remoteNameMap.has(name)) await getRemoteTools()
  const rawName = remoteNameMap.get(name)
  if (!rawName) {
    return failure(
      `未知工具 "${name}"。可用工具：${[...LOCAL_NAMES, ...remoteNameMap.keys()].join(', ')}。若尚未授权，请先调用 login。`,
    )
  }
  try {
    return await remote.callTool(rawName, args || {})
  } catch (error) {
    if (error instanceof NotAuthorizedError) return failure(`${error.message}（可调用 login 工具重新授权）`)
    return failure(`Xmind 调用 ${name} 失败：${error.message}`)
  }
}

function negotiationVersion(clientVersion) {
  return SUPPORTED_VERSIONS.includes(clientVersion) ? clientVersion : FALLBACK_VERSION
}

async function instructions() {
  const parts = [
    '本服务器把 Xmind 云端账号中的思维导图（网页版「我的导图」）暴露为工具：可以列出、读取、新建和修改导图。',
    '若任何 Xmind 工具返回“尚未授权”，先调用 login 工具（会在浏览器中打开授权页，用户点确认即完成）。',
    'Xmind 分中国大陆站（app.xmind.cn，手机号登录）与国际站（app.xmind.com，邮箱登录），两者账号独立；若授权页只提供邮箱登录而用户是手机号账号，请调用 login 并传 origin="cn"。',
    '典型顺序：先列出/搜索导图找到目标，再读取其内容，最后按用户需求修改；新建导图直接用创建工具。',
    'Xmind 服务端会用 AI 生成或改写内容，单次调用可能需要 30–120 秒，请耐心等待而不要重复发起同一请求。',
    '修改已有导图前，建议先读取一次，确认结构与标题，避免误改。',
  ]
  const cached = store.getToolsCache()
  if (cached?.tools?.length) {
    parts.push(`当前已知的 Xmind 云端工具：${cached.tools.map((t) => t.name).join(', ')}。`)
  }
  return parts.join('\n')
}

async function handle(request) {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: negotiationVersion(request.params?.protocolVersion),
        // The cloud tool set only appears after authorization, so the bridge
        // announces list changes and the Harness re-syncs without a restart.
        capabilities: { tools: { listChanged: true } },
        serverInfo: SERVER_INFO,
        instructions: await instructions(),
      }
    case 'ping':
      return {}
    case 'tools/list': {
      const list = LOCAL_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      try {
        list.push(...(await getRemoteTools()))
      } catch (error) {
        log('warn', `tools/list: ${error.message}`)
        list.push(...exposeRemoteTools(store.getToolsCache()?.tools || []))
      }
      return { tools: list }
    }
    case 'tools/call': {
      const name = request.params?.name
      if (!name) throw Object.assign(new Error('tools/call requires a name'), { code: -32602 })
      return callTool(name, request.params?.arguments)
    }
    case 'resources/list':
      return { resources: [] }
    case 'resources/templates/list':
      return { resourceTemplates: [] }
    case 'prompts/list':
      return { prompts: [] }
    case 'logging/setLevel':
      return {}
    default:
      // Also covers `server/discover`, which tells the client we are a legacy server.
      throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 })
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const IGNORED_NOTIFICATIONS = new Set(['notifications/initialized', 'notifications/cancelled', 'notifications/progress'])

const rl = readline.createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let request
  try {
    request = JSON.parse(trimmed)
  } catch {
    log('warn', `ignoring non-JSON input: ${trimmed.slice(0, 200)}`)
    return
  }
  if (request.id === undefined || request.id === null) {
    if (!IGNORED_NOTIFICATIONS.has(request.method)) log('info', `notification ${request.method}`)
    return
  }
  handle(request)
    .then((result) => write({ jsonrpc: '2.0', id: request.id, result: result ?? {} }))
    .catch((error) => {
      if (DEBUG) log('warn', `${request.method} error: ${error.stack || error.message}`)
      else log('warn', `${request.method} error: ${error.message}`)
      write({ jsonrpc: '2.0', id: request.id, error: { code: error.code ?? -32603, message: error.message } })
    })
})

rl.on('close', () => {
  log('info', 'stdin closed; bridge exiting')
  process.exit(0)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('info', `received ${signal}; bridge exiting`)
    process.exit(0)
  })
}

// If the parent goes away, writes to stdout raise EPIPE; that must not surface as
// an uncaught exception with a half-written protocol line.
process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') process.exit(0)
  log('error', `stdout error: ${error.message}`)
})

process.on('uncaughtException', (error) => {
  log('error', `uncaught exception: ${error.stack || error.message}`)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  log('error', `unhandled rejection: ${reason?.stack || reason}`)
})

log('info', `xmind-mcp bridge started (home=${store.home}, debug=${DEBUG})`)

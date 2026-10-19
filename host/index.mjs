// dsh-xmind-mcp — 进程内 Host 插件（无子进程）
//
// 为什么不用 stdio 桥：端侧宿主（HarmonyOS/DSHM 等）禁止 fork/exec、也没有 node 可执行文件，
// spawn 必然失败，表现为 `mcp-client(xmind): server is disconnected` 且桥一次都没执行过。
//
// 本插件的做法：
//   · OAuth（动态注册 + PKCE + 回调监听）与远端 MCP（Streamable HTTP）全部在宿主进程内完成；
//   · 远端的每个工具用 ctx.tools.register 注册成**原生 dsh 工具**（名字沿用云端的 xmind_*）；
//   · 只用 node: 内置模块与全局 fetch，不 import 任何裸包名（端侧工作区没有 node_modules）；
//   · 激活期间绝不 throw：失败只写日志，避免把宿主启动流程带崩。
import { NotAuthorizedError, authState, beginLogin, logout, resolveOrigin } from '../lib/oauth.mjs'
import { RemoteMcp, renderToolResult } from '../lib/remote.mjs'
import { log, store } from '../lib/store.mjs'

export const name = 'xmind-mcp'
export const inject = ['tools']

const DEFAULT_TIMEOUT_MS = Number(process.env.XMIND_MCP_TIMEOUT_MS) || 240000

/** 所有工具统一返回一段文本；render 把它变成模型可见的内容块。 */
const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value ?? '') }],
}

/** 校验不过时退而求其次用的宽松 schema（云端 schema 可能含本宿主不支持的构造）。 */
const PERMISSIVE_PARAMETERS = { type: 'object', additionalProperties: true }

const STATUS_TEXT = async (remote, counts) => {
  const state = authState()
  const lines = [
    `授权状态：${state.authorized ? '已授权' : '未授权'}`,
    `站点：${state.origin}`,
    state.pending_authorize_url ? `待完成的授权链接：${state.pending_authorize_url}` : null,
    state.token_origin && !state.origin_matches ? `⚠️ 已保存的令牌属于 ${state.token_origin}` : null,
    state.expires_at ? `令牌过期时间：${state.expires_at}${state.expired ? '（已过期，将自动刷新）' : ''}` : null,
    state.has_refresh_token ? '刷新令牌：已保存' : null,
    `OAuth 客户端：${state.client_id || '未注册'}`,
    `凭据/日志目录：${state.home}`,
    `已注册的云端工具：${counts.remote} 个`,
    `MCP 会话：${remote.protocolVersion ? `协议 ${remote.protocolVersion}` : '未握手'}`,
  ].filter(Boolean)
  return lines.join('\n')
}

export function apply(ctx) {
  const remote = new RemoteMcp()
  const registered = new Map() // tool name -> definition
  const counts = { remote: 0 }
  let syncing = null

  /** 注册一个工具；schema 被宿主拒绝时退化为宽松 schema 再试一次。 */
  function register(definition) {
    if (registered.has(definition.name)) return false
    const attempt = (parameters) => {
      ctx.tools.register({ ...definition, parameters })
      registered.set(definition.name, definition)
      return true
    }
    try {
      return attempt(definition.parameters)
    } catch (error) {
      log('warn', `register ${definition.name} rejected (${error.message}); retrying with a permissive schema`)
      try {
        return attempt(PERMISSIVE_PARAMETERS)
      } catch (retryError) {
        log('warn', `register ${definition.name} failed: ${retryError.message}`)
        return false
      }
    }
  }

  /** 拉取云端工具清单并注册为原生工具。失败只记日志，不影响插件激活。 */
  function syncRemoteTools() {
    if (syncing) return syncing
    syncing = (async () => {
      if (!authState().authorized) return 0
      const tools = await remote.listTools()
      store.saveToolsCache({ fetchedAt: Date.now(), protocolVersion: remote.protocolVersion, tools })
      let added = 0
      for (const tool of tools) {
        if (typeof tool?.name !== 'string' || !tool.name) continue
        if (register(remoteTool(tool))) added++
      }
      counts.remote = [...registered.keys()].filter((toolName) => !LOCAL_NAMES.has(toolName)).length
      log('info', `registered ${counts.remote} cloud tools (${added} new)`)
      return counts.remote
    })()
      .catch((error) => {
        log('warn', `cloud tool sync failed: ${error.message}`)
        return 0
      })
      .finally(() => {
        syncing = null
      })
    return syncing
  }

  /** 云端工具 → 原生工具定义。 */
  function remoteTool(tool) {
    const rawName = tool.name
    return {
      name: rawName,
      description: tool.description || tool.title || `Xmind: ${rawName}`,
      parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : PERMISSIVE_PARAMETERS,
      output: textOutput,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      async execute(args, exec) {
        try {
          const result = await remote.callTool(rawName, args && typeof args === 'object' ? args : {}, {
            signal: exec?.signal,
          })
          return renderToolResult(result)
        } catch (error) {
          if (error instanceof NotAuthorizedError) {
            return `${error.message}\n请先调用 xmind_login 完成授权（站点 ${resolveOrigin()}）。`
          }
          throw error
        }
      },
    }
  }

  // ---- 本地工具 ------------------------------------------------------------

  register({
    name: 'xmind_login',
    description:
      '生成 Xmind 授权链接并立即返回（不阻塞等待），授权在后台完成、完成后自动注册云端导图工具。' +
      'origin 可选 cn=中国大陆站（app.xmind.cn，手机号登录，默认）或 global=国际站（app.xmind.com，邮箱登录）。',
    parameters: {
      type: 'object',
      properties: {
        origin: { type: 'string', enum: ['cn', 'global'], description: '站点：cn 中国大陆站 / global 国际站' },
      },
      additionalProperties: false,
    },
    output: textOutput,
    timeoutMs: 60000,
    async execute(args) {
      const { url, origin, completion } = await beginLogin({
        origin: args?.origin,
        // 端侧/无桌面环境可设 XMIND_MCP_NO_BROWSER=1，避免尝试拉起浏览器（失败也无害）。
        launchBrowser: process.env.XMIND_MCP_NO_BROWSER !== '1',
      })
      completion.then(
        () => {
          log('info', 'authorization completed; syncing cloud tools')
          void syncRemoteTools()
        },
        (error) => log('warn', `authorization failed: ${error.message}`),
      )
      return [
        '请在浏览器中打开下面的链接并点「授权 / 同意」：',
        url,
        '',
        `站点：${origin}`,
        '若浏览器里还没有该站点的登录态，授权页只会显示邮箱表单（手机号账号会卡在「需要用户 id」）：',
        '请先登录对应站点（中国站 https://app.xmind.cn），再打开上面的链接；若它仍弹出登录框，登录后按 F5 刷新该页。',
        '授权完成后无需再次调用；用 xmind_status 确认，云端工具会自动出现。',
      ].join('\n')
    },
  })

  register({
    name: 'xmind_status',
    description: '查看 Xmind 授权状态、当前站点、令牌过期时间、凭据目录与已注册的云端工具数量。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput,
    timeoutMs: 30000,
    async execute() {
      // 已授权但还没注册过云端工具时，借这次调用补一次同步。
      if (authState().authorized && counts.remote === 0) await syncRemoteTools()
      return STATUS_TEXT(remote, counts)
    },
  })

  register({
    name: 'xmind_logout',
    description: '清除本机保存的 Xmind 授权令牌（下次使用需重新调用 xmind_login）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput,
    timeoutMs: 30000,
    async execute() {
      logout()
      return `已清除 Xmind 授权令牌（${store.home}）。`
    },
  })

  // 激活即尝试一次同步：已授权则云端工具立刻可用；失败只记日志。
  void syncRemoteTools()

  log('info', `xmind-mcp host plugin active (origin=${resolveOrigin()}, home=${store.home})`)
}

const LOCAL_NAMES = new Set(['xmind_login', 'xmind_status', 'xmind_logout'])

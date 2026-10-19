#!/usr/bin/env node
// Command-line companion for the Xmind MCP bridge: first-time authorization,
// diagnosis, and direct access to the cloud tools without going through the agent.
//
//   node cli.mjs doctor              # check endpoints, registration, token, handshake
//   node cli.mjs login [cn|global]   # authorize in the browser and store tokens
//   node cli.mjs site [cn|global]    # show (or switch) the Xmind deployment
//   node cli.mjs status              # authorization + connection state
//   node cli.mjs tools               # list Xmind's cloud tools
//   node cli.mjs call <tool> '<json>'   # call one cloud tool
//   node cli.mjs raw <method> '<json>'  # send a raw MCP request
//   node cli.mjs logout
import {
  authState,
  discover,
  login,
  logout,
  mcpUrl,
  resolveOrigin,
  setOrigin,
} from './lib/oauth.mjs'
import { RemoteMcp, renderToolResult } from './lib/remote.mjs'
import { log, store } from './lib/store.mjs'

const [command, ...rest] = process.argv.slice(2)
const remote = new RemoteMcp({ debug: true })

function parseJson(value, label) {
  if (!value) return {}
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${error.message}`)
  }
}

function showTools(tools) {
  for (const tool of tools) {
    console.log(`- ${tool.name}`)
    if (tool.description) console.log(`    ${String(tool.description).split('\n')[0].slice(0, 160)}`)
    const props = tool.inputSchema?.properties
    if (props && Object.keys(props).length) console.log(`    参数: ${Object.keys(props).join(', ')}`)
  }
}

async function doctor() {
  const results = []
  const step = async (label, run) => {
    try {
      const value = await run()
      results.push(`✅ ${label}: ${value ?? 'ok'}`)
    } catch (error) {
      results.push(`❌ ${label}: ${error.message}`)
    }
  }

  await step('授权服务器元数据', async () => {
    const metadata = await discover()
    return `${metadata.authorization_endpoint} | DCR ${metadata.registration_endpoint}`
  })
  // Read-only on purpose: a diagnostic must never register a new client or touch
  // the stored tokens.
  await step('OAuth 客户端', async () => {
    const client = store.getClient()
    if (!client?.client_id) throw new Error('尚未注册 —— `node cli.mjs login` 会自动注册')
    if (client.origin !== resolveOrigin()) {
      throw new Error(`客户端属于 ${client.origin}，当前站点是 ${resolveOrigin()} —— 运行 login 重新注册`)
    }
    return `client_id=${client.client_id}`
  })
  await step('本地令牌', async () => {
    const state = authState()
    if (!state.authorized) throw new Error('未授权或已过期 —— 运行 `node cli.mjs login`')
    if (!state.origin_matches) throw new Error(`令牌属于 ${state.token_origin}，当前站点是 ${state.origin}`)
    return `过期时间 ${state.expires_at ?? '未知'}`
  })
  await step('MCP 握手', async () => {
    await remote.ensureReady()
    return `协议 ${remote.protocolVersion}，服务器 ${remote.serverInfo?.name ?? '?'}`
  })
  await step('云端工具发现', async () => {
    const tools = await remote.listTools()
    store.saveToolsCache({ fetchedAt: Date.now(), protocolVersion: remote.protocolVersion, tools })
    console.log(`   发现 ${tools.length} 个工具：`)
    showTools(tools)
    return `${tools.length} 个`
  })

  console.log(`\n站点: ${resolveOrigin()}`)
  console.log(`端点: ${mcpUrl()}`)
  console.log(`凭据目录: ${store.home}`)
  console.log(`日志文件: ${store.logFile}\n`)
  for (const line of results) console.log(line)
  const failed = results.filter((line) => line.startsWith('❌')).length
  console.log(failed ? `\n${failed} 项未通过。` : '\n全部通过。')
  process.exit(failed ? 1 : 0)
}

try {
  switch (command) {
    case 'doctor':
      await doctor()
      break
    case 'login': {
      const tokens = await login({ origin: rest[0], onUrl: (url) => console.log(`请在浏览器中完成授权：\n${url}\n`) })
      console.log(`授权成功。站点：${tokens.origin}，令牌过期时间：${tokens.expires_at ? new Date(tokens.expires_at).toLocaleString('zh-CN') : '未知'}`)
      break
    }
    case 'site': {
      if (rest[0]) console.log(`已切换站点：${setOrigin(rest[0])}`)
      console.log(`当前站点: ${resolveOrigin()}`)
      console.log(`MCP 端点: ${mcpUrl()}`)
      break
    }
    case 'status': {
      console.log(JSON.stringify(authState(), null, 2))
      break
    }
    case 'logout':
      logout()
      console.log('已清除本地令牌。')
      break
    case 'tools': {
      const tools = await remote.listTools()
      store.saveToolsCache({ fetchedAt: Date.now(), protocolVersion: remote.protocolVersion, tools })
      showTools(tools)
      console.log(`\n共 ${tools.length} 个工具（已写入缓存）`)
      break
    }
    case 'call': {
      const [name, args] = rest
      if (!name) throw new Error('用法: node cli.mjs call <tool> \'{"k":"v"}\'')
      const result = await remote.callTool(name, parseJson(args, '参数'))
      console.log(renderToolResult(result))
      if (result?.structuredContent) console.log(`\n结构化结果:\n${JSON.stringify(result.structuredContent, null, 2)}`)
      break
    }
    case 'raw': {
      const [method, params] = rest
      if (!method) throw new Error('用法: node cli.mjs raw <method> \'{"k":"v"}\'')
      console.log(JSON.stringify(await remote.request(method, parseJson(params, '参数')), null, 2))
      break
    }
    default:
      console.log('用法: node cli.mjs <doctor|login|site|status|logout|tools|call|raw>')
      process.exit(command ? 2 : 0)
  }
} catch (error) {
  log('error', error.stack || error.message)
  console.error(`\n失败：${error.message}\n详见日志：${store.logFile}`)
  process.exit(1)
}

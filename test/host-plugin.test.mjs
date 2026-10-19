// 进程内 Host 插件的离线测试——直接对应端侧问题报告的验收标准。
//   node test/host-plugin.test.mjs
//
// 用一个本地 mock 充当 Xmind 授权服务器 + MCP 端点，不需要账号、不联网、不 spawn。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const project = path.resolve(here, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xmind-host-test-'))

// ---------- mock Xmind ----------
const remoteTools = [
  {
    name: 'xmind_list_mindmaps',
    description: 'List mind maps',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false },
  },
  {
    name: 'xmind_read_mindmap',
    description: 'Read one mind map',
    inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
  },
]
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString('utf8')
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  }
  if (req.url === '/.well-known/oauth-authorization-server') {
    return send(200, {
      issuer: base,
      authorization_endpoint: `${base}/oauth/consent`,
      token_endpoint: `${base}/api/oauth/token`,
      registration_endpoint: `${base}/api/oauth/register`,
    })
  }
  if (req.url === '/api/oauth/register') return send(201, { client_id: 'mock-client', redirect_uris: [] })
  if (req.url === '/api/oauth/token') return send(400, { error: 'invalid_grant' })
  if (req.url === '/api/mcp') {
    const message = JSON.parse(body)
    if (message.id === undefined) return send(202, '')
    let result = {}
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock-xmind', version: '1' } }
    } else if (message.method === 'tools/list') {
      result = { tools: remoteTools }
    } else if (message.method === 'tools/call') {
      result = { content: [{ type: 'text', text: `called ${message.params.name}` }] }
    }
    return send(200, { jsonrpc: '2.0', id: message.id, result })
  }
  send(404, { error: 'not found' })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

// ---------- 环境：隔离凭据目录 + 指向 mock ----------
process.env.XMIND_MCP_HOME = home
process.env.XMIND_MCP_ORIGIN = base
process.env.XMIND_MCP_NO_BROWSER = '1'

const plugin = await import(pathToFileURL(path.join(project, 'host', 'index.mjs')).href)
const oauth = await import(pathToFileURL(path.join(project, 'lib', 'oauth.mjs')).href)

// ---------- 假 ctx：只实现 tools.register ----------
function makeCtx() {
  const tools = new Map()
  return {
    tools,
    ctx: {
      tools: {
        register(definition) {
          if (!definition || typeof definition.name !== 'string') throw new TypeError('tool needs a name')
          if (!definition.output || typeof definition.output.render !== 'function') throw new TypeError('tool needs output.render')
          if (!definition.parameters || definition.parameters.type !== 'object') throw new TypeError("parameters must be a JSON Schema with type:'object'")
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
    },
  }
}

let passed = 0
let failed = 0
const check = async (label, run) => {
  try {
    await run()
    console.log(`✅ ${label}`)
    passed++
  } catch (error) {
    console.log(`❌ ${label}\n    ${error.message}`)
    failed++
  }
}

const { tools, ctx } = makeCtx()
const call = (name, args = {}) => {
  const tool = tools.get(name)
  if (!tool) throw new Error(`工具未注册：${name}`)
  return tool.execute(args, { signal: new AbortController().signal, arguments: args })
}

await check('插件导出 Host 插件形态，且只注入 tools', () => {
  assert.equal(plugin.name, 'xmind-mcp')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
})

await check('激活后注册 3 个本地工具，定义均合法', () => {
  plugin.apply(ctx)
  const local = [...tools.keys()].filter((n) => ['xmind_login', 'xmind_status', 'xmind_logout'].includes(n))
  assert.deepEqual(local.sort(), ['xmind_login', 'xmind_logout', 'xmind_status'])
  for (const [toolName, def] of tools) {
    assert.equal(typeof def.description, 'string', `${toolName} 缺 description`)
    assert.equal(def.parameters.type, 'object', `${toolName} 的 parameters 必须是 object schema`)
    assert.equal(def.output.schema.type, 'string', `${toolName} 的 output.schema 应为 string`)
    assert.equal(typeof def.output.render, 'function')
    assert.ok(Array.isArray(def.output.render({}, 'x')))
  }
})

await check('未授权时 xmind_status 明确报未授权并给出凭据目录', async () => {
  const text = await call('xmind_status')
  assert.match(text, /授权状态：未授权/)
  assert.ok(text.includes(home), `应包含凭据目录，实际：${text}`)
})

await check('xmind_login 立即返回授权链接（不阻塞到用户点完）', async () => {
  const started = Date.now()
  const text = await call('xmind_login', { origin: 'cn' })
  const elapsed = Date.now() - started
  assert.match(text, /\/oauth\/consent\?/, `应返回授权链接：${text}`)
  assert.match(text, /站点：/, '应说明站点')
  // 关键语义：返回时授权流程**仍在等待用户**，而不是已经等完 —— 这才是「不阻塞」。
  assert.ok(oauth.authState().pending_authorize_url, '返回时应仍在等待授权回调')
  // 宽上限只用于兜底（CI runner 冷启动 + 两次本地 HTTP 调用可能到几秒），远小于 600s 授权超时。
  assert.ok(elapsed < 20000, `应远早于授权超时返回，实际 ${elapsed}ms`)
})

await check('已授权时自动注册云端工具（原生工具名沿用 xmind_*）', async () => {
  fs.writeFileSync(
    path.join(home, 'tokens.json'),
    JSON.stringify({ origin: base, access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3600_000 }),
    'utf8',
  )
  fs.writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify({ origin: base }),
    'utf8',
  )
  const text = await call('xmind_status')
  for (const tool of remoteTools) assert.ok(tools.has(tool.name), `应注册云端工具 ${tool.name}`)
  assert.match(text, /已注册的云端工具：2 个/)
})

await check('调用云端工具返回文本结果', async () => {
  const text = await call('xmind_list_mindmaps', { limit: 3 })
  assert.match(text, /called xmind_list_mindmaps/)
})

await check('xmind_logout 清除令牌', async () => {
  await call('xmind_logout')
  assert.equal(oauth.authState().authorized, false)
})

server.close()
fs.rmSync(home, { recursive: true, force: true })
console.log(`\n${passed}/${passed + failed} 项通过`)
process.exit(failed ? 1 : 0)

// Offline verification of the OAuth token layer and the MCP HTTP client, against
// a local mock of Xmind's authorization server and MCP endpoint.
//   node test/refresh.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const project = path.resolve(here, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xmind-refresh-test-'))

// ---- mock Xmind -----------------------------------------------------------
const state = {
  tokenStatus: 200,
  tokenBody: null,
  tokenRequests: 0,
  mcpRequests: [],
  failFirstMcp: false,
  sessionErrorFor: null,
  tokenDelayMs: 60,
}

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
  if (req.url === '/api/oauth/register') {
    return send(201, { client_id: 'mock-client', redirect_uris: ['http://127.0.0.1:8770/callback'] })
  }
  if (req.url === '/api/oauth/token') {
    state.tokenRequests++
    await new Promise((resolve) => setTimeout(resolve, state.tokenDelayMs))
    if (state.tokenStatus !== 200) return send(state.tokenStatus, state.tokenBody ?? { error: 'server_error' })
    return send(
      200,
      state.tokenBody ?? { access_token: `fresh-${state.tokenRequests}`, refresh_token: 'r2', expires_in: 3600 },
    )
  }
  if (req.url === '/api/mcp') {
    state.mcpRequests.push(body)
    if (state.failFirstMcp) {
      state.failFirstMcp = false
      return send(401, { error: 'Unauthorized: Missing or invalid Authorization header' })
    }
    const message = JSON.parse(body)
    if (message.id === undefined) return send(202, '')
    if (state.sessionErrorFor && message.method === state.sessionErrorFor) {
      return send(200, { jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Session not found' } })
    }
    let result = {}
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock-xmind', version: '1' } }
    } else if (message.method === 'tools/list') {
      result = { tools: [{ name: 'mock_tool', description: 'mock', inputSchema: { type: 'object', properties: {} } }] }
    }
    return send(200, { jsonrpc: '2.0', id: message.id, result })
  }
  send(404, { error: 'not found' })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

process.env.XMIND_MCP_HOME = home
process.env.XMIND_MCP_ORIGIN = base

const oauth = await import(pathToFileURL(path.join(project, 'lib', 'oauth.mjs')).href)
const { RemoteMcp } = await import(pathToFileURL(path.join(project, 'lib', 'remote.mjs')).href)

const tokensFile = path.join(home, 'tokens.json')
const seedTokens = (extra = {}) =>
  fs.writeFileSync(
    tokensFile,
    JSON.stringify({
      origin: base,
      access_token: 'expired-token',
      refresh_token: 'r1',
      expires_at: Date.now() - 5000,
      ...extra,
    }),
    'utf8',
  )
const tokensExist = () => fs.existsSync(tokensFile)

await oauth.ensureClient(await oauth.discover(), 'http://127.0.0.1:8770/callback', base)

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

await check('并发刷新只发一次令牌请求，凭据不被误删', async () => {
  seedTokens()
  state.tokenRequests = 0
  state.tokenStatus = 200
  state.tokenBody = null
  const [a, b] = await Promise.all([oauth.accessToken(), oauth.accessToken()])
  assert.equal(state.tokenRequests, 1, `令牌端点被调用 ${state.tokenRequests} 次，应只调用 1 次`)
  assert.equal(a, b, '两个调用者应拿到同一个令牌')
  assert.ok(tokensExist(), 'tokens.json 不应被删除')
  assert.equal(oauth.authState().authorized, true)
})

await check('令牌端点 5xx 时保留凭据', async () => {
  seedTokens()
  state.tokenStatus = 500
  state.tokenBody = { error: 'server_error' }
  let message = ''
  await assert.rejects(oauth.accessToken({ force: true }), (error) => {
    message = error.message
    return true
  })
  assert.ok(!/重新调用 login/.test(message), `不应要求重新登录：${message}`)
  assert.ok(tokensExist(), 'transient 失败不得删除 tokens.json')
})

await check('令牌端点 400 invalid_grant 时清除凭据', async () => {
  seedTokens()
  state.tokenStatus = 400
  state.tokenBody = { error: 'invalid_grant' }
  await assert.rejects(oauth.accessToken({ force: true }), /刷新令牌被拒绝|重新调用 login/)
  assert.ok(!tokensExist(), 'invalid_grant 应清除 tokens.json')
})

await check('MCP 端点 401 时强制刷新并重试一次', async () => {
  seedTokens({ expires_at: Date.now() + 3600000 })
  state.tokenStatus = 200
  state.tokenBody = null
  state.tokenRequests = 0
  state.mcpRequests = []
  state.failFirstMcp = true
  const client = new RemoteMcp()
  const tools = await client.listTools()
  assert.equal(tools.length, 1, `期望 1 个工具，实际 ${tools.length}`)
  assert.equal(state.tokenRequests, 1, '应先刷新一次令牌')
  assert.ok(state.mcpRequests.length >= 3, `initialize 应被重试（实际 ${state.mcpRequests.length} 次 MCP 请求）`)
})

await check('会话丢失（-32001）时不重试 tools/call，避免重复建图', async () => {
  seedTokens({ expires_at: Date.now() + 3600000 })
  state.tokenStatus = 200
  state.tokenBody = null
  state.mcpRequests = []
  state.sessionErrorFor = 'tools/call'
  const client = new RemoteMcp()
  await client.ensureReady()
  const calls = () => state.mcpRequests.filter((body) => JSON.parse(body).method === 'tools/call').length
  await assert.rejects(client.callTool('mock_tool', {}), /Session not found|-32001/)
  assert.equal(calls(), 1, `tools/call 被发送了 ${calls()} 次，必须只发一次`)
  state.sessionErrorFor = null
})

await check('beginLogin 立即返回授权链接（不阻塞等待）', async () => {
  seedTokens()
  const started = Date.now()
  const { url, origin, completion } = await oauth.beginLogin({ timeoutMs: 500, launchBrowser: false })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 3000, `应立刻返回，实际耗时 ${elapsed}ms`)
  assert.match(url, /\/oauth\/consent\?/, `链接应指向授权页：${url}`)
  assert.match(url, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fcallback/, 'redirect_uri 应为本机回调')
  assert.equal(origin, base)
  assert.equal(oauth.authState().pending_authorize_url, url, '待完成的链接应可在 status 中读到')
  await assert.rejects(completion, /授权超时/)
  assert.equal(oauth.authState().pending_authorize_url, undefined, '结束后应清除待完成链接')
})

server.close()
fs.rmSync(home, { recursive: true, force: true })
console.log(`\n${passed}/${passed + failed} 项通过`)
process.exit(failed ? 1 : 0)

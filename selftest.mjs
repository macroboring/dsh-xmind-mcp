#!/usr/bin/env node
// Offline self-test: spawns the bridge exactly the way the Harness does
// (stdio, newline-delimited JSON-RPC) and checks the protocol contract.
// Network-dependent steps are reported as "skipped" instead of failing.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// An isolated credential home keeps this test truly offline: it must never read
// the real tokens or reach the network.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xmind-mcp-selftest-'))
// A cached cloud tool list, including names that collide with the local tools,
// so naming stability can be checked without any network access.
fs.writeFileSync(
  path.join(sandboxHome, 'tools-cache.json'),
  JSON.stringify({
    fetchedAt: Date.now(),
    protocolVersion: '2025-06-18',
    tools: [
      { name: 'xmind_create_mindmap', description: 'create', inputSchema: { type: 'object', properties: {} } },
      { name: 'xmind_list_mindmaps', description: 'list', inputSchema: { type: 'object', properties: {} } },
      { name: 'login', description: 'collides with the local tool', inputSchema: { type: 'object', properties: {} } },
      { name: 'remote_login', description: 'collides with the renamed one', inputSchema: { type: 'object', properties: {} } },
    ],
  }),
  'utf8',
)
const child = spawn(process.execPath, [path.join(here, 'index.mjs')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, XMIND_MCP_DEBUG: '', XMIND_MCP_HOME: sandboxHome },
})

let buffer = ''
const pending = new Map()
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    const entry = pending.get(message.id)
    if (entry) {
      pending.delete(message.id)
      entry(message)
    } else {
      console.log(`  (unsolicited) ${line.slice(0, 200)}`)
    }
  }
})
child.stderr.on('data', (chunk) => {
  if (process.env.XMIND_MCP_VERBOSE) process.stderr.write(`  [bridge] ${chunk}`)
})

let nextId = 1
function rpc(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      if (message.error) resolve({ error: message.error })
      else resolve({ result: message.result })
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)

const checks = []
const check = (label, run) => checks.push({ label, run })

check('initialize 回显受支持的协议版本', async () => {
  const { result } = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } })
  assert.equal(result.protocolVersion, '2025-11-25')
  assert.ok(result.capabilities.tools)
  assert.equal(result.serverInfo.name, 'xmind-mcp')
  assert.ok(result.instructions.includes('我的导图'))
  notify('notifications/initialized')
})

check('未知协议版本回退到 2025-06-18', async () => {
  const { result } = await rpc('initialize', { protocolVersion: '2099-01-01', capabilities: {} })
  assert.equal(result.protocolVersion, '2025-06-18')
})

check('server/discover 返回方法不存在（促使客户端回退到旧版协议）', async () => {
  const { error } = await rpc('server/discover', {})
  assert.equal(error.code, -32601)
})

check('tools/list 至少包含 login/status/logout', async () => {
  const { result } = await rpc('tools/list', {})
  const names = result.tools.map((tool) => tool.name)
  for (const expected of ['login', 'status', 'logout']) assert.ok(names.includes(expected), `缺少 ${expected}`)
  for (const tool of result.tools) assert.ok(tool.inputSchema, `${tool.name} 缺少 inputSchema`)
  console.log(`    工具: ${names.join(', ')}`)
})

check('status 工具返回授权状态', async () => {
  const { result } = await rpc('tools/call', { name: 'status', arguments: {} })
  const text = result.content.map((block) => block.text).join('\n')
  assert.match(text, /授权状态：(已授权|未授权)/)
  console.log(`    ${text.split('\n')[0]}`)
})

check('未知工具返回 isError 而不是伪造成功', async () => {
  const { result } = await rpc('tools/call', { name: 'definitely-not-a-tool', arguments: {} })
  assert.equal(result.isError, true)
})

check('云端工具名在多次同步间保持稳定且唯一', async () => {
  const first = (await rpc('tools/list', {})).result.tools.map((tool) => tool.name)
  const second = (await rpc('tools/list', {})).result.tools.map((tool) => tool.name)
  assert.deepEqual(second, first, '重复同步不得改变公开名')
  assert.ok(first.includes('xmind_create_mindmap'), `云端名应保持原样：${first.join(', ')}`)
  assert.ok(first.includes('remote_login'), '与本地 login 冲突时应加 remote_ 前缀')
  assert.ok(first.includes('remote_remote_login'), '二次冲突应确定性再改名')
  assert.equal(new Set(first).size, first.length, '公开名必须唯一')
})

check('ping 有效', async () => {
  const { result } = await rpc('ping', {})
  assert.deepEqual(result, {})
})

let failed = 0
console.log('Xmind MCP bridge self-test\n')
for (const { label, run } of checks) {
  try {
    await run()
    console.log(`✅ ${label}`)
  } catch (error) {
    failed++
    console.log(`❌ ${label}\n    ${error.message}`)
  }
}

child.stdin.end()
child.kill()
fs.rmSync(sandboxHome, { recursive: true, force: true })
console.log(failed ? `\n${failed}/${checks.length} 项失败` : `\n${checks.length}/${checks.length} 项通过`)
process.exit(failed ? 1 : 0)

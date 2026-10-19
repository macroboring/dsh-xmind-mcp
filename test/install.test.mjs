// Regression tests for install.mjs (the manual fallback installer).
//   node test/install.test.mjs
//
// The point of a distributable plugin is that nothing in it depends on the
// machine it was built on, so these tests assert both the patch shape and the
// total absence of machine-specific paths.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const project = path.resolve(here, '..')
const NODE = process.execPath
const installScript = path.join(project, 'install.mjs')

let YAML = null
if (process.env.DSH_YAML_LIB) {
  try {
    YAML = (await import(pathToFileURL(process.env.DSH_YAML_LIB).href)).default
  } catch (error) {
    console.log(`(提示) 无法加载 ${process.env.DSH_YAML_LIB}：${error.message}`)
  }
}
// The Loader's own tag: `!!js` scalars become expression nodes.
const jsTag = { tag: 'tag:yaml.org,2002:js', resolve: (value) => ({ __jsExpr: value }) }
const parseYaml = (text) => (YAML ? YAML.parse(text, { customTags: [jsTag] }) : null)

const FRESH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

const USER_ENTRY = `- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
`

let passed = 0
let failed = 0
const check = (label, run) => {
  try {
    run()
    console.log(`✅ ${label}`)
    passed++
  } catch (error) {
    console.log(`❌ ${label}\n    ${error.message}`)
    failed++
  }
}

function makeProfile(patchContent, { packageJson = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmind-install-test-'))
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patchContent, 'utf8')
  if (packageJson) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(packageJson), 'utf8')
  return dir
}

function runInstall(dir, args = []) {
  return spawnSync(NODE, [installScript, ...args], {
    env: { ...process.env, DSH_PROFILE_DIR: dir, DSH_PROFILE: 'test', DSH_HOME: path.join(dir, 'home') },
    encoding: 'utf8',
  })
}

const read = (dir) => fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
const hasXmind = (text) => text.includes('xmind-mcp')

/** Parses when a YAML library is available, and always checks the structure. */
function assertValid(dir) {
  const text = read(dir)
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const emptyDocAt = lines.findIndex((line) => line === '[]')
  if (emptyDocAt !== -1) {
    const after = lines.slice(emptyDocAt + 1).filter(Boolean)
    assert.equal(after.length, 0, '"[]" 之后不能再有顶层条目，否则整个 patch 无法解析')
  }
  if (YAML) {
    const parsed = parseYaml(text)
    assert.ok(parsed === null || Array.isArray(parsed), `解析结果应是序列，实际 ${typeof parsed}`)
  }
  return text
}

check('全新 profile（模板以 [] 结尾）安装后仍是合法 YAML', () => {
  const dir = makeProfile(FRESH_TEMPLATE)
  const result = runInstall(dir)
  assert.equal(result.status, 0, `install 退出码 ${result.status}: ${result.stderr}`)
  const text = assertValid(dir)
  assert.ok(hasXmind(text), '应包含 xmind-mcp 条目')
})

check('安装写入的条目不含任何机器相关绝对路径', () => {
  const dir = makeProfile(FRESH_TEMPLATE)
  assert.equal(runInstall(dir).status, 0)
  const text = read(dir)
  // A drive letter or a POSIX root only counts when it starts a path token, so a
  // URL scheme like https:// never trips this.
  const MACHINE_PATH = /(?:^|[\s'"([])(?:[A-Za-z]:[\\/](?!\/)|\/(?:Users|home|root|data|var|opt|tmp)\/)/
  const offending = text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#') && MACHINE_PATH.test(line))
  assert.deepEqual(offending, [], `出现机器路径：\n${offending.join('\n')}`)
  assert.ok(text.includes('!!js'), '应使用 !!js 表达式在加载时解析路径')
  assert.ok(text.includes('dshHomePath'), '应通过 dshHomePath 定位包与 home')
  if (YAML) {
    const parsed = parseYaml(text)
    const row = (parsed || []).find((entry) => entry?.insert?.[0]?.id === 'xmind-mcp')
    assert.ok(row, '应插入 id 为 xmind-mcp 的行')
    const config = row.insert[0].config
    assert.equal(config.serverName, 'xmind')
    assert.equal(config.transport, 'stdio')
    assert.ok(config.command?.__jsExpr, 'command 应是 !!js 表达式')
    assert.ok(config.args?.[0]?.__jsExpr, 'args 应是 !!js 表达式')
    assert.ok(config.env?.XMIND_MCP_HOME?.__jsExpr, 'XMIND_MCP_HOME 应是 !!js 表达式')
  }
})

check('已有用户条目时安装：保留原条目且可重复安装', () => {
  const dir = makeProfile(USER_ENTRY)
  assert.equal(runInstall(dir).status, 0)
  const first = assertValid(dir)
  assert.ok(hasXmind(first), '应包含 xmind-mcp 条目')
  assert.ok(first.includes('ui-chat'), '应保留用户原有条目')
  const again = runInstall(dir)
  assert.equal(again.status, 0)
  assert.match(again.stdout, /已是目标状态/)
  assert.equal(read(dir), first, '重复安装不应改变文件')
})

check('缺少 END 标记时拒绝写入（不截断其它配置）', () => {
  const broken = `${USER_ENTRY}\n\n# >>> dsh-xmind-mcp (手动安装；由 install.mjs 管理) >>>\n- insert:\n    - id: xmind-mcp\n`
  const dir = makeProfile(broken)
  const before = read(dir)
  const result = runInstall(dir)
  assert.notEqual(result.status, 0, '应以非零码退出')
  assert.match(result.stdout + result.stderr, /END 标记/)
  assert.equal(read(dir), before, '文件不得被改动')
})

check('卸载仅含本插件的配置后仍可解析且不再含插件', () => {
  const dir = makeProfile(FRESH_TEMPLATE)
  assert.equal(runInstall(dir).status, 0)
  const result = runInstall(dir, ['--uninstall'])
  assert.equal(result.status, 0, `uninstall 退出码 ${result.status}: ${result.stdout}${result.stderr}`)
  const text = assertValid(dir)
  assert.ok(!hasXmind(text), '不应再含 xmind-mcp 条目')
})

check('卸载时保留其它 profile 设置', () => {
  const dir = makeProfile(USER_ENTRY)
  assert.equal(runInstall(dir).status, 0)
  assert.equal(runInstall(dir, ['--uninstall']).status, 0)
  const text = assertValid(dir)
  assert.ok(text.includes('ui-chat'), '用户条目必须保留')
  assert.ok(!hasXmind(text), '插件条目应被移除')
})

check('已作为组合包安装时不再写手写条目（避免重复注册）', () => {
  const dir = makeProfile(FRESH_TEMPLATE, {
    packageJson: {
      name: 'test-profile',
      dependencies: { 'dsh-xmind-mcp': 'link:./xmind-mcp' },
      dsh: { profile: { bundles: ['dsh-xmind-mcp'] } },
    },
  })
  const before = read(dir)
  const result = runInstall(dir)
  assert.equal(result.status, 0)
  assert.match(result.stdout, /已作为组合包安装/)
  assert.equal(read(dir), before, '文件不得被改动')
})

console.log(`\n${passed}/${passed + failed} 项通过${YAML ? '（已用 DSH 的 YAML 库校验）' : '（未提供 DSH_YAML_LIB，仅做结构校验）'}`)
process.exit(failed ? 1 : 0)

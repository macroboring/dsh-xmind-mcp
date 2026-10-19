#!/usr/bin/env node
// 手动安装兜底：把本包挂到当前 DSH profile 的 patch 层。
//
// 正常安装请用 DSH 的插件管理器（侧栏「插件 → 添加插件」粘贴本包路径，或
// `dsh plugin --profile <name> add <本包>` / 从插件市场安装）。本脚本用于
// **没有插件管理器**的环境（例如给 agent 用的 headless 会话），它做等价的事：
// 把本包 cordis.patch.yml 里的那一行插入 profile 的 cordis.patch.yml。
//
//   node install.mjs              # 安装 / 更新（幂等）
//   node install.mjs --uninstall  # 移除
//   node install.mjs --dry-run    # 只打印将写入的内容
//
// 清单本身不含任何机器相关路径（路径由 Loader 表达式在加载时解析），
// 所以这里不需要、也不会生成任何绝对路径。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const uninstall = args.includes('--uninstall')
const dryRun = args.includes('--dry-run')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROFILE = process.env.DSH_PROFILE || 'desktop'
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || path.join(DSH_HOME, 'profiles', PROFILE)
const PATCH_FILE = path.join(PROFILE_DIR, 'cordis.patch.yml')
const BUNDLE_PATCH = path.join(here, 'cordis.patch.yml')

const START = '# >>> dsh-xmind-mcp (手动安装；由 install.mjs 管理) >>>'
const END = '# <<< dsh-xmind-mcp <<<'

/** 本包是否已作为组合包安装在 profile 里（那就不该再写手写行）。 */
function bundleInstalled() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'package.json'), 'utf8'))
    const names = [...Object.keys(manifest.dependencies || {}), ...(manifest.dsh?.profile?.bundles || [])]
    return names.some((name) => String(name).startsWith('dsh-xmind-mcp'))
  } catch {
    return false
  }
}

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function stripBlock(content) {
  const start = content.indexOf(START)
  if (start === -1) return content
  const end = content.indexOf(END, start)
  if (end === -1) throw new Error(`补丁文件有 START 标记但缺少 END 标记，拒绝改动以免截断其它设置：${PATCH_FILE}`)
  return (content.slice(0, start) + content.slice(end + END.length)).replace(/\n{3,}/g, '\n\n')
}

/** 本包 cordis.patch.yml 是唯一事实来源。 */
function packageRow() {
  const raw = readFile(BUNDLE_PATCH)
  if (raw === null) throw new Error(`缺少本包的组合包补丁：${BUNDLE_PATCH}`)
  // 组合包补丁里 name 是包名，由 loader 从 profile 的 node_modules 解析。
  // 手写进 profile 的路线不保证包被安装到 profile，所以改写成指向本包入口的绝对路径
  // （第三方插件的本地开发也是这么做的）——这是手动兜底路线上唯一需要机器相关的值。
  const entry = path.join(here, 'host', 'index.mjs')
  const quoted = `'${entry.replace(/'/g, "''")}'`
  return raw.replaceAll("name: 'dsh-xmind-mcp'", `name: ${quoted}`).trimEnd()
}

function main() {
  const row = packageRow()
  const block = `${START}\n${row}\n${END}`
  const rawBefore = readFile(PATCH_FILE)
  if (rawBefore === null) throw new Error(`找不到 profile 补丁文件：${PATCH_FILE}`)

  console.log(`profile     : ${PROFILE} (${PROFILE_DIR})`)

  if (bundleInstalled()) {
    console.log('\n本包已作为组合包安装在 profile 里，无需手写条目（否则同一 serverName 会注册两次）。')
    console.log('要换成手动安装，请先在侧栏「插件」里卸载它，再重跑本脚本。')
    return
  }

  const before = stripBlock(rawBefore)
  const body = before.trimEnd()
  const isEmptyDoc = /^\s*(\[\s*\]\s*)?$/.test(body.replace(/^(#[^\n]*\n)+/, ''))

  const finalContent = uninstall
    ? isEmptyDoc
      ? '[]\n'
      : `${body}\n`
    : isEmptyDoc
      ? `${block}\n`
      : `${body}\n\n${block}\n`

  console.log(`patch file  : ${PATCH_FILE}`)
  console.log(`package row : ${BUNDLE_PATCH}`)

  if (finalContent === rawBefore) {
    console.log('\n补丁文件已是目标状态，无需改动。')
    return
  }
  if (dryRun) {
    console.log('\n--- 将写入的内容 ---')
    console.log(finalContent)
    return
  }
  if (!uninstall && !finalContent.trim()) throw new Error('拒绝写入空的补丁文件（会丢失其它 profile 设置）')

  const backup = `${PATCH_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  fs.copyFileSync(PATCH_FILE, backup)
  const tmp = `${PATCH_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, finalContent, 'utf8')
  fs.renameSync(tmp, PATCH_FILE)

  console.log(`备份        : ${backup}`)
  console.log(uninstall ? '\n已从 profile 移除手写条目。' : '\n已写入手写条目（内容与本包组合包补丁一致）。')
  console.log('profile 配置变化会触发 DSH 重载；若未生效请重启 DeepSeek Harness。')
  if (!uninstall) {
    console.log('\n首次使用还需要在浏览器完成一次 Xmind 授权：')
    console.log(`  node "${path.join(here, 'cli.mjs')}" login cn`)
  }
}

try {
  main()
} catch (error) {
  console.error(`失败：${error.message}`)
  process.exit(1)
}

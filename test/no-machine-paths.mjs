// 发布前守卫：包内不得出现「构建它的那台机器」的路径。
//   node test/no-machine-paths.mjs
//
// 这是本包最核心的承诺（装上即用、换机器不用改清单），所以单独成一个可独立运行的检查：
// CI 用它、本地 `npm test` 也用它。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

// 只在「路径开头」的位置判定，这样 https:// 之类的 URL 不会误伤。
const MACHINE_PATH = /(?:^|[\s'"([])(?:[A-Za-z]:[\\/](?!\/)|\/(?:Users|home|root|data|var|opt|tmp)\/)/

const SCAN = ['cordis.patch.yml', 'index.mjs', 'cli.mjs', 'install.mjs', 'selftest.mjs', 'package.json', 'lib', 'locale', 'test']
const SKIP_DIRS = new Set(['node_modules', '.git'])
const TEXT_EXT = new Set(['.mjs', '.js', '.json', '.yml', '.yaml'])

function* walk(target) {
  const absolute = path.join(root, target)
  if (!fs.existsSync(absolute)) return
  const stat = fs.statSync(absolute)
  if (stat.isFile()) {
    yield target
    return
  }
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const relative = path.join(target, entry.name)
    if (entry.isDirectory()) yield* walk(relative)
    else if (TEXT_EXT.has(path.extname(entry.name))) yield relative
  }
}

const findings = []
for (const target of SCAN) {
  for (const relative of walk(target)) {
    const lines = fs.readFileSync(path.join(root, relative), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      if (line.trim().startsWith('#')) continue
      if (MACHINE_PATH.test(line)) findings.push(`${relative}:${index + 1}: ${line.trim()}`)
    }
  }
}

// 本文件自身会提到这些模式，跳过自身。
const real = findings.filter((finding) => !finding.startsWith('test/no-machine-paths.mjs'))

if (real.length > 0) {
  console.error('❌ 包内出现机器相关绝对路径：')
  for (const finding of real) console.error(`   ${finding}`)
  console.error('\n发布包里不能带「构建它的那台机器」的路径。请改用 !!js 表达式或相对路径。')
  process.exit(1)
}

console.log('✅ 未发现机器相关绝对路径')

// Persistent state + logging for the Xmind MCP bridge.
// Everything lives under $DSH_HOME/xmind-mcp (default ~/.dsh/xmind-mcp).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_HOME = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'xmind-mcp')

export const HOME = process.env.XMIND_MCP_HOME || DEFAULT_HOME
const CLIENT_FILE = path.join(HOME, 'client.json')
const TOKENS_FILE = path.join(HOME, 'tokens.json')
const TOOLS_FILE = path.join(HOME, 'tools-cache.json')
const SETTINGS_FILE = path.join(HOME, 'settings.json')
const LOG_FILE = path.join(HOME, 'bridge.log')
const MAX_LOG_BYTES = 512 * 1024

export const DEBUG = /^(1|true|yes)$/i.test(process.env.XMIND_MCP_DEBUG || '')

function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true })
}

function readJson(file) {
  try {
    // A UTF-8 BOM is common when these files are edited by hand on Windows.
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    if (fs.existsSync(file)) {
      process.stderr.write(`xmind-mcp: cannot read ${file}: ${error.message}\n`)
    }
    return null
  }
}

function writeJson(file, value) {
  ensureHome()
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort on Windows */
  }
}

/** Append a line to the bridge log, rotating once past MAX_LOG_BYTES. Never throws. */
export function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`
  // stderr is safe: DSH's stdio transport only parses stdout.
  if (DEBUG || level === 'error' || level === 'warn') process.stderr.write(`xmind-mcp: ${line}\n`)
  try {
    ensureHome()
    try {
      if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8')
  } catch {
    /* logging must never break the bridge */
  }
}

export const store = {
  home: HOME,
  logFile: LOG_FILE,

  getClient: () => readJson(CLIENT_FILE),
  saveClient: (client) => writeJson(CLIENT_FILE, client),
  clearClient: () => {
    try {
      fs.rmSync(CLIENT_FILE)
    } catch {
      /* already gone */
    }
  },

  getTokens: () => readJson(TOKENS_FILE),
  saveTokens: (tokens) => writeJson(TOKENS_FILE, tokens),
  clearTokens: () => {
    try {
      fs.rmSync(TOKENS_FILE)
    } catch {
      /* already gone */
    }
  },

  getToolsCache: () => readJson(TOOLS_FILE),
  saveToolsCache: (cache) => writeJson(TOOLS_FILE, cache),

  // Non-secret preferences. The Xmind deployment in use lives here so a running
  // bridge picks up a site switch without being restarted.
  getSettings: () => readJson(SETTINGS_FILE) || {},
  saveSettings: (settings) => writeJson(SETTINGS_FILE, settings),
}

// OAuth 2.1 (authorization code + PKCE, public client) against Xmind's own
// authorization server, discovered from its published metadata. Xmind supports
// dynamic client registration, so no client id has to be shipped.
//
// Xmind runs two independent deployments with separate accounts:
//   app.xmind.cn  — 中国大陆站，支持手机号登录
//   app.xmind.com — 国际站，邮箱登录
// Each has its own authorization server, client registrations and tokens, so the
// deployment in use is part of the stored credentials and can be switched.
import crypto from 'node:crypto'
import http from 'node:http'
import { log, store } from './store.mjs'

export const ORIGINS = {
  cn: 'https://app.xmind.cn',
  global: 'https://app.xmind.com',
}
/** Default deployment; override with XMIND_MCP_ORIGIN or `cli.mjs login <origin>`. */
export const DEFAULT_ORIGIN = process.env.XMIND_MCP_ORIGIN || ORIGINS.cn
export const SCOPE = 'mcp:connect'
export const DEFAULT_CALLBACK_PORT = 8770

export const originToMcpUrl = (origin) => `${origin}/api/mcp`

/**
 * Accept `cn`, `global`, or one of the two known deployment origins.
 * Deliberately an allowlist: the origin decides where credentials are sent and
 * which URL is handed to the browser, so an arbitrary host is never accepted.
 */
export function normalizeOrigin(value) {
  if (!value) return null
  const key = String(value).trim().toLowerCase()
  if (ORIGINS[key]) return ORIGINS[key]
  const normalized = key.replace(/\/+$/, '')
  for (const known of Object.values(ORIGINS)) if (normalized === known) return known
  throw new Error(`无法识别的站点 "${value}"；只支持 cn（中国大陆站）或 global（国际站）`)
}

/**
 * The deployment in use right now: stored setting, else env/default.
 * A stored value that is not a known deployment (a hand-edited settings.json, or
 * a removed deployment) falls back instead of breaking every call.
 */
export function resolveOrigin() {
  const stored = store.getSettings().origin
  if (!stored) return DEFAULT_ORIGIN
  try {
    return normalizeOrigin(stored)
  } catch {
    log('warn', `stored origin "${stored}" is not a known deployment; falling back to ${DEFAULT_ORIGIN}`)
    return DEFAULT_ORIGIN
  }
}

export function setOrigin(origin) {
  const normalized = normalizeOrigin(origin)
  store.saveSettings({ ...store.getSettings(), origin: normalized })
  log('info', `Xmind deployment set to ${normalized}`)
  return normalized
}

export const mcpUrl = (origin = resolveOrigin()) => originToMcpUrl(origin)

/** Raised when the bridge has no usable token and the user must (re-)authorize. */
export class NotAuthorizedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NotAuthorizedError'
  }
}

const b64url = (buf) => buf.toString('base64url')

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const detail = body ? JSON.stringify(body) : text.slice(0, 400)
    throw new Error(`${init?.method || 'GET'} ${url} -> ${res.status} ${res.statusText}: ${detail}`)
  }
  return body
}

/** Fetch (and cache) the authorization-server metadata document for `origin`. */
export async function discover(origin = resolveOrigin()) {
  const cached = store.getClient()
  const fresh =
    cached?.origin === origin && Date.now() - (cached?.metadata?.fetchedAt || 0) < 6 * 60 * 60 * 1000
  if (fresh) return cached.metadata

  const metadata = await getJson(`${origin}/.well-known/oauth-authorization-server`)
  if (!metadata?.authorization_endpoint || !metadata?.token_endpoint) {
    throw new Error(`Xmind OAuth metadata is incomplete: ${JSON.stringify(metadata)}`)
  }
  return metadata
}

function tryListen(port) {
  return new Promise((resolve) => {
    const server = http.createServer()
    server.once('error', () => resolve(null))
    server.listen(port, '127.0.0.1', () => {
      const { port: bound } = server.address()
      server.close(() => resolve(bound))
    })
  })
}

async function pickPort() {
  return (await tryListen(DEFAULT_CALLBACK_PORT)) ?? (await tryListen(0))
}

/**
 * Register (or reuse) a public OAuth client bound to `redirectUri`.
 * Registrations are per deployment; a client from the other site is replaced.
 * Tokens belong to the deployment, not to a client, so re-registering never
 * discards them — only an actual site switch invalidates them.
 */
export async function ensureClient(metadata, redirectUri, origin = resolveOrigin()) {
  const existing = store.getClient()
  if (
    existing?.client_id &&
    existing.origin === origin &&
    (existing.redirect_uris || []).includes(redirectUri)
  ) {
    return { ...existing, metadata: { ...metadata, fetchedAt: Date.now() } }
  }
  const registered = await getJson(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'DeepSeek Harness — Xmind',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    }),
  })
  if (!registered?.client_id) {
    throw new Error(`Dynamic client registration returned no client_id: ${JSON.stringify(registered)}`)
  }
  const client = {
    origin,
    client_id: registered.client_id,
    client_secret: registered.client_secret,
    redirect_uris: registered.redirect_uris || [redirectUri],
    issued_at: registered.client_id_issued_at || Math.floor(Date.now() / 1000),
    metadata: { ...metadata, fetchedAt: Date.now() },
  }
  store.saveClient(client)
  if (existing?.origin && existing.origin !== origin) {
    // Stored tokens were issued by the other deployment and cannot be reused.
    store.clearTokens()
  }
  log('info', `registered OAuth client ${client.client_id} on ${origin} for ${redirectUri}`)
  return client
}

async function openInBrowser(url) {
  // 端侧（如 HarmonyOS/DSHM）禁止 fork/exec，甚至可能没有 child_process 模块。
  // 所以惰性加载，并在任何失败下安静降级：调用方总会把链接返回给用户手动打开。
  let spawn
  try {
    ;({ spawn } = await import('node:child_process'))
  } catch (error) {
    log('warn', `child_process unavailable (${error.message}); open the link manually`)
    return false
  }
  try {
    if (process.platform === 'win32') {
      // Deliberately not `cmd /c start`: cmd re-parses `&` inside the URL.
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch (error) {
    log('warn', `could not open browser automatically: ${error.message}`)
    return false
  }
}
const PAGE = (title, detail) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${title}</title><style>
 body{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#0f1115;color:#e8eaf0;
 display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
 .card{max-width:34rem;padding:2.5rem 3rem;border-radius:16px;background:#181b22;border:1px solid #2a2f3a;text-align:center}
 h1{font-size:1.35rem;margin:0 0 .75rem} p{color:#9aa3b2;line-height:1.7;margin:0}
</style></head><body><div class="card"><h1>${title}</h1><p>${detail}</p></div></body></html>`

/** Listen for the OAuth redirect and hand back the authorization code. */
function waitForCallback({ port, redirectUri, state, timeoutMs, authorizeUrl, onUrl, launchBrowser }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      fn(value)
    }
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, redirectUri)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const returnedState = url.searchParams.get('state')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (error) {
        res.end(PAGE('授权失败', `Xmind 返回：${error} ${url.searchParams.get('error_description') || ''}`))
        finish(reject, new NotAuthorizedError(`授权被拒绝：${error}`))
        return
      }
      if (returnedState !== state) {
        res.end(PAGE('授权失败', 'state 校验失败，请重试。'))
        finish(reject, new NotAuthorizedError('OAuth state mismatch'))
        return
      }
      res.end(PAGE('授权成功', '可以关闭此页面，回到 DeepSeek Harness 继续。'))
      finish(resolve, url.searchParams.get('code'))
    })
    const timer = setTimeout(
      () =>
        finish(
          reject,
          new NotAuthorizedError(
            `授权超时（${Math.round(timeoutMs / 1000)} 秒内未完成）。授权链接：${authorizeUrl}`,
          ),
        ),
      timeoutMs,
    )
    server.on('error', (error) => finish(reject, error))
    server.listen(port, '127.0.0.1', () => {
      log('info', `authorize url (${redirectUri}): ${authorizeUrl}`)
      if (onUrl) onUrl(authorizeUrl)
      if (launchBrowser) { openInBrowser(authorizeUrl).then((opened) => { if (!opened) log('warn', 'browser did not open; use the logged URL') }) }
    })
  })
}

/**
 * Start the interactive authorization flow and return immediately with the URL
 * the user has to open — waiting is left to `completion`, so a caller (an MCP
 * tool call, say) can hand the link over before any timeout can hit it.
 */
export async function beginLogin({ timeoutMs = 600000, onUrl, origin, launchBrowser = true } = {}) {
  const site = origin ? setOrigin(origin) : resolveOrigin()
  const metadata = await discover(site)
  const port = await pickPort()
  const redirectUri = `http://127.0.0.1:${port}/callback`
  const client = await ensureClient(metadata, redirectUri, site)
  const { verifier, challenge } = pkcePair()
  const state = b64url(crypto.randomBytes(16))

  const authorizeUrl = new URL(metadata.authorization_endpoint)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', client.client_id)
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('scope', SCOPE)
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('code_challenge', challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')
  authorizeUrl.searchParams.set('resource', mcpUrl(site))
  const url = authorizeUrl.toString()

  const completion = (async () => {
    const code = await waitForCallback({
      port,
      redirectUri,
      state,
      timeoutMs,
      authorizeUrl: url,
      onUrl,
      launchBrowser,
    })
    return exchangeCode(metadata, client, { code, redirectUri, verifier, site })
  })().finally(() => {
    const settings = store.getSettings()
    delete settings.pendingAuthorizeUrl
    delete settings.pendingSince
    settings.origin = site
    store.saveSettings(settings)
  })
  // A caller that only wants the URL must not crash the process on a later failure.
  completion.catch(() => {})

  store.saveSettings({
    ...store.getSettings(),
    origin: site,
    pendingAuthorizeUrl: url,
    pendingSince: Date.now(),
  })
  return { url, origin: site, completion }
}

/** Begin the flow and wait for it to finish. */
export async function login(options) {
  const { completion } = await beginLogin(options)
  return completion
}

async function postToken(metadata, form) {
  const res = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* keep raw text for the error message */
  }
  if (!res.ok) {
    const message = `令牌端点返回 ${res.status}：${body ? JSON.stringify(body) : text.slice(0, 300)}`
    // 4xx means the grant itself was rejected; 5xx and network faults are transient.
    if (res.status >= 400 && res.status < 500) throw new NotAuthorizedError(message)
    throw new Error(message)
  }
  return body
}

async function exchangeCode(metadata, client, { code, redirectUri, verifier, site }) {
  const body = await postToken(metadata, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: mcpUrl(site),
  })
  return saveTokenResponse(body, site)
}

function saveTokenResponse(body, origin) {
  if (!body?.access_token) throw new NotAuthorizedError(`令牌响应缺少 access_token：${JSON.stringify(body)}`)
  const tokens = {
    origin,
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_type: body.token_type || 'Bearer',
    scope: body.scope,
    expires_at: body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : null,
    obtained_at: Date.now(),
  }
  store.saveTokens(tokens)
  return tokens
}

// One refresh at a time per deployment: two callers (or DSH's probe sibling and
// the serving process) sharing a rotating refresh token would otherwise race and
// invalidate each other.
let refreshInFlight = null

async function refreshTokens(origin, used) {
  const metadata = await discover(origin)
  const client = store.getClient()
  if (!metadata?.token_endpoint || !client?.client_id || client.origin !== origin) {
    throw new NotAuthorizedError('缺少客户端注册信息：请重新调用 login 授权')
  }
  try {
    const body = await postToken(metadata, {
      grant_type: 'refresh_token',
      refresh_token: used.refresh_token,
      client_id: client.client_id,
      resource: mcpUrl(origin),
    })
    const next = saveTokenResponse({ refresh_token: used.refresh_token, ...body }, origin)
    log('info', 'refreshed Xmind access token')
    return next.access_token
  } catch (error) {
    // Another process may have rotated the refresh token while this attempt failed.
    const latest = store.getTokens()
    if (latest?.refresh_token && latest.refresh_token !== used.refresh_token) {
      log('warn', 'refresh token was rotated by another process; retrying with the newer one')
      return refreshTokens(origin, latest)
    }
    if (error instanceof NotAuthorizedError) {
      store.clearTokens()
      throw new NotAuthorizedError(`刷新令牌被拒绝（${error.message}）：请重新调用 login 授权`)
    }
    // Transient: keep the credentials so the next call can retry.
    throw new Error(`刷新 Xmind 令牌失败（网络或服务端问题，凭据已保留）：${error.message}`)
  }
}

/**
 * Return a valid access token. `force` refreshes even when the stored expiry
 * still looks fine — used when the MCP endpoint rejects a token with 401.
 */
export async function accessToken({ skewMs = 60000, force = false } = {}) {
  const origin = resolveOrigin()
  const tokens = store.getTokens()
  if (!tokens?.access_token) {
    throw new NotAuthorizedError(`尚未授权 Xmind：请先调用 login 工具完成授权（站点 ${origin}）`)
  }
  if (tokens.origin && tokens.origin !== origin) {
    throw new NotAuthorizedError(
      `保存的令牌属于 ${tokens.origin}，当前站点是 ${origin}：请重新调用 login 授权`,
    )
  }

  const expired = tokens.expires_at ? tokens.expires_at - skewMs <= Date.now() : false
  // An unknown expiry is used as-is; a rejection from the endpoint forces a refresh.
  if (!force && !expired) return tokens.access_token

  if (!tokens.refresh_token) {
    if (expired) store.clearTokens()
    throw new NotAuthorizedError(
      force
        ? 'Xmind 拒绝了当前令牌，且本机没有刷新令牌：请重新调用 login 授权'
        : 'Xmind 访问令牌已过期且没有刷新令牌：请重新调用 login 授权',
    )
  }

  if (!refreshInFlight || refreshInFlight.origin !== origin) {
    const promise = refreshTokens(origin, tokens).finally(() => {
      if (refreshInFlight?.promise === promise) refreshInFlight = null
    })
    refreshInFlight = { origin, promise }
  }
  return refreshInFlight.promise
}

/** Human-readable authorization state, used by the `status` tool. */
export function authState() {
  const origin = resolveOrigin()
  const tokens = store.getTokens()
  const client = store.getClient()
  const settings = store.getSettings()
  const base = {
    origin,
    mcp_url: mcpUrl(origin),
    home: store.home,
    client_id: client?.origin === origin ? client.client_id : null,
  }
  if (settings.pendingAuthorizeUrl) {
    base.pending_authorize_url = settings.pendingAuthorizeUrl
    base.pending_since = settings.pendingSince ? new Date(settings.pendingSince).toISOString() : null
  }
  if (!tokens?.access_token) return { ...base, authorized: false, reason: 'no-token' }
  const expired = tokens.expires_at ? tokens.expires_at <= Date.now() : false
  return {
    ...base,
    authorized: !expired || Boolean(tokens.refresh_token),
    expired,
    token_origin: tokens.origin ?? null,
    origin_matches: !tokens.origin || tokens.origin === origin,
    has_refresh_token: Boolean(tokens.refresh_token),
    expires_at: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null,
    scope: tokens.scope ?? null,
  }
}

export function logout() {
  const settings = store.getSettings()
  delete settings.pendingAuthorizeUrl
  delete settings.pendingSince
  store.saveSettings(settings)
  store.clearTokens()
  log('info', 'tokens cleared')
}

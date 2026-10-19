# dsh-xmind-mcp

Connect **Xmind cloud mind maps** ("我的导图") to DeepSeek Harness: list, read, create and rewrite your
Xmind maps from natural language.

Installing it adds **35 `mcp__xmind__*` tools** to the agent's toolset — `xmind_create_mindmap`,
`xmind_read_mindmap`, `xmind_edit_mindmap`, `xmind_show_mindmap`, folder/space management, topic
styles, relationships, boundaries, summaries, to-dos, Gantt scheduling, multi-sheet files — plus three
local tools: `login`, `status`, `logout`.

- **Zero dependencies** — nothing to `npm install` (`@deepseek-ai/dsh-mcp-client` ships with DSH).
- **No machine-specific paths** in the bundle — the same package runs on any machine and any profile.
- **OAuth stays local** — dynamic client registration + PKCE; tokens are stored on this machine and
  refreshed automatically. Nothing passes through a third-party server.

> 中文文档：[README.zh.md](README.zh.md)

---

## 1. Why the manifest contains no absolute paths

A stdio MCP plugin usually has to hard-code the absolute path of the Node binary and of its entry
script, which breaks on the next machine. This package computes both **at load time** with Loader
expressions, so one manifest works everywhere:

```yaml
command: !!js process.env.XMIND_MCP_NODE || process.execPath
args:
  - !!js process.env.XMIND_MCP_ENTRY || dshHomePath('profiles', ctx.get('profileContext').name, 'node_modules', 'dsh-xmind-mcp', 'index.mjs')
env:
  ELECTRON_RUN_AS_NODE: '1'          # the host binary acts as Node under Electron — same trick dsh.cmd uses
  XMIND_MCP_HOME: !!js dshHomePath('xmind-mcp')
```

Escape hatches for non-standard layouts: `XMIND_MCP_NODE` and `XMIND_MCP_ENTRY`.

## 2. Install

**Plugin manager / market (recommended)**

- Sidebar **Plugins → Add plugin**, paste this package's **absolute local path** or a git URL; restart DSH.
- After publishing to npm: `dsh plugin --profile <profile> add dsh-xmind-mcp`.
- Once listed on the plugin market: one-click install from **Settings → Plugin Market**.

**Manual fallback** (for environments without the plugin manager, e.g. headless/agent sessions):

```bash
node install.mjs              # insert the same row into the profile patch
node install.mjs --uninstall
node install.mjs --dry-run
```

> Pick one route only. If the package is already installed as a bundle, `install.mjs` refuses to add a
> second hand-written row (two rows with the same `serverName` make the later one fail to load).

## 3. Authorize once

Xmind runs two independent deployments with separate accounts:

| Site | Sign-in | Argument |
|---|---|---|
| `https://app.xmind.cn` | phone number (China) | `cn` (default) |
| `https://app.xmind.com` | email (international) | `global` |

```bash
node cli.mjs login cn
node cli.mjs login global
```

Or ask the agent to call `mcp__xmind__login`: it returns the authorization URL **immediately** (and
tries to open a browser), then finishes in the background, so an interrupted tool call does not lose
the flow.

### Troubleshooting the consent page

| Symptom | Cause / fix |
|---|---|
| `client_id is required` | The link lost its query string (stale tab / truncated). Run `login` again. |
| `Authenticated xmind user required` ("需要用户 id") | No session for that site in this browser. Sign in first at `https://app.xmind.cn`, then open the link; if a login dialog still appears, **press F5 after signing in**. |
| Only email sign-in offered | You opened the international site; phone accounts use `cn`. |
| Browser did not open | Expected on headless devices; copy the printed URL. The callback is `127.0.0.1:8770`, reachable whenever bridge and browser are on the same machine. |

Credentials live in `$DSH_HOME/xmind-mcp/`: `client.json`, `tokens.json` (atomic write, mode 0600),
`settings.json`, `tools-cache.json`, `bridge.log`.

## 4. Examples

- "List my recent Xmind maps"
- "Turn this week's meeting notes into a mind map and save it to My Maps"
- "Read 《读书笔记》 and summarize it as Markdown"
- "Add two branches to 《虚拟语气》: subjunctive conditionals, inversion"

Creating or editing does not display the map; `xmind_show_mindmap` is what puts it in front of the user.

## 5. Diagnostics and tests

```bash
node cli.mjs doctor     # endpoints → client → token → MCP handshake → tool discovery
node cli.mjs status
node cli.mjs site cn    # show or switch the deployment
node cli.mjs tools
node cli.mjs call <tool> '{"k":"v"}'
node cli.mjs raw <method> '{}'
node cli.mjs logout
```

```bash
npm test                        # all three suites, offline
node selftest.mjs               # protocol contract (8)
node test/refresh.test.mjs      # token refresh / 401 retry / authorize URL (6)
node test/install.test.mjs      # install + uninstall + "no machine paths" regression (7)
```

Set `XMIND_MCP_DEBUG=1` to log full request/response bodies (credentials are never logged).
Log file: `$DSH_HOME/xmind-mcp/bridge.log`.

## 6. Known limitations

- **Permissions are Xmind's**: what you can read/create/edit depends on your plan; some operations spend Xmind credits.
- **Slow calls**: authoring is server-side and typically takes 30–120 s (the bridge allows 4 minutes).
- **Interactive authorization**: someone has to click approve in a browser that is signed in.
- **Switching sites invalidates tokens**: `.cn` and `.com` tokens are not interchangeable.
- **Tool list comes from the cloud**: it is discovered and cached, never hard-coded — it went from 32 to 35 tools with no change here.
- **Floating topics are read-only**: the official MCP surface cannot create them; drag a topic onto empty canvas in Xmind instead.
- **Editing an existing map requires the `<!--t:...-->` anchors**: they are what preserves notes, markers and images.
- **`link:` installs depend on this directory**: don't move it after adding it from a local path.

## 7. Layout

```
dsh-xmind-mcp/
├── cordis.patch.yml   portable bundle patch (no absolute paths)
├── index.mjs          stdio MCP server: protocol, tool dispatch, naming, cache
├── cli.mjs            login / diagnostics / direct tool calls
├── install.mjs        manual fallback installer
├── lib/               oauth.mjs · remote.mjs · store.mjs
├── locale/            card title + description (en / zh)
├── test/              offline test suites
└── PUBLISHING.md      npm / market publishing steps
```

## 8. Uninstall

```bash
node install.mjs --uninstall   # if installed the manual way
node cli.mjs logout            # clear local tokens
```

If installed through the plugin manager, remove it from the sidebar **Plugins** page.

## 9. Privacy

This plugin only talks to `app.xmind.cn` / `app.xmind.com`. Tokens stay on this machine; there is no
telemetry and no third-party relay. It is an independent open-source plugin, **not affiliated with
Xmind**. See [PROVENANCE.md](PROVENANCE.md) and [LICENSE](LICENSE) (MIT).

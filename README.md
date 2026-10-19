# dsh-xmind-mcp

Connect **Xmind cloud mind maps** ("我的导图") to DeepSeek Harness: list, read, create and rewrite your
Xmind maps from natural language.

**Since v3 the plugin runs entirely in-process**: it spawns no child process and needs no `node`
executable, so it also works on on-device hosts that **forbid fork/exec** (e.g. DSHM on HarmonyOS).

- **35 cloud tools** + 3 local tools, all registered as **native dsh tools** (`xmind_list_mindmaps`,
  not `mcp__xmind__*`)
- **Zero runtime dependencies**: Node built-ins plus the global `fetch` only
- **No machine paths in the bundle**: the patch inserts `name: 'dsh-xmind-mcp'` (a package name the
  loader resolves from the profile's `node_modules`)
- **OAuth stays local**: dynamic client registration + PKCE; tokens are stored on this machine and
  refreshed automatically; nothing passes through a third-party server
- **Diagnosable failures**: activation never throws; registration, sync and authorization failures are
  written to `$DSH_HOME/xmind-mcp/bridge.log`

> 中文文档：[README.zh.md](README.zh.md)

---

## 1. Why in-process

A stdio MCP server needs the host to spawn a child process (usually `command: process.execPath` with
`ELECTRON_RUN_AS_NODE=1`). An on-device host is **not Electron**, ships **no `node` executable**, and
**forbids fork/exec**, so the spawn always fails with `mcp-client(xmind): server is disconnected` and
the bridge never runs at all.

This plugin instead follows option B of the on-device problem report:

```
DSH agent ──native tool call──> host/index.mjs (inside the host process) ──HTTPS+Bearer──> app.xmind.cn/api/mcp
                                        │
                                        └── OAuth 2.1: dynamic registration + PKCE + 127.0.0.1:8770 callback
```

- `host/index.mjs` exports `apply(ctx)` and registers tools through `ctx.tools.register`
  (`parameters` is the full JSON Schema supplied by the cloud; if the host rejects it, a permissive
  schema is retried once);
- cloud tools register **dynamically** once authorization succeeds — no restart needed;
- `execute(args, exec)` forwards `exec.signal` to the remote request, so long calls can be cancelled;
- `tools/call` is **not idempotent**, so only read-only methods retry (a 401 forces one token refresh
  plus one retry).

## 2. Tools

Local:

| Tool | Purpose |
|---|---|
| `xmind_login` | Returns the authorize URL **immediately**; `origin` = `cn` (default, phone) or `global` (email) |
| `xmind_status` | Auth state, site, token expiry, credential directory, registered cloud tool count |
| `xmind_logout` | Clears local tokens |

Cloud (35, discovered dynamically): `xmind_create_mindmap`, `xmind_read_mindmap`, `xmind_edit_mindmap`,
`xmind_show_mindmap`, `xmind_list_mindmaps`, `xmind_list_spaces`, `xmind_list_folders`,
`xmind_create_folder`, `xmind_move_file`, `xmind_rename_file`, `xmind_rename_folder`, `xmind_trash_file`,
`xmind_restore_file`, `xmind_list_teammates`, `xmind_get_topic`, `xmind_set_topic_attrs`,
`xmind_set_topic_image`, `xmind_add_relationship`, `xmind_add_boundary`, `xmind_remove_topic`,
`xmind_remove_annotation`, `xmind_update_relationship`, `xmind_add_summary`, `xmind_add_topic_link`,
`xmind_set_todo`, `xmind_set_planned_task`, `xmind_clear_task`, `xmind_list_sheets`,
`xmind_list_resources`, `xmind_add_sheet`, `xmind_set_structure`, `xmind_set_color_theme`,
`xmind_set_topic_style`, `xmind_whoami`, `xmind_get_mindmap_guide`.

## 3. Install

**Plugin manager / market (recommended)**: sidebar **Plugins → Add plugin**, paste this package's path
or a git URL; or

```powershell
dsh plugin --profile <profile> add dsh-xmind-mcp
# pinned: dsh plugin --profile <profile> add github:macroboring/dsh-xmind-mcp#<commit>
```

> **Restart DSH after upgrading**: the row changes from an "MCP client row" to "the plugin's own row",
> and only a restart recomposes it.

**Manual fallback** (no plugin manager):

```powershell
node install.mjs              # writes one row into the profile patch (skipped if already installed as a bundle)
node install.mjs --uninstall
node install.mjs --dry-run
```

## 4. Authorize once

Xmind runs two independent deployments with separate accounts: `app.xmind.cn` (phone, `cn`) and
`app.xmind.com` (email, `global`).

Ask the agent to call **`xmind_login`** (optionally with `origin: cn`); it returns the link immediately.
Then, on the same device:

1. open the link in a browser;
2. that browser must already be signed in to the matching site (otherwise the consent page only offers
   email sign-in and phone accounts get stuck);
3. approve, wait for "授权成功", close the tab;
4. check `xmind_status`; cloud tools appear automatically.

### Consent-page troubleshooting

| Symptom | Cause / fix |
|---|---|
| `client_id is required` | The link lost its query string (stale tab / truncated). Call `xmind_login` again. |
| `Authenticated xmind user required` ("需要用户 id") | No session for that site. Sign in first, then reopen the link; if a login dialog still appears, **press F5 after signing in**. |
| Only email sign-in offered | You opened the international site; phone accounts use `cn`. |
| Browser did not open | Expected, especially on-device. Copy the URL from `xmind_login`; the callback is `127.0.0.1:8770`, reachable whenever browser and host share the machine. |

Credentials live in `$DSH_HOME/xmind-mcp/`: `client.json`, `tokens.json` (atomic write, mode 0600),
`settings.json`, `tools-cache.json`, `bridge.log`.

Desktop diagnostics CLI (on-device you can use the same-named tools instead):

```powershell
node cli.mjs doctor
node cli.mjs login cn
node cli.mjs status / tools / call / raw / site / logout
```

## 5. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `XMIND_MCP_ORIGIN` | `https://app.xmind.cn` | Site; international is `https://app.xmind.com` |
| `XMIND_MCP_TIMEOUT_MS` | `240000` | Per-call timeout for cloud tools (authoring takes 30–120 s) |
| `XMIND_MCP_HOME` | `<DSH_HOME>/xmind-mcp` | Credential and log directory |
| `XMIND_MCP_NO_BROWSER` | unset | Set to `1` to skip launching a browser |

## 6. Tests

All offline, no account, no network, **no child processes**:

```powershell
npm test                          # all four suites
node test/refresh.test.mjs        # token refresh / 401 retry / authorize URL (6)
node test/host-plugin.test.mjs    # in-process plugin + on-device acceptance criteria (7)
node test/install.test.mjs        # install / uninstall (7)
node test/no-machine-paths.mjs    # release guard: no machine paths in the package
```

## 7. Known limitations

- **Permissions are Xmind's**: what you can read/create/edit depends on your plan; some operations spend credits.
- **Interactive authorization**: someone has to approve in a signed-in browser.
- **Switching sites invalidates tokens**: `.cn` and `.com` are not interchangeable.
- **The tool list comes from the cloud**: it is synced dynamically (it grew from 32 to 35 tools with no
  change here).
- **Floating topics are read-only**: the official MCP surface cannot create them; drag a topic onto the
  canvas in Xmind instead.
- **Editing an existing map requires the `<!--t:...-->` anchors**: they preserve notes, markers and images.
- **`link:` installs depend on this directory**: don't move it after installing from a local path.

## 8. Layout

```
dsh-xmind-mcp/
├── cordis.patch.yml   bundle patch (inserts the plugin itself; name = package name, no machine paths)
├── host/index.mjs     in-process host plugin: ctx.tools.register + OAuth + remote MCP calls
├── lib/               oauth.mjs · remote.mjs · store.mjs
├── cli.mjs            login / diagnostics / direct tool calls
├── install.mjs        manual fallback installer
├── locale/            card title + description (en / zh)
├── test/              offline suites
└── CHANGELOG.md       versions and migration notes
```

## 9. Privacy

Talks only to `app.xmind.cn` / `app.xmind.com`. Tokens stay on this machine; no telemetry and no
third-party relay. Independent open-source plugin, **not affiliated with Xmind**. See
[PROVENANCE.md](PROVENANCE.md) and [LICENSE](LICENSE) (MIT).

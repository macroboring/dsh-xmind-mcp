# dsh-xmind-mcp

把 **Xmind 云端「我的导图」** 接进 DeepSeek Harness：用自然语言列出、读取、新建、改写你的 Xmind 导图。

**v3 起完全进程内运行**：不 spawn 子进程、不需要 `node` 可执行文件，因此在**禁止 fork/exec 的端侧宿主**
（HarmonyOS 上的 DSHM 等）同样可用。

- **35 个云端工具** + 3 个本地工具，全部是**原生 dsh 工具**（名字形如 `xmind_list_mindmaps`，不再是 `mcp__xmind__*`）
- **零运行时依赖**：只用 `node:` 内置模块与全局 `fetch`
- **清单无机器路径**：补丁里 `name: 'dsh-xmind-mcp'` 是包名，由 loader 从 profile 的 `node_modules` 解析
- **OAuth 在本机完成**：动态客户端注册 + PKCE，令牌存本机并自动续期；不经过任何第三方服务器
- **失败可诊断**：激活期间绝不 throw，注册/同步/授权失败都写进 `$DSH_HOME/xmind-mcp/bridge.log`

> 中文文档就是本文件；English: [README.md](README.md)。

---

## 1. 为什么是「进程内」

stdio 型 MCP 服务器要靠宿主 spawn 一个子进程（通常 `command: process.execPath` + `ELECTRON_RUN_AS_NODE=1`）。
端侧宿主**不是 Electron**、**没有 node 可执行文件**、且**平台禁止 fork/exec**，spawn 必然失败，表现为
`mcp-client(xmind): server is disconnected`，而桥一次都不会被执行。

本插件的做法（对应端侧问题报告的方案 B）：

```
DSH Agent ──原生工具调用──> host/index.mjs（宿主进程内） ──HTTPS+Bearer──> app.xmind.cn/api/mcp
                                   │
                                   └── OAuth 2.1：动态注册 + PKCE + 127.0.0.1:8770 回调
```

- `host/index.mjs` 导出 `apply(ctx)`，用 `ctx.tools.register` 注册工具（`parameters` 用云端给的完整 JSON Schema，
  被宿主拒绝时自动退化为宽松 schema 再试一次）；
- 云端工具注册是**动态**的：授权成功后自动同步，不需要重启；
- `execute(args, exec)` 把 `exec.signal` 透传给远端请求，长调用可被中断；
- `tools/call` 是**非幂等**的，只有只读方法会重试（401 时强制刷新令牌并重试一次）。

## 2. 工具

本地：

| 工具 | 作用 |
|---|---|
| `xmind_login` | 生成授权链接并**立即返回**；`origin` 可选 `cn`（默认，手机号）/ `global`（邮箱） |
| `xmind_status` | 授权状态、站点、令牌过期时间、凭据目录、已注册的云端工具数 |
| `xmind_logout` | 清除本机令牌 |

云端（35 个，按云端清单动态注册）：`xmind_create_mindmap`、`xmind_read_mindmap`、`xmind_edit_mindmap`、
`xmind_show_mindmap`、`xmind_list_mindmaps`、`xmind_list_spaces`、`xmind_list_folders`、`xmind_create_folder`、
`xmind_move_file`、`xmind_rename_file`、`xmind_rename_folder`、`xmind_trash_file`、`xmind_restore_file`、
`xmind_list_teammates`、`xmind_get_topic`、`xmind_set_topic_attrs`、`xmind_set_topic_image`、
`xmind_add_relationship`、`xmind_add_boundary`、`xmind_remove_topic`、`xmind_remove_annotation`、
`xmind_update_relationship`、`xmind_add_summary`、`xmind_add_topic_link`、`xmind_set_todo`、
`xmind_set_planned_task`、`xmind_clear_task`、`xmind_list_sheets`、`xmind_list_resources`、`xmind_add_sheet`、
`xmind_set_structure`、`xmind_set_color_theme`、`xmind_set_topic_style`、`xmind_whoami`、`xmind_get_mindmap_guide`。

## 3. 安装

**插件管理器 / 插件市场（推荐）**：侧栏 **插件 → 添加插件**，粘贴本包路径或 Git 地址；或

```powershell
dsh plugin --profile <profile> add dsh-xmind-mcp
# 固定版本：dsh plugin --profile <profile> add github:macroboring/dsh-xmind-mcp#<commit>
```

> **升级后必须重启 DSH**：插件行从「MCP 客户端行」换成了「插件自身的行」，重启才会重新组合。

**手动兜底**（没有插件管理器时）：

```powershell
node install.mjs              # 往 profile 补丁写一行（已装为组合包时会自动跳过）
node install.mjs --uninstall
node install.mjs --dry-run
```

## 4. 首次授权

Xmind 有两套独立部署、账号不互通：`app.xmind.cn`（手机号，`cn`）/ `app.xmind.com`（邮箱，`global`）。

在对话里让助手调用 **`xmind_login`**（可带 `origin: cn`），它会**立刻**返回链接，然后：

1. 在同一台设备的浏览器打开链接；
2. 该浏览器需已登录对应站点（否则授权页只给邮箱表单，手机号账号会卡住）；
3. 点「授权 / 同意」→ 页面显示「授权成功」即可关闭；
4. 用 `xmind_status` 确认，云端工具会自动出现。

### 授权页报错排查

| 现象 | 原因 / 处理 |
|---|---|
| `client_id is required` | 链接丢参数（旧标签页/被截断）。重新调 `xmind_login` 拿完整链接。 |
| `需要用户 id`（`Authenticated xmind user required`） | 浏览器里没有该站点登录态。先登录站点，再打开链接；若仍弹登录框，**登录后按 F5 刷新该页**。 |
| 授权页只能邮箱登录 | 打开的是国际站；手机号账号用 `cn`。 |
| 浏览器没自动打开 | 正常（端侧尤其如此）。复制 `xmind_login` 返回的链接手动打开；回调是 `127.0.0.1:8770`，与宿主同机即可达。 |

凭据在 `$DSH_HOME/xmind-mcp/`：`client.json`、`tokens.json`（原子写、权限 0600）、`settings.json`、`tools-cache.json`、`bridge.log`。

命令行（桌面端排查用，端侧可直接用同名工具）：

```powershell
node cli.mjs doctor     # 端点 → 客户端 → 令牌 → MCP 握手 → 工具发现
node cli.mjs login cn   # 也可以从这里发起授权
node cli.mjs status / tools / call / raw / site / logout
```

## 5. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `XMIND_MCP_ORIGIN` | `https://app.xmind.cn` | 站点；国际站 `https://app.xmind.com` |
| `XMIND_MCP_TIMEOUT_MS` | `240000` | 单次云端工具调用超时（建图/改写常需 30–120 秒） |
| `XMIND_MCP_HOME` | `<DSH_HOME>/xmind-mcp` | 凭据与日志目录 |
| `XMIND_MCP_NO_BROWSER` | 未设 | 设 `1` 时不尝试拉起浏览器 |

## 6. 测试

全部离线、不需要账号、不需要网络、**不 spawn 任何进程**：

```powershell
npm test                          # 四套一起跑
node test/refresh.test.mjs        # 令牌刷新 / 401 重试 / 授权链接（6 项）
node test/host-plugin.test.mjs    # 进程内插件 + 端侧验收标准（7 项）
node test/install.test.mjs        # 安装/卸载（7 项）
node test/no-machine-paths.mjs    # 发布守卫：包内不得有机器路径
```

## 7. 已知限制

- **权限由 Xmind 决定**：能否读/建/改取决于套餐与服务端；部分能力消耗 Xmind credits。
- **授权必须人工点一下**：OAuth 交互无法全自动，且需要浏览器里已有对应站点登录态。
- **站点切换会作废旧令牌**：`.cn` 与 `.com` 不通用。
- **工具清单以云端为准**：动态同步；上游从 32 → 35 个工具时本插件无需改动。
- **自由主题（浮动主题）只能读不能建**：官方 MCP 接口没有该入口；需要时在 Xmind 里把主题拖到空白处。
- **改已有导图必须回写 `<!--t:...-->` 锚点**：锚点是保住备注/标记/图片的唯一依据。
- **`link:` 安装依赖本目录**：用本地路径安装后不要移动目录。

## 8. 目录结构

```
dsh-xmind-mcp/
├── cordis.patch.yml   组合包补丁（插入插件自身：name = 包名，无机器路径）
├── host/index.mjs     进程内 Host 插件：ctx.tools.register + OAuth + 远端 MCP 调用
├── lib/oauth.mjs      动态注册、PKCE、令牌交换与刷新、站点白名单、授权链接即时返回
├── lib/remote.mjs     Xmind MCP 的 Streamable HTTP 客户端（JSON / SSE、401 刷新重试、取消传播）
├── lib/store.mjs      凭据、缓存、日志（原子写、BOM 容错）
├── cli.mjs            命令行：登录 / 诊断 / 直接调用云端工具
├── install.mjs        手动兜底安装（无插件管理器时）
├── locale/            插件卡片显示名与描述（en / zh）
├── test/              离线测试
└── CHANGELOG.md       版本与迁移说明
```

## 9. 隐私与归属

只与 `app.xmind.cn` / `app.xmind.com` 通信；令牌仅存本机；无遥测、无第三方中转。
第三方开源插件，**与 Xmind 官方无隶属关系**。见 [PROVENANCE.md](PROVENANCE.md)、[LICENSE](LICENSE)（MIT）。

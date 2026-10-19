# dsh-xmind-mcp

把 **Xmind 云端「我的导图」** 接进 DeepSeek Harness：用自然语言列出、读取、新建、改写你的 Xmind 导图。

装上之后 DSH 的工具集里会多出 **35 个 `mcp__xmind__*` 工具**（`xmind_create_mindmap`、`xmind_read_mindmap`、`xmind_edit_mindmap`、`xmind_show_mindmap`、文件夹/空间管理、主题样式、关系线、外框、摘要、待办、甘特排期、多 sheet……），
外加三个本地工具：`login`、`status`、`logout`。

- **零依赖**：不需要 `npm install` 装任何东西（`@deepseek-ai/dsh-mcp-client` 由 DSH 本体提供）。
- **不含机器相关路径**：包的清单里没有绝对路径，装在任何机器 / 任何 profile 都能直接跑（见下）。
- **OAuth 在本机完成**：动态客户端注册 + PKCE，令牌存本机并自动续期；不经过任何第三方服务器。

---

## 1. 为什么清单里没有绝对路径

一个 stdio MCP 插件通常得在配置里写死「Node 可执行文件」和「入口脚本」的绝对路径，于是换台机器就失效。
本包的 `cordis.patch.yml` 用 Loader 表达式在**加载时**算出路径，因此同一份包跨平台通用：

```yaml
command: !!js process.env.XMIND_MCP_NODE || process.execPath
args:
  - !!js process.env.XMIND_MCP_ENTRY || dshHomePath('profiles', ctx.get('profileContext').name, 'node_modules', 'dsh-xmind-mcp', 'index.mjs')
env:
  ELECTRON_RUN_AS_NODE: '1'          # 宿主本体在 Electron 下当 node 用（DSH 自带的 dsh.cmd 也是这么做的）
  XMIND_MCP_HOME: !!js dshHomePath('xmind-mcp')
```

- `process.execPath` 是宿主可执行文件；配合 `ELECTRON_RUN_AS_NODE=1` 它就是完整 Node（Windows/macOS/Linux 一致）。
- 包自身位置由 `$DSH_HOME/profiles/<profile>/node_modules/<包名>` 推出，所以装在哪个 profile 都不用改。
- 安装位置不标准时有两个逃生口：环境变量 `XMIND_MCP_NODE`、`XMIND_MCP_ENTRY`。

## 2. 安装

**方式一：插件管理器 / 插件市场（推荐）**

- DSH 侧栏 **插件 → 添加插件**，粘贴本包的**本地绝对路径**或 Git 地址，安装后重启 DSH；
- 发布到 npm 后：`dsh plugin --profile <profile> add dsh-xmind-mcp`；
- 上架插件市场后可在 **设置 → 插件市场** 一键安装。

装好后「插件 → 已安装」里会出现 `xmind-mcp`（显示名取自 `locale/*.json`）。

**方式二：手动兜底（没有插件管理器的环境，例如 headless/agent 会话）**

```bash
node install.mjs              # 往 profile 的 cordis.patch.yml 插入与本包清单相同的一行
node install.mjs --uninstall  # 移除
node install.mjs --dry-run    # 先看会写什么
```

> 两种方式**二选一**。若检测到已作为组合包安装，`install.mjs` 会拒绝再写手写行（同一 `serverName` 注册两次会让后一个加载失败）。

## 3. 首次授权

Xmind 有**两套独立部署、账号不互通**：

| 站点 | 登录方式 | 参数 |
|---|---|---|
| `https://app.xmind.cn` | **手机号**（中国大陆站） | `cn`（默认） |
| `https://app.xmind.com` | 邮箱（国际站） | `global` |

```bash
node cli.mjs login cn        # 中国站
node cli.mjs login global    # 国际站
```

也可以直接让 DSH 里的助手调用 `mcp__xmind__login`——它会**立刻返回授权链接**（同时在有图形界面时尝试打开浏览器），
流程在后台等回调，令牌一到就存好。所以就算对话里的工具调用被中断，链接仍然有效。

### 授权页报错排查

| 现象 | 原因 / 处理 |
|---|---|
| `client_id is required` | 打开的链接丢参数了（旧标签页、被截断）。重新执行 `login` 拿完整链接。 |
| `需要用户 id`（服务端原文 `Authenticated xmind user required`） | 浏览器里没有该站点登录态。先登录对应站点（中国站 <https://app.xmind.cn>），再打开授权链接；若它仍弹登录框，**登录后按 F5 刷新该页**（该页校验失败会清登录态并弹框，不刷新不会重试）。 |
| 授权页只能邮箱登录 | 打开的是**国际站**。手机号账号用 `cn`。 |
| 没有图形界面 / 打不开浏览器 | 正常。把 `login` 打印的链接复制到浏览器即可；回调是 `127.0.0.1:8770`，与桥接同机即可达。 |

凭据落在 `$DSH_HOME/xmind-mcp/`：`client.json`（动态注册的 OAuth 客户端）、`tokens.json`（access/refresh，原子写、权限 0600）、`settings.json`（当前站点）、`tools-cache.json`、`bridge.log`。

## 4. 用法示例

- “列出我最近打开过的 Xmind 导图”
- “把这周的会议纪要整理成一张导图，存进我的导图”
- “读一下《读书笔记》并整理成 Markdown”
- “给《虚拟语气》再加两个分支：虚拟条件句、倒装”
- “把这张图换成深色配色”“给这些行动项加勾选框”

> 在 Xmind 里**创建/改写不会自动展示给你看**，要让导图出现在眼前需调用 `xmind_show_mindmap`（助手一般会自己调）。

## 5. 诊断与验证

```bash
node cli.mjs doctor     # 端点 → 客户端 → 令牌 → MCP 握手 → 工具发现，五项逐条检查
node cli.mjs status     # 授权状态 / 站点 / 令牌过期时间
node cli.mjs site cn    # 查看或切换站点
node cli.mjs tools      # 列出云端工具及参数
node cli.mjs call <tool> '{"k":"v"}'
node cli.mjs raw <method> '{}'
node cli.mjs logout
```

测试（全部离线，不需要账号）：

```bash
npm test                        # 三套一起跑
node selftest.mjs               # 协议契约 8 项
node test/refresh.test.mjs      # 令牌刷新 / 401 重试 / 授权链接 6 项（本地 mock）
node test/install.test.mjs      # 安装与卸载 7 项（含「清单不得含机器路径」回归断言）
```

`test/install.test.mjs` 若提供 `DSH_YAML_LIB`（指向 DSH 自带的 `yaml/dist/index.js`），会用它解析生成结果；否则退化为结构校验。

日志：`$DSH_HOME/xmind-mcp/bridge.log`；设 `XMIND_MCP_DEBUG=1` 打印完整收发报文（**令牌永不写入日志**）。

## 6. 已知限制

- **权限由 Xmind 决定**：能否读/建/改取决于你的套餐与服务端；部分能力会消耗 Xmind credits。
- **单次调用较慢**：新建/改写由 Xmind 服务端生成，通常 30–120 秒（桥接侧 `toolCallTimeoutMs` 为 4 分钟）。
- **授权必须人工点一下**：OAuth 交互无法全自动，且需要浏览器里已有对应站点登录态。
- **站点切换会作废旧令牌**：`.cn` 与 `.com` 令牌不通用，切换后需重新授权。
- **工具清单以云端为准**：不硬编码工具名，一律从云端 `tools/list` 同步并缓存；公开名在同一工具集下保持稳定且唯一。
  （上游从 32 个涨到 35 个时，本插件无需改动。）
- **自由主题（浮动主题）只能读不能建**：官方 MCP 工具集没有这个入口；需要时在 Xmind 里把主题拖到空白处。
- **改已有导图必须回写 `<!--t:...-->` 锚点**：锚点是保住备注/标记/图片的唯一依据。
- **`link:` 安装依赖本目录**：若用 `添加插件` 装的是本地路径，之后别移动/删除该目录。

## 7. 文件结构

```
dsh-xmind-mcp/
├── cordis.patch.yml   组合包补丁（可移植，无绝对路径）
├── index.mjs          stdio MCP 服务器：协议处理、工具分发、命名与缓存
├── cli.mjs            命令行：登录 / 诊断 / 直接调用云端工具
├── install.mjs        手动兜底安装（无插件管理器时用）
├── selftest.mjs       协议契约自测
├── lib/oauth.mjs      动态注册、PKCE、令牌交换与刷新、站点白名单
├── lib/remote.mjs     Xmind MCP 的 Streamable HTTP 客户端（JSON / SSE、401 刷新重试）
├── lib/store.mjs      凭据、缓存、日志（原子写、BOM 容错）
├── locale/            插件卡片显示名与描述（en / zh）
├── test/              离线测试
└── PUBLISHING.md      发布到 npm / 插件市场的步骤
```

## 8. 卸载

```bash
node install.mjs --uninstall   # 若曾用手动方式安装
node cli.mjs logout            # 清除本机令牌
```

用插件管理器装的，请在侧栏 **插件** 里卸载。

## 9. 隐私与归属

本插件只与 `app.xmind.cn` / `app.xmind.com` 通信，令牌仅存本机，无遥测、无第三方中转。
它是第三方开源插件，**与 Xmind 官方无隶属关系**；详见 [PROVENANCE.md](PROVENANCE.md) 与 [LICENSE](LICENSE)（MIT）。

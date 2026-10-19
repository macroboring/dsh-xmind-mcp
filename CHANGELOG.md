# Changelog

## 3.0.0 — 进程内实现，支持禁止 fork/exec 的端侧宿主

**破坏性变更**：插件不再是 stdio 型 MCP 服务器，工具名随之改变。

- **不再 spawn 任何子进程。** 旧版用 `@deepseek-ai/dsh-mcp-client` 以 `command: process.execPath` +
  `ELECTRON_RUN_AS_NODE=1` 拉起一个 stdio 桥。在 HarmonyOS/DSHM 这类端侧宿主上，进程被内嵌、
  没有 `node` 可执行文件、且平台**禁止 fork/exec**，spawn 必然失败 → `mcp-client(xmind): server is disconnected`，
  桥一次都不会被执行（`$DSH_HOME/xmind-mcp` 从不创建）。
- **改为进程内 Host 插件**：`host/index.mjs` 导出 `apply(ctx)`，用 `ctx.tools.register` 把云端工具注册成
  **原生 dsh 工具**；OAuth（动态注册 + PKCE + `127.0.0.1:8770` 回调）与远端 MCP（Streamable HTTP + SSE）
  全在宿主进程内完成。只用 `node:` 内置模块与全局 `fetch`。
- **工具改名**：`mcp__xmind__xmind_list_mindmaps` → **`xmind_list_mindmaps`**；
  `mcp__xmind__login` → **`xmind_login`**，另有 `xmind_status` / `xmind_logout`。
- **组合包补丁**：`name: 'dsh-xmind-mcp'`（包名，由 loader 从 profile 的 `node_modules` 经 `main` 解析），
  配置项全部从环境变量读取，清单里没有任何机器路径。
- **失败可诊断**：激活期间绝不 throw；注册/同步/授权失败都写入 `$DSH_HOME/xmind-mcp/bridge.log`。
  单个云端工具的 schema 若被宿主拒绝，会退化为宽松 schema 再注册一次，而不是整批失败。
- **取消传播**：`execute(args, exec)` 把 `exec.signal` 透传给远端请求（与超时信号合并），长调用可被中断。
- **端侧友好**：打开浏览器改为**惰性**导入 `node:child_process`，模块加载不再硬依赖它；
  `XMIND_MCP_NO_BROWSER=1` 可完全跳过。（端侧本就没有浏览器可拉起，链接总是返回给用户手动打开。）
- 删除 stdio 桥 `index.mjs` 与协议自测；新增 `host-plugin` 离线测试（覆盖端侧报告的验收标准）。
- 升级需要**重启 DSH**（插件行由 MCP 客户端行换成了插件自身的行）。

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `XMIND_MCP_ORIGIN` | `https://app.xmind.cn` | 站点；国际站 `https://app.xmind.com` |
| `XMIND_MCP_TIMEOUT_MS` | `240000` | 单次云端工具调用超时 |
| `XMIND_MCP_HOME` | `<DSH_HOME>/xmind-mcp` | 凭据与日志目录 |
| `XMIND_MCP_NO_BROWSER` | 未设 | 设 `1` 时不尝试拉起浏览器 |

## 2.0.0 — 标准可分发包

- 包名改为 `dsh-xmind-mcp`，补全 `keywords` / `license` / `repository` / `locale` 卡片元数据 / `icon`
- 清单里的绝对路径改为 Loader `!!js` 表达式（`process.execPath` + `dshHomePath`），跨机器免配置
- 发布守卫 `test/no-machine-paths.mjs`；GitHub Actions 三系统 × 三 Node 矩阵

## 1.x — Xmind MCP 桥

- 首个可用版本：OAuth 2.1（动态客户端注册 + PKCE）、双站点（cn/global）、令牌自动刷新、
  35 个云端工具透传、`login` / `status` / `logout` 本地工具。

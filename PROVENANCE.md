# PROVENANCE

出处、数据流向与归属说明。

## 代码来源

本包为原创代码，**不包含任何第三方运行时依赖**（`dependencies` 为空），
只使用 Node 内置模块（`node:fs` / `node:http` / `node:crypto` / `node:child_process` / `node:url` / `node:path`）
与全局 `fetch`。它依赖 DSH 本体提供的 `@deepseek-ai/dsh-mcp-client`（作为组合包补丁里的一行）。

## 数据流向

```
DSH Agent ──stdio(逐行 JSON-RPC)──> index.mjs（本包） ──HTTPS+Bearer──> app.xmind.cn / app.xmind.com
                                          │
                                          └── OAuth 2.1：动态客户端注册 + PKCE + 浏览器授权
```

- 唯一的对外网络目标是 Xmind 官方端点（`<origin>/.well-known/oauth-authorization-server`、
  `<origin>/api/oauth/*`、`<origin>/api/mcp`）。
- 没有遥测、没有统计上报、没有第三方中转或代理。
- 服务器返回的 `instructions` 与工具清单只用于本次会话。

## 本机存储

`$DSH_HOME/xmind-mcp/`（Windows 默认 `%USERPROFILE%\.dsh\xmind-mcp\`）：

| 文件 | 内容 | 说明 |
|---|---|---|
| `client.json` | 动态注册得到的公共客户端信息（无 client_secret） | 每次注册由授权服务器签发 |
| `tokens.json` | access / refresh token 与过期时间 | **凭据**；原子写，权限 0600 |
| `settings.json` | 当前站点、待完成的授权链接 | 可手改 |
| `tools-cache.json` | 云端工具清单缓存 | 断网时兜底 |
| `bridge.log` | 运行日志 | 轮转有界；**不含令牌** |

令牌不会写入日志，也不会进入任何工具返回值。

## 归属与商标

- 本包是**独立的第三方开源插件，与 Xmind 官方无隶属、背书或合作关系**。
- "Xmind" 是 Xmind Ltd. 的商标，本包仅用于说明它对接的服务。
- 它对接的是 Xmind **公开提供**的 MCP 端点与其 OAuth 授权服务器；使用需遵守 Xmind 的服务条款，
  功能可用性由你的 Xmind 套餐与服务端决定。

## 许可证

MIT，见 [LICENSE](LICENSE)。

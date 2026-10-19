# HANDOFF — 给「目标设备上的 DSH 助手」的安装任务书

> 这份文件写给**另一个 DSH 实例**的助手（例如 HarmonyOS 上自足运行的 DSHM）。
> 用户会把本包放到你的文件区/工作区，然后让你照本文件执行。
> 目标：把 dsh-xmind-mcp **3.x** 装成这台设备上的 DSH 插件，并验证到能读到用户的 Xmind 导图。

## 0. v3 的重大变化：不再需要子进程

旧版（1.x/2.x）是 stdio 型 MCP 服务器，需要宿主 spawn 一个 node 子进程。在**禁止 fork/exec、
没有 node 可执行文件**的端侧宿主上必然失败（`mcp-client(xmind): server is disconnected`，
`$DSH_HOME/xmind-mcp` 从不创建）。

v3 改成**进程内 Host 插件**：文件 `host/index.mjs` 由宿主直接 import，工具用 `ctx.tools.register`
注册为**原生 dsh 工具**。**不需要 node 可执行文件、不需要子进程、不需要网络装依赖。**

## 1. 探测环境并报告给用户

```bash
echo "DSH_HOME=$DSH_HOME"
echo "DSH_PROFILE=$DSH_PROFILE"
echo "DSH_PROFILE_DIR=$DSH_PROFILE_DIR"
ls -d "$DSH_PROFILE_DIR/package.json" 2>/dev/null && echo "profile ok"
```

判断：`$DSH_PROFILE_DIR/package.json` 存在 = 本机是**完整宿主**（能装插件）。
若不存在，说明你只是远程客户端，插件应装到宿主那台设备——如实告诉用户，不要硬装。

## 2. 安装

**方式 A：插件管理器（首选）**

让用户在 DSH 侧栏 **插件 → 添加插件** 里粘贴本包的**绝对路径**（或 Git 地址）并安装，然后**重启 DSH**。
装好后「插件 → 已安装」会出现 `xmind-mcp`。

**方式 B：手动兜底（没有插件管理器时）**

```bash
node install.mjs
```

然后重启 DSH。

> ⚠️ **升级后必须重启**：v2→v3 的插件行从「MCP 客户端行」换成「插件自身的行」，
> 不重启的话 loader 可能仍持有旧组合。

## 3. 授权

**不要**用 `node cli.mjs login`（端侧可能没有可在终端里跑的 node）；直接用工具：

1. 调用 **`xmind_login`**，把 `origin` 设为 `cn`（手机号账号）或 `global`（邮箱账号）；
2. 它**立即**返回授权链接，**把链接原样交给用户**，让他在**同一台设备**的浏览器打开；
3. 用户需先在浏览器登录对应站点（中国站 <https://app.xmind.cn>）；
4. 若授权页报 `需要用户 id`：先登录站点再打开链接；**若仍弹登录框，登录后按 F5 刷新该页**；
   若报 `client_id is required`：链接被截断，重新调 `xmind_login`。

授权完成后 **不要**让用户重装或重启：调一次 **`xmind_status`** 会触发云端工具同步。

## 4. 验收（缺一不可，对应用户端侧报告第 7 节）

1. `xmind_status` 返回「未授权」并给出凭据目录 ✔（安装成功即可）
2. `xmind_login` 立即返回链接、不阻塞到用户点完 ✔
3. 授权后 `xmind_status` 显示「已授权」且「已注册的云端工具：N 个」（N 通常 35）✔
4. `xmind_list_mindmaps`（limit 3）返回用户「我的导图」里真实的文件 ✔
5. 清空令牌（`xmind_logout`）后再调 `xmind_list_mindmaps`，应返回明确的「尚未授权…请先调用 xmind_login」，
   而不是崩溃或静默超时 ✔

五项都过，才能对用户说「装好了」。

## 5. 出问题时要报告的信息

1. `$DSH_HOME/xmind-mcp/bridge.log`（**没有这个文件 = 插件根本没被加载**）
2. 本包 `cordis.patch.yml` 内容（**令牌不在里面**）
3. `$DSH_PROFILE_DIR/package.json` 里的 `dependencies` 与 `dsh.profile.bundles` 两段
4. `echo $DSH_HOME`、`uname -a`

⚠️ **不要**把 `$DSH_HOME/xmind-mcp/tokens.json`、`client.json` 贴进任何聊天——那是账号凭据。

## 6. 纪律

- 不要改动 profile 里**其它**条目；`install.mjs` 只动自己那段带标记的区块，并会先备份。
- 不要同时用方式 A 和方式 B。
- `tools/call` 非幂等：**不要**因为一次超时就重发建图/改写请求（只读工具可以重试）。
- 建图/改写单次 30–120 秒，属正常，别当卡死。

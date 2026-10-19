# HANDOFF — 给「目标设备上的 DSH 助手」的安装任务书

> 这份文件写给**另一个 DSH 实例**的助手（例如 HarmonyOS 上自足运行的 DSHM）。
> 用户会把本包放到你的工作区/文件区，然后让你照本文件执行。
> 目标：把 dsh-xmind-mcp 装成**这台设备**上的 DSH 插件，并验证到能读到用户的 Xmind 导图。

## 0. 先弄清一件好事：本包不需要按机器生成路径

`cordis.patch.yml` 里没有任何绝对路径：`command` 用 `process.execPath`，入口用
`dshHomePath('profiles', ctx.get('profileContext').name, 'node_modules', 'dsh-xmind-mcp', 'index.mjs')`
在**加载时**推导。所以只要装到标准位置，装上就能跑，**不需要**改清单、也不需要知道本机的 node 路径。

## 1. 探测环境并报告给用户

```bash
echo "DSH_HOME=$DSH_HOME"
echo "DSH_PROFILE=$DSH_PROFILE"
echo "DSH_PROFILE_DIR=$DSH_PROFILE_DIR"
command -v node && node -v
command -v unzip; command -v tar
```

判断：

| 检查 | 期望 | 说明 |
|---|---|---|
| `$DSH_HOME` 非空 | ✔ | 为空说明不在 profile 启动的 shell 里 |
| `$DSH_PROFILE_DIR/package.json` 存在 | ✔ | 这是「本设备是完整宿主」的硬证据 |
| Node ≥ 20 | ✔ | 本包运行需要；宿主已自带 |

> **如果 `$DSH_PROFILE_DIR` 为空或没有 package.json**，说明你只是**远程客户端**、agent 跑在别的设备上——
> 那么本插件应装到**宿主那台设备**，不是你这里。请如实告诉用户，不要硬装。

把上面几行输出原样报给用户。

## 2. 安装（二选一）

**方式 A：插件管理器（首选）**

让用户在 DSH 侧栏 **插件 → 添加插件** 里粘贴本包的**绝对路径**并安装，然后**重启 DSH**。
装好后「插件 → 已安装」会出现 `xmind-mcp`。

**方式 B：手动兜底（没有插件管理器时）**

```bash
node install.mjs
```

然后重启 DSH。若已用方式 A 装过，方式 B 会被自动拦下（只提示、不写重复行）。

## 3. 授权

```bash
node cli.mjs login cn        # 中国站（手机号账号）；邮箱账号用 global
```

- 多数设备没有 `xdg-open`，**浏览器不会自动打开，这是正常的**：命令会打印授权链接，交给用户在**同一台设备**的浏览器里打开。
- 回调是 `http://127.0.0.1:8770/callback`，浏览器与桥接同机即可达。
- 用户需先在浏览器登录对应站点（中国站 <https://app.xmind.cn>）。
- 若授权页报 `需要用户 id`：让用户先登录该站点再打开链接；**若仍弹登录框，登录后按 F5 刷新该页**。
- 若报 `client_id is required`：链接被截断，重新执行 `login`。

## 4. 验证（缺一不可）

```bash
node cli.mjs doctor     # 五项全 ✅ 才算通
node cli.mjs status     # 显示「已授权」
```

再通过 MCP 工具确认（重启 DSH 后工具才会出现）：

1. `xmind_whoami` → 返回用户名与团队名
2. `xmind_list_mindmaps`（limit 3）→ 返回用户「我的导图」里真实的文件

两步都成功，才能对用户说「装好了」。

## 5. 出问题时要报告的信息

1. `node cli.mjs doctor` 完整输出
2. `$DSH_HOME/xmind-mcp/bridge.log`
3. 本包 `cordis.patch.yml` 内容（**令牌不在里面**）
4. `uname -a`、`node -v`、`echo $DSH_HOME`

⚠️ **不要**把 `$DSH_HOME/xmind-mcp/tokens.json`、`client.json` 贴进任何聊天——那是账号凭据。

## 6. 纪律

- 不要改动 profile 里**其它**条目（用户的模型/界面设置）；`install.mjs` 只动自己那段带标记的区块，并会先备份。
- 不要同时用方式 A 和方式 B。
- 第 1–4 步做一次即可，以后只管用。

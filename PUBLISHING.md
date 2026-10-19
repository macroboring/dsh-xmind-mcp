# 发布清单

把这个包发布成「任何人都能装」的标准 DSH 插件。发布前逐项过一遍。

## 0. 发布前检查

```bash
npm test                    # 三套离线测试必须全绿
npm pack --dry-run          # 看清单：只应包含需要的文件，绝不能有凭据
```

- [ ] `npm test` 全绿
- [ ] `npm pack --dry-run` 的输出里**没有** `tokens.json` / `client.json` / `*.log` / `node_modules`
- [ ] `package.json` 里 `name`、`version`、`description`、`keywords`、`license`、`files`、`icon` 都是最终值
- [ ] `cordis.patch.yml` 里**没有任何绝对路径**（`grep -nE '[A-Za-z]:[\\/]' cordis.patch.yml` 应为空）
- [ ] `locale/en.json`、`locale/zh.json` 的标题与描述准确
- [ ] 没把本机 `$DSH_HOME` 路径写进任何文档

## 1. 仓库元信息

已填好：`repository` / `homepage` / `bugs` 指向 `github.com/macroboring/dsh-xmind-mcp`。
若仓库名或账号变了，用一条命令改：

```powershell
npm pkg set repository.url=git+https://github.com/<user>/dsh-xmind-mcp.git homepage=https://github.com/<user>/dsh-xmind-mcp#readme bugs.url=https://github.com/<user>/dsh-xmind-mcp/issues
```

## 2. 发布到 npm

```bash
npm login
npm publish            # 非 scoped 包默认 public；若改成 @scope/ 名字则用 npm publish --access public
```

发布后用户可以：

```bash
dsh plugin --profile desktop add dsh-xmind-mcp
# 或在 DSH 侧栏「插件 → 添加插件」里直接填包名 dsh-xmind-mcp
```

## 3. 上架 DSH 插件市场

市场（`dshmarket`，站点 dshmarket.com）按 **npm 版本**或 **GitHub commit** 检查更新，安装走标准包管理：
让插件出现在市场里通常需要向市场仓库提交收录信息（名称、一句话简介、npm 包名、图标、截图、许可证）。
提交前确保：

- npm 上已发布，且 README 里写清「首次需要授权 Xmind」这一步
- 有图标（本包已带 `icon.svg`）
- 描述里点明**非官方**（避免让人误以为 Xmind 官方插件）

## 4. 版本与升级

- 语义化版本：行为变化 → major/minor；仅文档/描述 → patch。
- 用户的升级路径是「卸载后重装」或市场的一键更新；`link:` 安装的用户需要重新安装。
- **不要**发布任何包含 `tokens.json`、`client.json` 或 `bridge.log` 的包。

## 5. 发布后再验一遍

在一台**干净**的 DSH 上（最好是没装过本插件的 profile）：

1. 装包 → 重启 DSH → 确认「插件 → 已安装」里出现 `xmind-mcp`
2. 让助手调用 `xmind_whoami`（未授权时应提示先 `login`）
3. 完成一次授权 → `node cli.mjs doctor` 五项全 ✅
4. `xmind_list_mindmaps` 能列出该账号真实的导图

这四步都通过，才算「任何人都能装」。

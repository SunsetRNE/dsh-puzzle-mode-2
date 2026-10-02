# 发布 dsh-puzzle-mode

这份部署里 DSH 插件管理器支持的来源：`npm` / `github` / `release` / `download`（任意压缩包 URL）/ `import`（本地压缩包）。

## 0. 状态

| 项 | 现状（2026-10-02） |
| --- | --- |
| 仓库 | <https://github.com/liancha22/dsh-puzzle-mode>（public） |
| 版本 | v0.19.3（修一条**通用缺陷**：返回体积改为 ∝ 本次改变了什么，而不是 ∝ 项目规模。写操作只回回执——7026→1192 字符（省 83%）；审查证据抽成 `evidenceTable` 去重表、各处只留 `evidence:[下标]`（同一句曾重复 39 次、114 次出现仅 12 条唯一）→ 实测响应 43KB→28KB（省 35%）；`inflation[].because` 纯副本删除；`AUDIT_PROMPT` 默认不回吐（提示段已有一份，`verbose:true` 取回）。判据已写进提示段防复发。含 v0.19.2 教程图） |
| 兼容 | DSH `^0.1.5-alpha.1 \|\| ^0.1.6-alpha.1 \|\| ^0.1.7-alpha.1 \|\| ^0.2.0-rc.1`（peer 只声明 `@deepseek-ai/dsh-tools`；13 个已发布版本全覆盖） |
| Release | <https://github.com/liancha22/dsh-puzzle-mode/releases> |
| npm | **未发布**（本机装的是 GitHub 源） |
| 注意 | GitHub API token 已实测有效（HTTP 200）；`git push` 走 SSH |
| 测试 | **v3 起旧自检已过期**（断言钉死 v2 形状）；按工作约定不维护、不追红。验收判据见各版本 Release 正文的「验收判据」一节 |
| 依赖 | 无。只 peer 依赖 `@deepseek-ai/dsh-tools`（运行时提供） |

## 1. 别人怎么装（GitHub 源，推荐）

**前提：仓库必须 public** —— 下载器不带鉴权（匿名请求 `api.github.com`），私有仓库在别人机器上拉不到。

```bash
# 1) 插件管理器（App 插件页「添加插件」用的就是它；支持标签/分支/子目录）
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.1.0   # 指定标签/分支
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode main/lib # 分支 + 子目录

# 2) dsh CLI 走 pnpm，只认 npm 名或 git 协议（不认 owner/repo）
dsh plugin --profile web add github:liancha22/dsh-puzzle-mode
```

装完**重启该 profile**（`patchReload: startup`），然后刷新浏览器页面。
`dsh plugin add` 会做三件事：把包放进 profile 的 `node_modules`、写进 `package.json` 的
`dependencies`、按包内 `dsh.bundle.patch` 把一行 `insert` 合并进 profile 组合。

卸载：`dsh plugin --profile web remove dsh-puzzle-mode`（或插件页删除），再重启。

## 2. 手工装（离线 / 自测）

```bash
git clone https://github.com/liancha22/dsh-puzzle-mode ~/.dsh/plugin-src/dsh-puzzle-mode
ln -s ~/.dsh/plugin-src/dsh-puzzle-mode <profile>/node_modules/dsh-puzzle-mode
# <profile>/package.json：
#   dependencies:        "dsh-puzzle-mode": "link:/root/.dsh/plugin-src/dsh-puzzle-mode"
#   dsh.profile.bundles: [ ..., "dsh-puzzle-mode" ]
# 重启 DSH（profile patchReload: startup），刷新页面
```

## 3. 发布新版本

```bash
cd /root/.dsh/plugin-src/dsh-puzzle-mode
# 1) 改 package.json 的 version（例如 0.16.6）+ 在 .github/ 写好 release-vX.Y.Z.md
# 2) **同步文档版本引用**（漏了会被用户抓到，见下「发版检查清单」）
# 3) 不跑测试（工作约定：不写测试、不跑测试；验收判据写进 Release 正文，交用户真机看）
for f in lib/*.js; do node --check "$f" || echo "FAIL $f"; done   # 只做语法解析，防手滑
git add -A && git commit -m "feat: …（vX.Y.Z）"
git tag -f vX.Y.Z && git push origin HEAD --tags
bash tools/release.sh vX.Y.Z          # 建 Release（正文取 .github/release-vX.Y.Z.md）
```

### ⚠️ 发版检查清单（每次都要过一遍）

改完代码**不等于**发完版。README / PUBLISH / UI / package.json **都在 npm 包的 `files` 里**，
一改旧附件就过期，必须重传。逐项核对：

| # | 文件 | 要改什么 |
| --- | --- | --- |
| 1 | `README.md` | 头部「最新版」、安装命令、tgz 下载链接**三处**，再加一个新版本小节 |
| 2 | `README.md` | 只留最近 3 个版本的小节，更早的挪进 `CHANGELOG.md` |
| 3 | `CHANGELOG.md` | 接收从 README 挪下来的旧版本小节 |
| 4 | `UI.md` | 头部「对应 vX.Y.Z」 |
| 5 | `PUBLISH.md` | 第 0 节状态表的版本与日期 |
| 6 | `package.json` | `version`（description 只留一句当前亮点，**别堆版本历史**） |
| 7 | `.github/release-vX.Y.Z.md` | 新版本的正文 + 「验收判据」一节 |
| 8 | `.github/images/` | **改过 `UI.md` 就必须重渲染**：`npm run render-tutorial`（见下） |

> 第 1 条是**用户明确要求**的（2026-10-01）：「每次有更新都要改 readme」。
> 已经写进拼图文档的 `## 工作流`，每一步都会注入。

### ⚠️ 改过 `UI.md` 就要重渲染教程图（第 8 条）

`.github/images/` 里那 10 张图是**照着 `UI.md` 渲染**的（README 顶部 1 张 + UI.md 各节 8 张
+ 整份长图 1 张）。`UI.md` 一改，图就与正文不一致——**图与文字对不上比没有图更糟**。

```bash
npm run render-tutorial        # 需要 marked（devDependency）+ playwright 的 chromium
```

脚本的三条硬约束（都踩过，改脚本时别丢）：

1. **页面宽必须按 830px 渲染**，不是 1400。GitHub 会把宽于正文的图等比缩到约 830，
   按 1400 渲染的图进页面实际是 0.59x，字小到读不清；
2. **渲染前要剥掉正文里的 `![](...)`**。图被 `UI.md` 自己引用，而脚本又照着 `UI.md`
   渲染——不剥就是自引用，`setContent` 没有 base URL，渲染结果里会出现一排**破图图标**；
3. **表格要 `table-layout:fixed` + `word-break`**，否则窄宽下「内容」列的长句会把表格撑出画布。

产出后跑一次量化（脚本内自动做）：256 色，约 5.6MB → 2.2MB，文字仍锐利。

> 真面板截图（`预览/面板-*.png` 那类）**不能**由本脚本生成——它必须真面板跑起来截。
> 本脚本产出的是「`UI.md` 的渲染图」，两者不是一回事。

> 标签已存在时要 `git tag -f` **加** `git push -f origin vX.Y.Z`：
> 只 `git push origin HEAD --tags` 会被 `! [rejected] (already exists)` 挡回来。

### ⚠️ 附件必须单独上传（`release.sh` **不会**做这件事）

`tools/release.sh` 只建 Release，**不传 tgz**。漏了这一步，Release 页就没有下载附件
（v0.16.0 曾因此缺附件，事后才补）。补传：

```bash
npm pack                              # 产出 dsh-puzzle-mode-X.Y.Z.tgz
TOKEN=$(cat /root/.dsh/.github-token)
RID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/liancha22/dsh-puzzle-mode/releases/tags/vX.Y.Z \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/gzip" \
  --data-binary @dsh-puzzle-mode-X.Y.Z.tgz \
  "https://uploads.github.com/repos/liancha22/dsh-puzzle-mode/releases/$RID/assets?name=dsh-puzzle-mode-X.Y.Z.tgz"
```

**重传（改了文档要刷新附件）**：先删旧附件再传，否则会多出一个 `-1` 后缀的同名附件。

```bash
AID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/liancha22/dsh-puzzle-mode/releases/$RID/assets \
  | python3 -c "import sys,json;a=json.load(sys.stdin);print(a[0]['id'] if a else '')")
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/liancha22/dsh-puzzle-mode/releases/assets/$AID
```

改过 Release 正文（`.github/release-vX.Y.Z.md`）后同步到页面上：

```bash
python3 - "$TOKEN" <<'EOF'
import json,sys,urllib.request
tok=sys.argv[1]; rid=0  # ← 填 release id
body=open('.github/release-vX.Y.Z.md',encoding='utf-8').read()
req=urllib.request.Request(f"https://api.github.com/repos/liancha22/dsh-puzzle-mode/releases/{rid}",
  data=json.dumps({"body":body}).encode(), method="PATCH",
  headers={"Authorization":f"Bearer {tok}","Content-Type":"application/json"})
urllib.request.urlopen(req)
EOF
```

`dsh plugin --profile web add liancha22/dsh-puzzle-mode#vX.Y.Z` 也能按 tag 装。

## 4. 关于发 npm（暂不做）

本机 token 只有 `public_repo` 作用域，**不能发 npm**；而 npm 现在的写权限 token 强制 2FA、
最长 90 天，长期 CI 要走 Trusted Publishing（OIDC）。既然 GitHub 源已经能一条命令装，
本插件暂不发布 npm。真要发时的前置改动：

- `package.json` 补 `publishConfig.access`（包名无 scope，可省）；
- 加 `.github/workflows/publish.yml`（tag 触发，`id-token: write` + `npm publish --provenance`）；
- README 的安装段把 GitHub 源换成 `dsh plugin add dsh-puzzle-mode`。

## 5. 提交前检查

| 项 | 命令 | 期望 |
| --- | --- | --- |
| 测试 | **不跑** | 工作约定：不写测试、不跑测试（`npm test` 里的旧自检断言钉死 v2 形状，红了不追）。验收判据写进该版本 Release 正文，交用户真机看 |
| 语法 | `for f in lib/*.js; do node --check "$f"; done` | 无输出 |
| 打包内容 | `npm pack --dry-run` | 只有 `lib/ test/ cordis.patch.yml README.md UI.md PUBLISH.md LICENSE package.json`，无密钥 |
| Release 附件 | 见「3. 发布新版本」 | Release 页有 `dsh-puzzle-mode-X.Y.Z.tgz`（**`release.sh` 不会自动传**） |
| 配置可组合 | `dsh --profile web --dump-config \| grep -A2 dsh-puzzle-mode` | 出现 `# == dsh-puzzle-mode` |

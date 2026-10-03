# v0.20.2 —— 兼容层首个 Release：站在上游 v0.20.1 上

> 这是 `SunsetRNE/dsh-puzzle-mode-2`（**兼容性复刻仓**）的第一个 Release，版本线从本仓自己的 `v0.20.2` 起算。
> 上游：[`liancha22/dsh-puzzle-mode`](https://github.com/liancha22/dsh-puzzle-mode) —— 功能取向与文档格式由它定；本仓只做「与其它 DSH 插件共存」的适配。
> 一句话分工：**上游管功能，本仓管兼容。**

## 一、这一版是什么

本仓 = **上游 v0.20.1（`43f4c19`）+ 11 个兼容提交**，兼容提交永远在最顶（rebase，不 merge 成一团）。

**来自上游**（相对本仓上一基线 `cf84e5a`）：

- v0.19.9 · 三条通用约束：规则绑触发点 / 数字带测法 / 已定回显；
- v0.20.0 · **一个会话可同时绑多个项目** —— 文档格式 v6 → **v7**，主文档新增 `当前会话:` 字段（不变量：当前 ⊆ 绑定），新增 `op:bindings` / `op:current`，拦截按全部绑定里**最严**的模式算，工作流按**命中的项目**各自注入，面板加了绑定切换条；
- v0.20.1 · 修「迁移认不出 v3 四节说明行」——老文档头永远与正文矛盾，跑多少次迁移都修不掉。

**来自本仓的兼容层**（全部自有，与上游逐字节之外的那部分）：

| 项 | 做了什么 | 入口 |
| --- | --- | --- |
| 段序可协商 | 本段默认 `10100`（排在 `dsh-infinite-gen-5` 的「真末位锚点」10150 **之前**），`PUZZLE_SECTION_ORDER=<n>` 可覆盖，导出 `SECTION_ORDER_VALUE` 供外部核对 | `lib/index.js` |
| 六条跨插件分工条款 | 域划分 / 批量优先 / 额度按轮 / 停下只停动作 / 工具按各自 schema / 末位让位 —— 与无限五代同装时规则写在同一份提示里 | `lib/index.js`（政策段） |
| 握手校验 | 核段名、段序、六条条款在场；装了无限五代时读它的 `data/arbitration.mjs` 双向对账 | `npm run verify:cross` |
| 上游同步器 | 只读体检（新提交 + 兼容面 + `merge-tree` 冲突预演）；`--apply` 才真合并 | `npm run sync:upstream` |
| 互校归档 | `compat-log.jsonl` 每行记：两侧版本、段序、规则条数、两侧判据通过数、`upstreamHead`、结论 | `npm run log:compat` |

**本版判据实测**：`npm test` 退出码 0（136 条 ok）· `verify:cross` 21 通过 / 0 失败 · 归档 `upstreamHead=43f4c19 · verdict=ok`。

## 二、安装

```bash
# GitHub 源（推荐；仓库 public，下载器不带鉴权即可拉）
python3 "$DSH_HOME/plugin-manager.py" github SunsetRNE dsh-puzzle-mode-2 v0.20.2

# 或从本 Release 附件装（离线 / 内网）
python3 "$DSH_HOME/plugin-manager.py" import dsh-puzzle-mode-0.20.2.tgz
```

装完**重启该 profile**（`patchReload: startup`），再刷新浏览器页面。
`dsh plugin --profile web add dsh-puzzle-mode` 走 npm 名不可用 —— **本包不发 npm**，见 §四。

## 三、验收判据

```bash
cd dsh-puzzle-mode-2 && npm ci
npm test                                  # 期望：退出码 0；末行「跨插件握手校验：21 通过 / 0 失败」
npm run verify:cross                      # 期望：21 通过 / 0 失败
node -e "import('./lib/index.js').then(m=>console.log('段序:',m.SECTION_ORDER_VALUE))"   # 期望：段序: 10100
node -e "import('./lib/constants.js').then(m=>console.log('格式版本:',m.PUZZLE_VERSION))" # 期望：格式版本: 7
```

真机验收（面版侧）：

1. 装完重启，`puzzle_mode` 工具可调用；对任一项目 `op:read` 能回 `mode` / 绑定信息；
2. v7 多绑定：面板绑定切换条能在多个绑定项目间换「当前」，`op:bindings` 列出全部绑定与各自模式；
3. 既有 `puzzle: 6` 的项目文档：`op:rebuild` 先 dry-run 看预览，确认后再 `apply:true`；
4. 与无限五代同装时，提示里两人的段序仍是 `10100 < 10150`，`verify:cross` 全绿。

## 四、已知与边界

- **不发 npm**：本机 token 无 npm 写权限，GitHub 源一条命令即可装；真要发 npm 的前置改动见 `PUBLISH.md` §4。
- **版本号撞车**：本仓 `v0.19.9`–`v0.19.15` 与上游 `v0.19.9` 号码相同，本仓那些段一律带「（兼容层）」后缀；**正式 Release 从本版 v0.20.2 起**，更早的兼容层改动见 `CHANGELOG.md`。
- **格式版本**：本版内核为 **v7**。既有项目文档仍写 `puzzle: 6`，装完请跑一次 `op:rebuild`（默认 dry-run，只改形状、正文一字不动）。
- **上游漂移**：`tools/sync-upstream.mjs` 是只读的，上游再前进不会自动改变本仓；跑一次就知道有没有新东西。

## 五、致谢

- 上游作者 [`liancha22`](https://github.com/liancha22)：本项目完全建立在它的实现与文档契约上；
- v0.19.8 的测试漂移修复由本仓提交、并在上游 [PR #2](https://github.com/liancha22/dsh-puzzle-mode/pull/2) 被合并，随后上游据此加了格式契约测试与 `release.sh` 发版门禁 —— 本版沿用同一套门禁。

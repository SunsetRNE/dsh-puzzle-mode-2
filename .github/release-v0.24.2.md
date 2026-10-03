# dsh-puzzle-mode v0.24.2（兼容性复刻仓 · 同步上游 v0.24.1）

> 本仓 = **上游 `liancha22/dsh-puzzle-mode` v0.24.1 + 三件上游没有的东西**。
> 这版没有自己的新功能：把上游 `v0.22.0 → v0.24.1` 的 **11 个提交**全量并回 `main`，冲突只有一处。

## 这版做了什么

| 项 | 内容 |
| --- | --- |
| **同步** | 上游 `v0.23.0 → v0.24.1` 共 **11 个提交**并入 `main`（merge commit `1f2a326`） |
| **冲突** | 只 1 个文件：`package.json` 的 `version` 与 `description` |
| **保留** | `tools/log-compat.mjs`（互校归档器）· `tools/sync-upstream.mjs`（上游同步器）· `compat-log.jsonl`（归档账本）· `tools/release.sh` 的 `RELEASE_REPO` 可覆盖 · `COMPAT.md` 瘦身版 · 拼图文档 9 份 |
| **版本号** | `0.24.2`（上游 0.24.1 + 本仓补丁号 +1；承接 v0.22.0 → v0.22.1 的先例） |

## 上游这次带来了什么

| 版本 | 内容 |
| --- | --- |
| v0.23.0 | 项目规模**小 / 中 / 大**三档，条目上限随档位放宽或收紧；删面板审查按钮 |
| v0.23.1 | 写操作返回缺绑定组 —— 修「点了又弹回去」 |
| v0.23.2 | 项目规模切换是假态 + 延时切换 |
| v0.23.3 | 规模档位三处真 bug：静默删数据 / 切档收紧 / 切项目残留 |
| v0.24.0 | **重复思考熔断**：同一工具连续 3 次同样参数调用时注入提示（新增 `lib/loopguard.js`） |
| v0.24.1 | 接续会话不再自己翻代码推进度（交给 `op:audit`）；空态中栏删掉虚线占位卡 |

## 冲突为什么只有一处

本仓与上游的差异面从 v0.22.1 起就收敛到「互校三件 + 文档」，上游改的是产品代码，两边几乎不碰同一行。
唯一必撞的是 `package.json`：上游每发一版都动 `version` 与 `description`，本仓也动 `version`。

解法是「**描述跟上游走、版本号自己 +1**」：

- `description` 取上游 v0.24.1 全文（含三档位与熔断描述）——不留分叉文本，下次同步这一行不再冲突；
- `version` 走 `0.24.2`——取上游的 `0.24.1` 会让本仓与上游**同名同版本**，`npm publish` 直接撞版；
- `scripts` 双向保留：本仓的 `log:compat` / `sync:upstream` 与上游新挂进 `npm test` 链尾的 `test/60-loopguard.test.mjs` 同时在场。

本仓相对上游 `main` 的差异收敛为 **16 个文件**，其余文件与上游逐字一致（`git diff upstream/main --stat`）。

## 验证（本仓实测）

```bash
npm test                                  # 退出码 0
# 59 / 41 / 7 / 49 项通过 + 重复思考熔断 13 通过 / 0 失败 + 跨插件握手 23 通过 / 0 失败
npm run log:compat                        # 归档一行：0.24.2 / 0.65.10 / 10120<10150 / 6 条 / 23-0 / 21-0 / ok
git merge-base --is-ancestor upstream/main HEAD && echo merged   # merged
```

归档行（`compat-log.jsonl`）：

```json
{"ts":"2026-10-03T13:50:16.418Z","forkVersion":"0.24.2","ig5Version":"0.65.10","puzzleDefaultOrder":10120,"ig5TailOrder":10150,"textProbeCount":6,"upstreamHead":"34c3394","verifyCross":{"pass":23,"fail":0},"ig5Arbitration":{"pass":21,"fail":0},"verdict":"ok"}
```

段序与共存契约未变：本仓默认 **10120**，仍小于 `dsh-infinite-gen-5` 末位锚点 **10150**，六条分工条款全在。

## 安装

```bash
npm i <本 release 附件 dsh-puzzle-mode-0.24.2.tgz>
# 或按你惯用的插件管理器装本仓；装完重启 profile 生效（patchReload: startup）
```

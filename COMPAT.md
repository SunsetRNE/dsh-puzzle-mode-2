# 本仓的定位（2026-10-03 瘦身后）

> 上游：[`liancha22/dsh-puzzle-mode`](https://github.com/liancha22/dsh-puzzle-mode)
> 本仓：`SunsetRNE/dsh-puzzle-mode-2` —— **已瘦身**：跨插件共存层归上游，本仓只留三件上游没有的东西。

## 一、为什么瘦身

上游 **v0.22.0**（`f9741ca`）把共存层**并回了主线**，逐条对应我们原先的兼容面：

| 我们当年加的 | 上游 v0.22.0 |
| --- | --- |
| 段序可协商（可 `PUZZLE_SECTION_ORDER` 覆盖）+ 导出 `SECTION_ORDER_VALUE` | **已有**（`lib/index.js`，默认 **10120**） |
| `compat.json` 可核契约 | **已有** |
| `COMPAT.md` 定位/可退役文档 | **已有** |
| `tools/verify-cross-plugin.mjs` 握手校验 | **已有** |
| CI 校验工作流 | **已有** |

我们 2026-10-02 写下的退役条件原文是「上游若把段序/共存做成自己的机制，本仓的对应改动应当**退役**」——
现在条件已满足，于是**退役**：上述五项一律取上游版本，本仓不再重复背。

## 二、本仓保留的东西（上游没有）

| 文件 | 作用 |
| --- | --- |
| `tools/log-compat.mjs` | **互校归档器**：跑两侧判据，把一行结果追加到 `compat-log.jsonl`（时间 · 双方版本 · 段序 · 文本规则数 · 两侧判据 · 结论）。CI 里也跑（只打印，不落盘）。 |
| `tools/sync-upstream.mjs` | **上游同步器**：只读拉上游、列新提交、列差异面、冲突预判；`--apply` 才真合。 |
| `compat-log.jsonl` | 归档账本（逐次核对的时间线）。 |

CI（`.github/workflows/verify.yml`）在上游原有步骤之后追加两步：**跑一次 `log:compat` 打印归档行**（CI 无推送权限，只打印）、**包内容门禁**（`npm pack` 后核 `compat.json` / `COMPAT.md` / `tools/verify-cross-plugin.mjs` / `tools/log-compat.mjs` 与三个脚本在场 —— 这条门禁真抓到过一次 `files` 字段被上游版覆盖的回归）。

用法：

```bash
npm run log:compat          # 跑一次核对并归档一行
node tools/log-compat.mjs --show   # 按时间读归档
npm run sync:upstream       # 看上游有没有新提交
```

## 三、本仓的维护纪律（瘦身后只有两条）

1. **上游改什么就跟什么**：本仓 = 上游 + 上面三件；合并冲突一般只出现在 `package.json` / `CHANGELOG.md`。
2. **数字以两侧契约互校为准**：段序、文本规则数由 `compat.json` 与 ig5 的 `data/arbitration.mjs` 双向核对；任一侧单改会被报出来。

## 四、当前已知不一致（待 ig5 侧同步）

`SunsetRNE/dsh-infinite-gen-5` 侧仍记 `PZ_ORDER_FORK_DEFAULT = 10100`（见其 issue #1），
而本仓/上游已是 **10120**（10100 与宿主内置 `WEB_SURFACE: 10100` 撞号，撞号时排序回退按段名比）。
ig5 侧改到 10120 后，`npm run log:compat` 的结论应回到 `ok`。

## 五、本仓怎么发版（fork 自己的线）

本仓与上游**同名不同仓**，而上游带来的 `tools/release.sh` 里 `REPO` 是**写死上游**的 ——
直接跑会把 Release 建到上游仓库（实测：token 无写权限 → HTTP 404；若有权限则会误发到别人的仓库）。
本仓把它改成可覆盖（默认仍是上游，保持上游原行为），发版时显式指过来：

```bash
cd /root/S/dsh-puzzle-mode-2
npm pack                                   # 产物 dsh-puzzle-mode-X.Y.Z.tgz
RELEASE_REPO=SunsetRNE/dsh-puzzle-mode-2 GITHUB_TOKEN_FILE=<token 文件> bash tools/release.sh vX.Y.Z
# 附件要单独传（脚本不做）：
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/gzip" \
  --data-binary @/tmp/dsh-puzzle-mode-X.Y.Z.tgz \
  "https://uploads.github.com/repos/SunsetRNE/dsh-puzzle-mode-2/releases/<id>/assets?name=dsh-puzzle-mode-X.Y.Z.tgz"
```

纪律：**token 不入库**（用 `GITHUB_TOKEN_FILE` 指过去，别把 token 或路径写进仓库）；发版前必过 `npm test` 与包内容门禁。

# 本仓的定位：兼容性复刻仓

> 上游：[`liancha22/dsh-puzzle-mode`](https://github.com/liancha22/dsh-puzzle-mode) —— 走它自己的功能路线。
> 本仓：`SunsetRNE/dsh-puzzle-mode-2` —— **专门做「与其它 DSH 插件共存」的适配**。
> 一句话分工：**上游管功能，本仓管兼容。**

## 一、我们在这条线上加的东西（相对上游的**全部**差异）

| 文件 | 加了什么 | 为什么 |
| --- | --- | --- |
| `lib/index.js` | 段序由写死 `10500` 改为**默认 `10100`**（排在 `dsh-infinite-gen-5` 的「真末位锚点」10150 之前），支持 `PUZZLE_SECTION_ORDER=<n>` 覆盖；导出 `SECTION_ORDER_VALUE` | 上游默认把本段排在别人末位锚点之后，对方那句「这是整份系统提示的最后一段」在本机不成立；协商成确定、可核的段序。**截至上游 v0.20.3（`a7fc197`）仍是写死 `const ORDER = 10500`，这一行仍是本仓独有贡献** |
| `lib/index.js`（政策文本） | 六条**跨插件分工条款**：域划分 / 整批题不当打断者（批量优先、文档一轮结束后幂等回写）/ 提问额度按轮的实际目的取 / 「停下」只停动作不回退 / 拼图文档只走本插件工具 / 末位让位（本段 10100 早于无限五代末位锚点 10150） | 两份载荷同装时，规则写在同一份提示里，不靠外部约定 |
| `tools/verify-cross-plugin.mjs` | 握手校验（`npm run verify:cross`，并挂到 `npm test` 链尾）：核段名/段序、六条条款在场；本机装了 `dsh-infinite-gen-5` 时读它的 `data/arbitration.mjs` 对账 | 任一侧改数字而另一侧没跟上 → 当场报错（这条真的抓到过一次漂移） |
| `UPSTREAM-ISSUES.md` | 上游测试与实现脱节的清单（已通过 PR #2 全部回贡上游） | 留档：什么问题、怎么复现、怎么修 |
| `CHANGELOG.md` | 兼容层的版本段（v0.19.8 起） | 与上游的 changelog 并存，不覆盖 |

除上表外，本仓与上游**逐字节一致**（测试文件也已与上游一致：我们的测试修复 PR #2 已被上游合并）。

## 二、与上游的同步方式（按需合并，不主动追新）

```bash
npm run sync:upstream          # 只读：拉上游 → 列新提交 → 列我们的兼容面 → 冲突预判 → 跑两侧校验
npm run sync:upstream -- --apply   # 确认无冲突时才真合并（快进或 rebase 保「兼容提交在最顶」）
```

原则：
1. **兼容提交永远在顶**：上游有新提交时 rebase（不是 merge 成一团），保证 `本仓 = 上游 + 兼容面`。
2. **合完必须跑两边判据**：`npm test`（上游那套，现在全绿）+ `npm run verify:cross`（握手校验）。
3. **上游已采纳的东西不再自己留一份**：例如测试漂移修复已由 PR #2 进上游，本仓就直接用上游的版本，
   自己不再重复背这段补丁 —— 这正是 `tools/sync-upstream.mjs` 会提示的那种「可回收的本地提交」。

## 三、边界

- 本仓**不改上游的功能取向**：提问额度、文档格式、面板交互都跟上上游；我们只动「共存」相关的部分。
- 兼容层不依赖特定机器的绝对路径来运行插件本身（握手脚本里的 `/root/.dsh/...` 只是**本机对账用**的查找顺序，
  找不到就跳过并标注，不作为判据失败）。
- 上游若把段序/共存做成自己的机制，本仓的对应改动应当**退役**（sync 脚本会在检测到上游已实现时提示）。

## 四、互校结果的归档

核对是**逐次实测**出来的数字，「哪天开始漂」只能靠一行行带时间戳的记录回答：

```bash
npm run log:compat            # 跑两侧判据，把一行结果追加到 compat-log.jsonl
node tools/log-compat.mjs --show --n=50   # 按时间读归档
```

一行记录：时间 · 本仓版本 · 对方版本（不在场则记「不在场」）· 两侧段序声明 · 文本规则条数 ·
两侧判据通过数 · 结论（`ok` / `drift`）。CI 里同样跑这一步（只打印，不落盘 —— CI 无推送权限），
所以每次运行的这一行也留在 Actions 日志里。

## 五、本仓怎么发版（fork 自己的线）

本仓与上游**同名不同仓**：上游 `liancha22/dsh-puzzle-mode`，本仓 `SunsetRNE/dsh-puzzle-mode-2`。
`tools/release.sh` 与 `tools/sync-releases.sh` 里的 `REPO` 默认仍是上游，直接跑会把 Release 建到**上游仓库**——
两个脚本都改成读 `RELEASE_REPO`（默认值是上游，保持原行为），本仓发版时显式指过来：

```bash
cd /root/S/dsh-puzzle-mode-2
# 1) 版本号（package.json）+ 发版说明（.github/release-vX.Y.Z.md，正文就是它）
# 2) 门禁：npm test 必须全绿；语法与包内容顺手过一遍
for f in lib/*.js; do node --check "$f" || echo "FAIL $f"; done
npm pack --dry-run        # 期望只有 lib/ test/ cordis.patch.yml README.md UI.md PUBLISH.md LICENSE package.json
# 3) 打 tag 并推（走 SSH；tag 已存在用 -f + push -f origin vX.Y.Z）
git tag -f vX.Y.Z && git push origin vX.Y.Z
# 4) 建 Release：repo 指本仓，token 走 GITHUB_TOKEN_FILE
GITHUB_TOKEN_FILE=<你自己的 token 文件> RELEASE_REPO=SunsetRNE/dsh-puzzle-mode-2 bash tools/release.sh vX.Y.Z
# 5) 传附件（release.sh 不会做，必须单独传）
npm pack && curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/gzip" \
  --data-binary @dsh-puzzle-mode-X.Y.Z.tgz \
  "https://uploads.github.com/repos/SunsetRNE/dsh-puzzle-mode-2/releases/$RID/assets?name=dsh-puzzle-mode-X.Y.Z.tgz"
```

两条纪律：

1. **token 内容不入库**：本机默认的 `~/.dsh/.github-token` 在本机**不存在**，实际可用的是另一个工作区里的 PAT（归属 `SunsetRNE`，`repo` 作用域）
   —— 用 `GITHUB_TOKEN_FILE` 指过去即可，别把 token 或它的路径写进仓库。
2. **附件的正文会过期**：`README.md` / `UI.md` / `PUBLISH.md` / `package.json` 都在 `files` 里，
   改完文档要重传附件（先删旧附件再传，否则会出现 `-1` 后缀的同名附件）。
3. **发版前核包内容**：`npm pack --dry-run` 里必须看到 `compat.json`、`COMPAT.md`、`tools/verify-cross-plugin.mjs`
   —— v0.20.2 漏了这三个，装出来的包里 `npm test` 直接在握手校验那步 ENOENT（v0.20.3 修）。

## 六、上游跟到哪一步：可退役清单（2026-10-02 实测）

判断「本仓的某项兼容改动还要不要背」不能靠感觉，要靠**可核证据**。这里记的是当前证据与退役条件：

| 兼容项 | 上游有没有 | 证据（怎么核的） | 可退役条件 |
| --- | --- | --- | --- |
| 段序可覆盖（默认 10100 + `SECTION_ORDER_VALUE`） | **没有** | 上游 `a7fc197` 的 `lib/index.js` 仍是 `const ORDER = 10500`（`git show upstream/main:lib/index.js`）；本仓 HEAD 是 IIFE 版；装机副本 sha256 与本仓 HEAD 一致 | 上游源码里出现 `SECTION_ORDER_VALUE` 或 `PUZZLE_SECTION_ORDER` 时，本仓这行退役 |
| 六条跨插件分工条款 | **没有** | 上游政策文本里没有 `[跨插件仲裁]` 相关条款 | 上游自行写入分工条款时退役 |
| 握手校验 `verify:cross` + `compat.json` 契约 | **没有** | 上游无 `tools/verify-cross-plugin.mjs` / `compat.json` | 上游做出对等机制时，本仓改成调用上游的 |
| 上游同步器 `sync:upstream` / 互校归档 `log:compat` | **没有** | 上游无对应脚本 | 本仓维护成本大于收益时合并或删 |

### 装机副本到底是谁的构建（易错点）

本仓与上游**同名**（`dsh-puzzle-mode`），`package.json` 的 `repository` 字段也仍指向上游 —— 所以「看版本号 / 看 repository」**判不出来源**，只能比对内容：

```bash
INST=/root/.dsh/plugin-src/dsh-puzzle-mode/lib/index.js
sha256sum "$INST"                                   # 装机副本
git show HEAD:lib/index.js | sha256sum              # 本仓 HEAD
git show upstream/main:lib/index.js | sha256sum     # 上游
# 2026-10-02 实测：装机 = 本仓 HEAD（c6a4601572db43a8…），与上游（26eb36dd1e555e6a…）不同
```

结论：**装机的那份 0.20.3 是本仓的构建**，不是上游的 —— 曾经据「版本号 0.20.3 + 段序可覆盖」误判成「上游跟进了」，
比对 sha256 才发现搞反了。以后凡是「上游是否跟进」的断言，一律附一条这样的比对命令。

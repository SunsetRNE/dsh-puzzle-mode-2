# 上游问题报告（dsh-puzzle-mode）

> 本文件由复刻仓 `SunsetRNE/dsh-puzzle-mode-2` 维护，记录**上游仓库测试与实现不同步**的具体问题、
> 复现方式与修法。所有结论都在本机实跑过；未向上游推送任何东西（推不推由仓库主人决定）。
> 记录时间：2026-10-02 · 上游基线：`f6ee2d4`（v0.19.7）· 本仓状态：v0.19.8

## 一、一句话结论

上游 HEAD 的 `npm test` **本身是红的**：4 个测试文件里 3 个失败（10-puzzle 首个断言即挂、20-client 0 通过、
30-rpc 13 通过后挂，只有 40-pre-execute 全绿）。原因是**实现按文档格式 v4→v6 改造过，测试没有跟着改**，
于是断言停在旧 API 与旧文案上。本仓已把**全部**漂移改成现行契约 —— `npm test` 现在**零跳过、退出码 0**。

## 二、复现

```bash
git clone git@github.com:SunsetRNE/dsh-puzzle-mode.git && cd dsh-puzzle-mode
npm ci
npm test          # 上游：退出码 1（首个失败即抛）
#   test/10-puzzle.test.mjs → AssertionError: 主文档缺少 ## 检索索引
#   test/20-client.test.mjs → AssertionError: 提问模板必须可测（导出）
#   test/30-rpc.test.mjs    → 13 通过后 AssertionError
#   test/40-pre-execute.test.mjs → 全绿
```

本仓（修复后）：

```bash
cd dsh-puzzle-mode-2 && npm ci && npm test
#   10-puzzle：55 项通过 / 0 项漂移标记
#   20-client：UI 内部交互两处已按现行 markup 重写（见 §3.3），无跳过
#   30-rpc：31 项通过
#   40-pre-execute：6 项通过
#   跨插件握手校验：13 通过 / 0 失败
```

## 三、问题清单（按类别）

### 3.1 文档格式 v4 → v6（影响 `test/10-puzzle.test.mjs`，共 14 条断言）

| 旧断言 | 现行事实 | 修法 |
| --- | --- | --- |
| 主文档含 `## 检索索引 / ## 用户原话 / ## 悬而未决 / ## 已定 / ## 撤销` 六节 | v6 只留五节：`模块索引 / 源码索引 / 工具索引 / 坑 / 工作流` | 断言改五节 |
| `sectionCounts` 的键是 `index,pit,quote,pending,decided,revoked` | 现行键是 `index,source,tools,pit,workflow` | 同步键集 |
| 主文档 `decided/pending` 计入模块「可拓展性」 | **项目级决策载体已取消**（`lib/health.js:169`）；只有模块文档的 `pending/decided` 计分 | 改为断言主文档写 `decided` 被拒（`未知小节`）+ 模块写入后 40 分 |
| 项目级显式分数当模块缺省值（`healthSources.quality === 'project'`） | `updateProjectHealth()` 现在只回 `{ok:false}` + 指路 `op:health` | 改为测「拒写 + 指路」 |
| 模块 `related` 合体小节承载已定/悬而未决 | v6 拆成 `pending` / `decided` | 分两次写 |
| 条目写裸行（`- 一条要点`） | v6 要求每条带 `（源码: 文件:行）`，否则**写入被拒**（`条目缺少源码出处`） | 测试数据补出处 |
| `pendingMigrations(1).length === 1` | v1 到当前是**多步链**（v1→v2→…→v6） | 改 `>= 1`，仍断言当前版本 0 |
| `planRebuild(...).migrations.length === 1` | `migrations` 是**步骤标签数组**（长度 = 步数） | 改 `>= 1`，其余字段（`version/targetVersion/outdated`）保留 |
| `rebuildProject` 后 `written.length === 3` 且正文按旧节保留 | 迁移后模块文档按 v6 重组 | 改为断言模块文档仍含原要点行（`要点一/二/三`） |
| `auditOf` 的「完成度满 / 要点为空」用裸要点补位 | 同上：要点必须带出处才有分 | 补出处 |
| `AUDIT_PROMPT` 含「最弱的一维 / 可执行的下一步」 | 现行文案是「四段结构 + 带数字 + 禁空话」 | 改断言关键词 |
| `audit-demo` 复用同一模块验「自封分数」 | 前面的用例已给它写了证据，warn 自然不触发 | 该条**自带干净模块**（自包含） |

### 3.2 RPC 形状（影响 `test/30-rpc.test.mjs`）

| 旧断言 | 现行事实 | 修法 |
| --- | --- | --- |
| `op:'audit'` 返回 `health: number` | audit 回执**没有** `health`；有 `declaredHealth` / `trueHealth` / `ranking` / `dimensionMeta` / `findings` / `fixPlan` | 断言改 `trueHealth` / `declaredHealth` |
| 回执带 `prompt: string`（审查指令全文） | 字段名 `promptIn`，且**内容是指针**（「提示段的『### 审查（op:audit）』一节（要原文给 verbose:true）」） | 断言改为「指针契约」 |
| `sections` 是「主文档六节」的计数 | v6 五节 | 文案与键集同步 |

### 3.3 客户端导出与 UI 内部（影响 `test/20-client.test.mjs`）

| 旧断言 | 现行事实 | 状态 |
| --- | --- | --- |
| `mod.questionTemplate` 是函数 | 该导出**已不存在**（提问相关由 `interviewTemplate` 承担）；实际导出还有 `resumeTemplate / refactorTemplate / adoptTemplate / newDocTemplate / workflowTemplate` | ✅ 已改 |
| 模板必须含固定收尾问（「要不要先停下？」与两个固定选项） | 模板**不再内嵌**该问；「每轮提问末尾必问停下」由 policy 段与 ask 流程统一要求 | ✅ 已改（改核模板实质：真岔路 / 取舍 / 额度） |
| 模板必须有 `1. `–`5. ` 编号槽位、不得有第 6 槽 | 编号槽位已取消，上限由 `ASK_MAX_QUESTIONS` 约束（现行 10） | ✅ 已改 |
| 面板必须有「提问模板」按钮 | 该按钮**已按用户裁定删除**（`lib/client.js` 顶部注释写明） | ✅ 已反向断言（删除即正确） |
| 面板必须有「审查」按钮且点击后 `setDraft` +1 | 面板改为一屏**分状态渲染**，审查入口不再是子文本为「审查」的 `<button>`（现行：`title` 含「按五维审查这个项目」、子文本「审查（交给 AI）」），点击走 `askAi → setDraft` | ✅ 已改（按 `title` 定位 + 断言恰好一次 `setDraft` 且含 `op:audit`） |
| 空态「采访后再建」填的是含「最多 5 问」的采访模板 | 现行额度是 10 问（`ASK_MAX_QUESTIONS`） | ✅ 已改（`/最多 \d+ 问/`，不写死数字） |

## 四、给上游的建议（不只是改测试）

1. **测试与实现同版本化**：断言里凡是「5 问 / 六节 / `related` / `questionTemplate`」这类数字与名字，
   都改成引用 `lib/constants.js` 的常量与导出名 —— 改一处实现不必再满仓找断言。
2. **给「文档格式版本」加契约测试**：一条测主文档五节、一条测条目必须带 `（源码: 文件:行）`。
   这两条能让「下次改格式」当场变红，而不是几个月后以漂移形式爆出来。
3. **`npm test` 应当作为发版门禁**：上游 v0.19.7 的 tag 是在测试全红的状态下打出来的。


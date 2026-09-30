## 下载安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.14.0
```

或直接下载附件：[dsh-puzzle-mode-0.14.0.tgz](https://github.com/liancha22/dsh-puzzle-mode/releases/download/v0.14.0/dsh-puzzle-mode-0.14.0.tgz)

装完**重启 profile**，再刷新页面。

---

## 一、适配官方 0.2.0-rc.2

本插件只 peer 依赖运行时提供的 `@deepseek-ai/dsh-tools`，因此适配的关键是**契约**而不是版本号。
逐面包对比了 `0.1.7-rc.2` 与 `0.2.0-rc.2`：

| 插件用到的面 | rc1 → rc2 的差异 | 结论 |
| --- | --- | --- |
| `tools`（`defineTool` / `tools/pre-execute`） | 类型与实现签名逐字相同 | 无破坏性变更 |
| `systemPrompt.section` | `lib` 目录 diff 为空 | 无破坏性变更 |
| `webServer.register` + `connection.requestRejection` | 类型与实现逐字相同 | 无破坏性变更 |
| `client-modules`（`__ModuleLoader__.load`） | 加载器契约不变 | 无破坏性变更 |

`conversation.input.left` 的 slot 契约与注入 props 也逐字对比过，`inputActions.setDraft` 仍在
（面板的「填模板」靠它）。

**唯一真会挡住安装的一处**：`peerDependencies` 里的 `@deepseek-ai/dsh-tools` 写的是 `^0.1.5-rc.2`。
按 semver 的预发布规则，这个范围**连已装的 `0.1.7-rc.2` 都不满足**，更不满足 `0.2.0-rc.2`
（预发布版本只有**同 tuple** 的 comparator 才认）。已改成显式列举：

```json
"@deepseek-ai/dsh-tools": "^0.1.5-rc.2 || ^0.1.6-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.2"
```

已实测：把插件的宿主半加载到 **rc2 的 `dsh-tools`** 上，`defineTool` 正常产出工具、
`tools/pre-execute` 正常注册、工具的 JSON Schema 被 rc2 的参数校验接受
（非法 `action` / 坏类型 `index` 会被 rc2 直接抛 `INVALID_ARGS` 拦下）。

## 二、主文档新增第五节「## 工作流」

**文档格式 v3 → v4**（主文档四节 → 五节）。`op:read` 会报 `outdated: true`，
用 `op:rebuild` 迁移（默认 dry-run）。

工作流是**约束模型在特定操作下不去做别的事**的规则，随提示段注入，模型每一步都读得到：

```jsonc
{ "op": "main", "section": "workflow", "content": "- 只改 lib/ 时动代码，别顺手改文档" }
{ "op": "main", "section": "workflow", "content": "- 审查先出清单，别直接改源码", "append": false }
```

- **≤5 条**（`ENTRY_CAPS.workflow`），超了**删最旧**——与「悬而未决 ≤4」同属硬规则；
- 每条 ≤50 字；
- **不要求源码出处**（它约束的是行为，不是对代码事实的断言；强行要求只会逼出编造的出处）；
- 它**不写业务目标**——目标是 `> 目标：` 那一行；
- 每次 `op:read` 的返回里都带 `workflow` 数组，模型必须遵守。

### 一键删除（可回滚）

删掉的条目**进 front-matter 的 `工作流归档:`**（≤10 条），与正文分离存放，
所以**归档不占用 5 条上限**——删 10 条也不会把工作流挤空。

```jsonc
{ "op": "workflow", "action": "remove",  "index": 2 }   // 删工作流第 2 条，进归档
{ "op": "workflow", "action": "restore", "index": 1 }   // 把归档第 1 条恢复回工作流
```

序号一律 **1 起**。两条刻意设计的边界：

- **越界报错不猜**：`index: 99` 会返回「工作流只有 5 条，删不了第 99 条」。
  面板传的是它渲染出来的序号，错位说明界面已过期——这时候「尽力而为地删一条」
  比拒绝更危险，用户会以为删的是他点的那条。
- **恢复挤满时如实报 `evicted`**：工作流已满 5 条时恢复会挤掉最旧的一条，
  返回值里写明挤掉了谁，不让用户以为「恢复是免费的」。

## 三、面板：主文档查看 + 工作流模板

- **「主文档」按钮**：只读渲染主文档**全文**（含 front-matter 与五节），等宽字体、
  保留换行、可滚动。工作流的条目与归档也在这一块下面。
  **只读**是刻意的：面板给一个能编辑的框就等于开了第二条写入通道，
  条目限长 / 条数上限 / slug 过滤 / 路径守卫会被一次编辑全部绕过——那正是「文档锁」要防的事。
- **工作流区**：每条带 1 起编号与「✕ 删除」（**二次确认**，因为这是面板里唯一会改主文档的动作），
  归档区每条带「恢复」，空归档显示「暂无删除记录」。
- **「工作流模板」按钮**：一键把提示词填进输入框（**不自动发送**），
  引导先问清目标与边界，再用 `op:main section:'workflow'` 把确定下来的条目写进主文档。

## 四、审查升级为「执行方」

审查不再只是「拆代码 + 看文档真实值」，产出是**可执行修复清单** `fixPlan`：

```
{ kind, severity, target, fact, fix, expect }
```

五类 `kind`：

| kind | 谁给 | 内容 |
| --- | --- | --- |
| `structure` | 插件（源码体检） | 大文件、巨函数、目录不分层 |
| `doc` | 插件（文档体检） | 条目超长/缺出处、规范外小节、旧格式 |
| `health` | 插件（证据 vs 声明） | 手写分虚高、全公式推导、最弱一维 |
| `vulnerability` | **模型读源码后补** | 边界/空值/竞态/错误吞掉/路径越界 |
| `redundancy` | **模型读源码后补** | 重复实现、死代码、可合并的抽象 |

后两类**不由插件生成**：体检读不到函数体，编出来就是假漏洞。所以清单里明确分工，
由模型读代码后补，每条必须给 `文件:行`。

**动手边界（硬规则，写在提示段与 `prompt` 里）**：
先给用户看清单 → 用 `ask_user_question` 问「哪些现在就改」→ **用户点了才改源码** →
改完**必须重跑一次 `op:audit` 复测**，没消失就说没消失，不许宣布修好。
**审查轮本身不改源码。**

五维改真实值**降级为清单里的一项**（`kind: health`），不再是审查的主线。
诚实边界保留：`fromSource === null` 表示没有源码可查、那一维不是实测值；
没查到源码时只出一条「没查到源码」，不编任何文件级问题。

---

## 验收判据

- 面板出现「主文档」按钮：点开能看到主文档**原文**（含 `---` front-matter 与五节标题），
  内容与 `cat 拼图/主文档.md` 一致，且**不能编辑**；
- 面板出现「工作流模板」按钮：点一下 → 输入框被填入模板（**不自动发送**）；
- 工作流区：`op:main section:'workflow'` 写 5 条后，第 6 条会把第 1 条挤掉；
  点某条「✕ 删除」→ 弹确认 → 该条从工作流消失、出现在「归档」里 →
  点「恢复」→ 回到工作流；`cat 拼图/主文档.md` 能看到 `工作流归档: [...]` 一行；
- `op:read` 的返回里有 `workflow` 数组；`sections.workflow` 是条数；
- 旧项目（`puzzle: 3`）调 `op:read` 报 `outdated: true`；
  `op:rebuild` 预览里能看到「补小节 ## 工作流」与「v3 → v4」，`apply:true` 后
  主文档多出 `## 工作流` 一节，**正文一字未动**；
- `op:audit` 的返回里有 `fixPlan`（非空、每条六个字段齐全、severity 降序），
  `prompt` 里写明「先问用户再改源码、改完重跑复测」；
- 拿一个 800 行以上的源码文件当 `源码根`，`op:audit` 的 `fixPlan` 里应出现
  `structure` 条目，`target` 精确到 `文件:行`。

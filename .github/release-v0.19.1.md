## 下载安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.19.1
```

或直接下载附件：[dsh-puzzle-mode-0.19.1.tgz](https://github.com/liancha22/dsh-puzzle-mode/releases/download/v0.19.1/dsh-puzzle-mode-0.19.1.tgz)

装完**重启 profile**，再刷新页面。

---

## 这一版修什么

v0.19.0 的「新会话直接发需求 → 自动走采访后再建」在**发版前的核对**里被抓出两个真缺陷，
再加上一轮 `op:audit` 审查出的三条（漏洞 1 + 冗余 2）。这一版把它们一起修掉。
**没有新功能**——只修 v0.19.0 自己的问题。

### 缺陷 ① · `step === 1` 不是「新会话」，是「本轮第一步」

`AgentLoop` 在**每个 turn 收尾**都把 `phase.step` 归零（`dsh-agent-loop` 的
`turn()`：`phase.step = 0`），所以 `step === 1` 的含义是「**这一轮**的第一步」。
配上只存内存的 `hasFired`（进程重启即清空），一个**冷恢复的历史会话**
下一条消息就会命中 `step === 1`，被当成「本会话的第一条需求」——
用户只是接着说了一句话，插件却开始采访。

**修法**：判据改成 `turn === 1 && step === 1`。`turn` 来自 `turnBoundary`
**会话投影**，由持久化日志重建，跨进程成立。`detectFirstRun` 收第三个参数
`turn`；不给 `turn` 时退回旧口径，纯函数对旧调用点仍可用。

### 缺陷 ② · 子代理被当成「用户的第一条需求」

hook 注册在**根级 ctx** 上，对进程内每个 agent 都生效。而子代理
（`subagent` 工具与 teammate）的**首条 prompt 同样是 `role:'user'` +
`source.kind:'user'`**（实测 `dsh-subagent-in-process-driver` 与 `dsh-subagent`
的 continuable 路径都是 `createUserMessage({content: prompt, source:{kind:'user'}})`）。
父会话没绑项目时，子代理会被注入「**去问用户**要目标 / 模块怎么划」——
可子代理**没有用户可问**，它只能把这条提示当成任务的一部分，纯属污染。

**修法**：新增 `isDelegatedSession(agent)`，按会话头部（持久化字段，冷恢复后仍成立）
判 `origin === 'subagent'` / `parentSession` 非空 / `delegationDepth > 0`，
兜底再看 `AgentOptions.subagentDepth`；命中就完全不注入。

### 审查发现 ③ · `markFired` 落闸太早（漏洞）

`lib/index.js` 里原先先 `markFired(sessionId)` 落闸，**再**去
`listProjects` / `firstRunHint` / `makeContextMessage` 造上下文。
这几步任一抛错，都会被同一个 `catch (_error)` 吞掉并原样放行——
**闸门已经关上、提示却没注入**，而 `op:read` 的 `firstRun.fired` 从此报 `true`。
「报 fired=true」与「真的注入了」不再等价，会话也再不会重试。

**修法**：把上下文**先造好**，`markFired` 挪到 `return` 前最后一步。

### 审查发现 ④ · `resetFired` 是死导出（冗余）

`resetFired` 被 `lib/puzzle.js` 导出、`lib/index.js` 导入，但**全仓库无任何调用点**；
它注释里写的「面板『重新判定』按钮」在 `lib/client.js` 里并不存在。

**修法**：删掉 `resetFired` 及其导入导出（不新增面板入口——那属于新功能，不在补丁范围）。

### 审查发现 ⑤ · 触发条件文案漂移（冗余）

同一套触发条件原先在 4 处各写一份。v0.19.0 把判据改成
`turn === 1 && step === 1` 并新增「不是子代理」之后，`lib/summary.js` 的 `note`
**没跟上**，于是**面板显示的规则与真实判据互相矛盾**——
读面板的人会以为 `step === 1` 就够。

**修法**：新增 `FIRST_RUN_CONDITIONS` 作为**唯一文案来源**（`lib/firstrun.js` 导出），
`summary.js` 的 `note` 与提示段都引用它。以后改判据只改一处。

---

## 验收判据

装完重启 profile、刷新页面后：

**缺陷 ①② 的回归**（v0.19.0 的验收判据仍然适用）

- **新开会话**直接发一条需求（例如「帮我做一个贪吃蛇游戏」）→
  模型应**先采访**（≤5 问，用可点选项），**不**直接 `op:init`；`firstRun.fired` 应变 `true`；
- **恢复的旧会话**：找一个早先的会话（有历史轮次），重启 profile 后发一条新消息 →
  **不应**出现采访提示；`firstRun.fired` 应为 `false`；
- **子代理**：在一个**未绑项目**的会话里用 `subagent` 派一个活 → 子代理侧
  **不应**收到「去采访用户」的上下文；
- 新会话只发「你好」→ 不触发；发「别采访，直接建」→ 跳过采访直接建。

**缺陷 ③ 的判据**

- 触发一次采访流程后跑 `puzzle_mode{op:'read'}`：
  `firstRun.fired` 为 `true` **当且仅当**模型确实收到了那条「采访后再建」的上下文——
  两者不再出现「报了 fired 但没注入」的假状态。

**缺陷 ④⑤ 的判据**

- `puzzle_mode{op:'read'}` 返回的 `firstRun.note` 里应出现
  `turn===1` 与「不是子代理」字样（与真实判据同源，不再各写一份）；
- barrel 不再导出 `resetFired`。

---

## 附带

- **无 API 破坏**：`detectFirstRun` 只是**新增**第三个可选参数 `turn`；
  删掉的 `resetFired` 无任何调用点（含测试）；
- **不引入新的运行时依赖**：注入的消息仍按 `dsh-llm` 的 `createMessage` 形状自己造
  （`{id, role, content, source}`，冻结），与官方 `createUserMessage` 产物字段与内容一致。
  原因是 `@deepseek-ai/dsh-llm` **不在本插件的 peerDependencies 里**——
  静态 import 会让「宿主没装它」变成加载期硬失败，把整个插件拖垮；
- 同版本仍包含 v0.18.0 的审查判据重做（文件行数 → 函数形状）。

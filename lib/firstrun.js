/**
 * 首轮自动判定：新会话**直接发需求**时，自动走「采访后再建」。
 *
 * 为什么需要它：`采访后再建` 原先只是面板上的一颗按钮，把提示词填进输入框，
 * **要用户自己点、自己发**。用户新开一个会话、直接把需求打出来时，这条路根本不会触发——
 * 模型可能直接开始写代码，或者建一个没采访过的空壳项目。
 *
 * 设计（用户裁定）：
 *   1. **hook 确定性判定 + 提示段兜底**：判定由宿主侧 hook 做（不依赖模型自觉），
 *      提示段里同时写明规则作为第二道——模型自己也能照做；
 *   2. **触发口径**：新会话的**首条非空文本**，且本会话**还没绑项目**；
 *   3. **先查再问**：工作区里已经有项目时，先问用户「绑它还是新建」，
 *      不直接采访——避免把已有项目又建一遍；
 *   4. **能跳**：用户说「别采访 / 直接建 / 不用问」就跳过采访。
 *
 * 本文件是**纯逻辑**：不碰 fs、不碰 ctx，只做「这条消息该不该触发」与「注入什么文本」。
 * 这样它可以被单独 import 测试，也让 hook 本体保持薄。
 */
import { randomUUID } from 'node:crypto'

/** 触发时注入的文本（作为一条 user 上下文消息，紧跟在用户需求之后）。 */
export const FIRST_RUN_MARK = '【拼图模式 · 首轮自动判定】'

/**
 * 触发条件的**唯一文案来源**。
 *
 * 为什么收成常量：同一套条件原先在 4 处各写一份（提示段、release 正文、README 表、
 * `summary.js` 的 `note`），v0.19.0 把判据从 `step === 1` 改成 `turn === 1 && step === 1`
 * 并新增「不是子代理」之后，`note` 那份**没跟上**，于是面板显示的规则与真实判据
 * 互相矛盾——读面板的人会以为 `step === 1` 就够。
 * 以后改判据只改这里，其余地方引用它。
 */
export const FIRST_RUN_CONDITIONS = '首轮（本会话第一轮 turn===1 且 step===1）'
  + ' + 不是子代理（origin !== "subagent"）'
  + ' + 用户发的非空文本'
  + ' + 本会话未绑项目'
  + ' + 不是寒暄、用户也没说「别采访」'

/**
 * 造一条 user 上下文消息。
 *
 * 为什么**不**直接 import `@deepseek-ai/dsh-llm` 的 `createUserMessage`：
 * 那个包**不在本插件的 peerDependencies 里**（本插件只 peer `dsh-tools`），
 * 静态 import 会让「宿主没装 dsh-llm」变成一个**加载期硬失败**——整个插件都起不来。
 * 首轮判定是锦上添花的功能，**绝不能**因为它把插件拖垮。
 *
 * 这里按 `dsh-llm` 的 `createMessage` 形状自己造（`{id, role, content, source}`，
 * 冻结防改），实测与 `createUserMessage` 产物同形。真装了 dsh-llm 时产物也一致——
 * 那个函数本身也只是 `createMessage({...input, role:'user'})` 的一层薄包装。
 */
export function makeContextMessage(text, sourceKind = 'puzzle-first-run') {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: String(text ?? '') })]),
    source: Object.freeze({ kind: sourceKind }),
  })
}

/**
 * 用户明确说「别采访」的说法。
 *
 * 只在**句首**匹配（配合 `isSkipRequest` 的短句规则）：跳过是一条命令，
 * 命令总是开门见山。放在句中的多半是需求描述本身——实测反例：
 * 「这个功能别采访用户，要保留提问流程…」是一条**需求**，不该被当成跳过指令。
 */
const SKIP_PATTERNS = [
  /^(别|不|不用|不要|无需|免|勿)(采访|问|提问)/,
  /^直接(建|创建|开|做)/,
  /^跳过(采访|提问)/,
]

/** 短句阈值：不超过这个字数时，句中出现跳过字样也算命令（「就按这个来吧，别采访」）。 */
const SKIP_SHORT_LIMIT = 20

/** 句中匹配（只用于短句）：跳过字样出现在中间也算。 */
const SKIP_ANYWHERE = [
  /别采访/, /不采访/, /不用采访/, /不要采访/, /免采访/, /跳过采访/, /跳过提问/, /不用问/,
]

/**
 * 这条用户文本算不算「跳过采访」的请求。
 *
 * 两条口径（都是为了不误伤真实需求）：
 *   - **句首**出现跳过字样 → 一定是命令，多长都算；
 *   - **句中出现**跳过字样 → 只在**短句**（≤20 字）里算，长需求里的同样字眼是描述。
 */
export function isSkipRequest(text) {
  const value = String(text ?? '').trim()
  if (value === '') return false
  if (SKIP_PATTERNS.some((pattern) => pattern.test(value))) return true
  if ([...value].length > SKIP_SHORT_LIMIT) return false
  return SKIP_ANYWHERE.some((pattern) => pattern.test(value))
}

/** 用户「只是在打招呼 / 只是寒暄」——不值得触发采访。 */
const GREETING_PATTERN = /^\s*(hi|hello|hey|你好|您好|在吗|哈喽|嗨|早上好|晚上好|下午好)[\s!！。.~～]*$/i

/**
 * 从一条消息里取出纯文本（只认文本块；带图 / 带文件的按「没有文本」处理）。
 *
 * 消息形状来自 `@deepseek-ai/dsh-llm` 的 `createUserMessage`：
 * `{ role:'user', content:[{type:'text', text}...] }`。
 * 这里对多种可能形状都做兼容，取不到就返回空串。
 */
export function textOfMessage(message) {
  if (message === null || message === undefined || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string' && (block.type === undefined || block.type === 'text')) parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * 这个 agent 是不是**被委派出来的子代理**（`subagent` 工具 / teammate）。
 *
 * 为什么必须单独判：本 hook 注册在**根级 ctx** 上，对进程内每个 agent 都生效；
 * 而子代理的**首条 prompt 同样是 `role:'user'` + `source.kind:'user'`**
 * （实测 `dsh-subagent-in-process-driver` 的 `createUserMessage({content: prompt, source:{kind:'user'}})`
 * 与 `dsh-subagent` 的 continuable 路径都是如此）。不判的话，父会话没绑项目时
 * 子代理会被注入「**去问用户**要目标 / 模块怎么划」——可子代理**没有用户可问**，
 * 它只能把这条提示当成任务的一部分，纯属污染。
 *
 * 三个判据都取自会话头部（`SessionHeader`，持久化字段，冷恢复后仍成立）：
 *   - `origin === 'subagent'`：子代理会话的创建标记；
 *   - `parentSession` 非空：有父会话即被委派；
 *   - `delegationDepth > 0`：委派深度（一次性子代理走 `subagentDepth`）。
 */
export function isDelegatedSession(agent) {
  if (agent === null || agent === undefined || typeof agent !== 'object') return false
  const session = agent.session
  const header = session !== null && session !== undefined && typeof session === 'object' ? session.header : undefined
  if (header !== null && header !== undefined && typeof header === 'object') {
    if (header.origin === 'subagent') return true
    if (typeof header.parentSession === 'string' && header.parentSession !== '') return true
    if (Number.isSafeInteger(header.delegationDepth) && header.delegationDepth > 0) return true
  }
  // 兜底：一次性子代理把深度写在 AgentOptions 上（`subagentDepth`）。
  const options = agent.options
  if (options !== null && options !== undefined && typeof options === 'object') {
    if (Number.isSafeInteger(options.subagentDepth) && options.subagentDepth > 0) return true
  }
  return false
}

/** 这条消息是不是**用户自己发的**（不是插件注入的上下文、不是工具结果）。 */
export function isUserMessage(message) {
  if (message === null || message === undefined || typeof message !== 'object') return false
  if (message.role !== 'user') return false
  const source = message.source
  // 插件注入的上下文消息同样是 role:'user'，但带 source.kind（如 agent-instructions）。
  // 认不出来源时按「用户发的」处理——宁可多触发一次，也不要漏掉真实需求。
  if (source !== null && source !== undefined && typeof source === 'object') {
    const kind = source.kind
    if (typeof kind === 'string' && kind !== '' && kind !== 'user') return false
  }
  return true
}

/**
 * 判定「本次是不是新会话的首条需求」，返回要不要触发采访、以及为什么。
 *
 * `messages` 是本 step 认领到的消息；`step` 是**本轮**步号；`turn` 是轮号。
 * 只有同时满足才触发：
 *   - `turn === 1 && step === 1`——「新会话首条需求」的判据；
 *   - 认领到至少一条**用户发的、非空文本**消息；
 *   - 用户没说「别采访」；
 *   - 不是纯寒暄（「你好」这种不值得起采访流程）。
 *
 * ⚠️ **为什么必须看 `turn`，不能只看 `step === 1`**（这是一个真实缺陷）：
 * `AgentLoop` 在**每个 turn 开始时把 `phase.step` 归零**（见 `dsh-agent-loop`
 * 的 `turn()` 收尾：`phase.step = 0`），所以 `step === 1` 的含义是
 * 「**本轮**第一步」而不是「本会话第一步」。配上只存内存的 `hasFired`
 * （进程重启即清空），一个**恢复了的历史会话**下一条消息就会命中
 * `step === 1`，被当成「本会话的第一条需求」注入采访提示。
 * `turn` 来自 `turnBoundary` **会话投影**，由持久化日志重建、跨进程成立，
 * 所以 `turn === 1` 才是「本会话第一轮」的真判据。
 *
 * 返回 `{ trigger, reason, text }`；`reason` 用于日志与面板诊断，不抛错。
 */
export function detectFirstRun(messages, step, turn) {
  // 给了 turn 就以 turn 为准（生产路径）；没给时退回只看 step，
  // 保持这个纯函数对旧调用点仍可用。
  if (Number.isSafeInteger(turn)) {
    if (turn !== 1 || step !== 1) return { trigger: false, reason: 'not-first-turn', text: '' }
  } else if (step !== 1) {
    return { trigger: false, reason: 'not-first-step', text: '' }
  }
  const list = Array.isArray(messages) ? messages : []
  let text = ''
  for (const message of list) {
    if (!isUserMessage(message)) continue
    const value = textOfMessage(message)
    if (value === '') continue
    text = value
    break
  }
  if (text === '') return { trigger: false, reason: 'no-user-text', text: '' }
  if (isSkipRequest(text)) return { trigger: false, reason: 'user-skipped', text }
  if (GREETING_PATTERN.test(text)) return { trigger: false, reason: 'greeting', text }
  return { trigger: true, reason: 'first-requirement', text }
}

/**
 * 生成注入文本。
 *
 * `existing` 是工作区里**已有的拼图项目名**（调用方用 `listProjects` 取）。
 * 有项目时第一件事变成「问用户绑哪个还是新建」——这正是用户裁定的第 3 条：
 * 先查再问，避免把已有项目又建一遍。
 */
export function firstRunHint(existing = []) {
  const names = Array.isArray(existing) ? existing.filter((one) => typeof one === 'string' && one !== '') : []
  const lines = [
    FIRST_RUN_MARK,
    '',
    '这是**本会话的第一条需求**，而且本会话**还没绑定拼图项目**。按下面的顺序做，不要跳步：',
    '',
  ]
  if (names.length > 0) {
    lines.push(
      '**第一步：工作区里已经有拼图项目**——' + names.join('、') + '。',
      '所以先问用户一件事：**是绑定上面某个已有项目，还是新建一个？**',
      '- 用户选绑定 → `puzzle_mode{op:"bind", project:"<项目名>"}`，然后继续他原来的需求，**不要采访**；',
      '- 用户选新建 → 走下面的采访流程。',
      '问完等回答，**不要自己替他决定**。',
      '',
      '**第二步（仅当用户选新建）：采访后再建。**',
    )
  } else {
    lines.push(
      '工作区里**还没有**任何拼图项目，直接走采访流程。',
      '',
      '**采访后再建：**',
    )
  }
  lines.push(
    '- 一轮最多 5 问，能用选项就用选项（`ask_user_question`），问真正卡住决定的点：',
    '  目标是什么、模块怎么划、边界在哪；',
    '- **不要提前调 `op:init`**——先拿到回答；',
    '- 拿到回答后 `puzzle_mode{op:"init"}` **一次同时创建主文档与每个模块一份文档**'
      + '（显式给 `project` 与 `modules`）；',
    '- 项目名会成为工作区里的文件夹名，目录固定为 `<工作区>/<项目名>/拼图/`。',
    '',
    '**用户说「别采访 / 直接建 / 不用问」时**：跳过采访，直接 `op:init` 建空壳，'
      + '之后再按需补文档。',
  )
  return lines.join('\n')
}

/**
 * 按会话记住「已经触发过」，避免同一条需求被注入两次。
 *
 * 为什么需要：`agent/pre-step` 在某些路径上会对同一步重复派发（重试、恢复）；
 * 没有这个闸门，模型会看到两条一模一样的上下文。
 *
 * 只存内存、不落盘：进程重启后重来一次是安全的（新会话本来就要重新判定）。
 * 上限 500，超了丢最旧的，防止长跑进程把它撑成无限大。
 */
const fired = new Set()
const FIRED_MAX = 500

export function markFired(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  if (fired.has(sessionId)) return false
  fired.add(sessionId)
  while (fired.size > FIRED_MAX) {
    const oldest = fired.values().next().value
    fired.delete(oldest)
  }
  return true
}

/** 这个会话是否已经触发过（诊断用）。 */
export function hasFired(sessionId) {
  return typeof sessionId === 'string' && sessionId !== '' && fired.has(sessionId)
}

/**
 * 重复思考熔断：模型**绕着圈走**时，把一条「别重复了」的提示送到它面前。
 *
 * 为什么需要它：长任务里模型会陷进「同一步反复做同一件事」——反复读同一个文件、
 * 反复跑同一条命令、反复用同样的参数调同一个工具。每一轮都把整个上下文重发一遍，
 * 所以**空转的每一轮都是真金白银**，而且模型自己往往出不来（它看不到「我刚做过」）。
 * 这个模块就是那道熔断：连续撞同一个动作 N 次，就注入一条提示把它推出去。
 *
 * ## 为什么挂在 `tools/post-execute`，而不是 `agent/pre-step`
 *
 * 这是本仓已经用**假绿**换来的教训（见 `test/40-pre-execute.test.mjs` 开头）：
 * `agent/pre-step` 的 `decision.messages` 契约是 **`UserMessage[]`**，
 * **里面根本没有 tool-call**。想从 pre-step 的「消息」里认出「模型刚才调了什么工具」
 * 是**读不到的**——旧测试伪造了一条带 tool-call 的 assistant 消息，于是断言全绿，
 * 而真实运行时永远走不到那个分支。
 *
 * 真实的工具调用只在 `ToolExecution` 上（`exec.name` / `exec.arguments`），
 * 那是 `tools/pre-execute` / `tools/post-execute` 的入参。本模块用后者，
 * 因为 `post-execute` 的 `additionalContexts` 是**唯一**能「不拦、不打断、
 * 只提醒一句」的通道（`pre-execute` 的 allow 分支会忽略 reason 字段）。
 *
 * ## 判据为什么是「工具调用签名」而不是「推理文本」
 *
 * 抓思维链要读模型输出的 reasoning，形状随模型/版本变，拿不稳；而「重复思考」
 * 在**动作层**有确定性指纹：同名工具 + 同参数。这个口径可纯函数测试，
 * 也正是用户裁定选它的原因。
 *
 * ## 误报防线（宁可漏报，不可误伤）
 *
 * 1. **无参调用一律不计**：`android_get_state` / `job_list` / 截图这类「轮询」工具
 *    反复调是**正常行为**，不是绕圈。参数为空即跳过。
 * 2. **阈值 3**：连续 2 次相同调用是极常见的正当行为（改完再跑一次测试），
 *    留一步容错。
 * 3. **同一段连击只报一次**：报过之后要等签名**变了**才重新武装，
 *    否则第 4、5、6 次会各报一条，比不报更烦。
 *
 * 本文件是**纯逻辑**：不碰 fs、不碰 ctx、无 import，只做「这个动作算不算重复」
 * 与「注入什么文本」。这样它能被单独 import 测试，hook 本体保持薄。
 */

/** 连续多少次相同签名算绕圈。用户裁定为 3。 */
export const LOOP_REPEAT_THRESHOLD = 3

/** 签名长度上限：参数里塞了整个文件内容时，别把内存撑爆。 */
const SIGNATURE_MAX = 400

/** 单个字符串参数在签名里的长度上限（超了截断，只留前缀做指纹）。 */
const ARG_TEXT_MAX = 120

/** 递归深度上限：参数结构异常深时不再往下走。 */
const ARG_DEPTH_MAX = 4

/** 跟踪的会话数上限，超了丢最旧的，防止长跑进程把它撑成无限大。 */
export const LOOPGUARD_MAX_SESSIONS = 500

/** 注入文本的标记，便于在会话里认出这条是谁加的。 */
export const LOOP_BREAK_MARK = '【拼图模式 · 重复思考熔断】'

/**
 * 稳定序列化：**键排序**后再拼，保证「同参数不同键序」算出同一个签名。
 *
 * 为什么要排序：模型每次生成工具参数时键序可能不同（`{a,b}` 与 `{b,a}`），
 * 若按原样 JSON.stringify，同一件事会算出两个签名，连击永远数不到 3——
 * 熔断就成了**永不触发的死代码**。
 */
export function stableStringify(value, depth = 0) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') {
    return JSON.stringify(value.length > ARG_TEXT_MAX ? `${value.slice(0, ARG_TEXT_MAX)}…` : value)
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return String(value)
  if (typeof value !== 'object') return 'null'
  if (depth >= ARG_DEPTH_MAX) return '"…"'
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, depth + 1)).join(',')}]`
  }
  const keys = Object.keys(value).sort()
  const body = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], depth + 1)}`)
  return `{${body.join(',')}}`
}

/**
 * 算出一次工具调用的**动作签名**；返回空串表示「这次调用不计入连击」。
 *
 * 返回空串的两种情况：
 *   - 工具名缺失——认不出动作，没法比；
 *   - **参数为空**——轮询类工具（`job_list` / 截图 / 读状态）反复调是正常的，
 *     把它们算成绕圈会把熔断变成噪音源。
 */
export function actionSignature(toolName, args) {
  if (typeof toolName !== 'string' || toolName === '') return ''
  if (args === null || args === undefined || typeof args !== 'object') return ''
  if (Array.isArray(args)) return ''
  if (Object.keys(args).length === 0) return ''
  const signature = `${toolName} ${stableStringify(args)}`
  return signature.length > SIGNATURE_MAX ? signature.slice(0, SIGNATURE_MAX) : signature
}

/**
 * 会话级的连击计数（只存内存）。
 *
 * 为什么只存内存、不落盘：进程重启后连击清零是**安全**的——重启本身就把
 * 「模型刚才在绕圈」这个事实打断了，而且新进程的第一步没有历史可比。
 */
const streaks = new Map()

/**
 * 记一次动作，返回这次要不要熔断。
 *
 * 返回 `{ signature, count, shouldFire, toolName }`：
 *   - `signature === ''` → 这次不计（无参 / 认不出），`count` 恒为 0；
 *   - `shouldFire === true` → 调用方应注入一条熔断提示；
 *   - 同一段连击**只报一次**：报过之后 `fired` 置位，签名不变就不再报。
 *
 * 参数 `threshold` 可覆盖（测试与将来按工具分档用）。
 */
export function noteAction(sessionId, toolName, args, threshold = LOOP_REPEAT_THRESHOLD) {
  const signature = actionSignature(toolName, args)
  if (signature === '') return { signature: '', count: 0, shouldFire: false, toolName: '' }
  const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : ''
  if (key === '') return { signature, count: 1, shouldFire: false, toolName: String(toolName) }
  const limit = Number.isSafeInteger(threshold) && threshold > 0 ? threshold : LOOP_REPEAT_THRESHOLD
  const previous = streaks.get(key)
  // 签名变了 = 模型换了动作 → 连击从 1 重新数（这是「连续」二字的落点）。
  const count = previous !== undefined && previous.signature === signature ? previous.count + 1 : 1
  const alreadyFired = previous !== undefined && previous.signature === signature && previous.fired === true
  const shouldFire = count >= limit && !alreadyFired
  // 只在「本次真的报了」时置位，避免提前武装后把该报的那次吞掉。
  streaks.set(key, { signature, count, fired: alreadyFired || shouldFire })
  if (streaks.size > LOOPGUARD_MAX_SESSIONS) {
    const oldest = streaks.keys().next().value
    if (oldest !== key) streaks.delete(oldest)
  }
  return { signature, count, shouldFire, toolName: String(toolName) }
}

/** 这个会话当前的连击状态（诊断 / 测试用）。 */
export function streakOf(sessionId) {
  const state = streaks.get(typeof sessionId === 'string' ? sessionId : '')
  return state === undefined ? null : { ...state }
}

/** 清掉一个会话的连击（换轮 / 用户重新说话时用；测试也要能重置）。 */
export function clearStreak(sessionId) {
  return streaks.delete(typeof sessionId === 'string' ? sessionId : '')
}

/** 清空全部会话（测试用）。 */
export function resetLoopGuard() {
  streaks.clear()
}

/**
 * 生成熔断提示文本。
 *
 * 语气刻意是**陈述事实 + 给出口**，不是训斥：模型不是「不听话」，而是它**看不到**
 * 自己刚做过同一件事（历史里每轮都重发，重复的动作混在长上下文里不显眼）。
 * 所以这条提示要做的第一件事就是把事实摆出来（「你已经连续 N 次用同样的参数调了 X」），
 * 第二件事是给三条具体出路——只说「别重复」等于没给信息。
 */
export function loopBreakText(toolName, count, threshold = LOOP_REPEAT_THRESHOLD) {
  const name = typeof toolName === 'string' && toolName !== '' ? toolName : '同一个工具'
  const times = Number.isSafeInteger(count) && count > 0 ? count : threshold
  return [
    LOOP_BREAK_MARK,
    '',
    `你已经**连续 ${times} 次**用**同样的参数**调用 \`${name}\`——这一步没有产生新信息。`,
    '同一轮上下文会被重复发送，空转的每一轮都是实打实的成本。**现在就跳出这个循环**，三选一：',
    '',
    '1. **换输入**：参数里有什么不同（换个路径 / 换个关键词 / 换条命令），让这次调用真的带回新东西；',
    '2. **换动作**：这一步要的信息已经拿到了——直接用它**下结论 / 动手改**，不要再确认一遍；',
    '3. **停下来说清**：确实卡住了（缺权限 / 缺信息 / 工具坏了），就**把卡点讲给用户**，别硬试。',
    '',
    '**不要**再原样调一次。',
  ].join('\n')
}

/**
 * dsh-puzzle-mode —— 宿主半（Host）。
 *
 * 四件事，全部挂在当前插件的 Fiber 上，卸载即撤销：
 *   1) systemPrompt 一段静态规则 `puzzle-mode:policy`：提问节奏（含固定收尾问）、
 *      建项目时机、文档结构、两种执行模式的许可边界；
 *   2) 模型工具 `puzzle_mode`：列项目 / 读状态 / 读模块详情 / 建项目 / 改小节 / 切模式；
 *   3) `tools/pre-execute` Waterfall 监听：项目处于「只拼不写」时 `deny` 越权工具；
 *   4) webServer 路由 `/puzzle-mode-rpc`：浏览器半唯一的数据通道（与 dsh-session-health 同模式）。
 *
 * 拦截点为什么是 `tools/pre-execute` 而不是 `agent/pre-step`：
 * 后者的 `decision.messages` 契约是 `UserMessage[]`——里面**没有 tool-call**，
 * 在它上面「剔除 assistant 消息里的 tool-call」是永远不生效的死代码。
 * `tools/pre-execute` 是运行时给出的、可返回 `{kind:'deny',reason}` 的官方钩子，
 * deny 的 reason 会作为该次调用的错误回到模型，正好用来让它改走文档路径。
 *
 * 平面：宿主组成。工具、提示段、路由都必须进程内唯一，所以整行放宿主机，不进 preset。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  AUDIT_PROMPT,
  DEFAULT_MODE,
  ENTRY_CAPS,
  ENTRY_LIMITS,
  SESSION_FIELD,
  bindSession,
  boundProject,
  HEALTH_DIMENSIONS,
  HEALTH_HEADING,
  MODES,
  MODE_PUZZLE_ONLY,
  MODE_PUZZLE_WRITE,
  MODULE_SECTION_KEYS,
  PAUSE_OPTIONS,
  PAUSE_QUESTION,
  PUZZLE_ONLY_ALLOWED_TOOLS,
  PUZZLE_DIR,
  PUZZLE_VERSION,
  SECTION_HEADINGS,
  SECTION_ORDER,
  docMutationTarget,
  docVersion,
  isPuzzleDocPath,
  planRebuild,
  rebuildProject,
  createProject,
  defaultProjectName,
  dimensionMeta,
  dimensionRanking,
  isExecutableMode,
  inspectSource,
  listProjects,
  projectSummaries,
  readModuleDetail,
  readState,
  setMode,
  setSourceRoot,
  slugify,
  summarize,
  summarizeList,
  trueHealthOf,
  unbindSession,
  updateMainSection,
  updateModuleSection,
} from './puzzle.js'

export const name = 'dsh-puzzle-mode'
export const inject = ['tools', 'systemPrompt', 'webServer']

const SECTION_NAME = 'puzzle-mode:policy'
const ORDER = 10500
const MAX_BODY = 16384
const OPS = ['list', 'read', 'show', 'init', 'bind', 'unbind', 'rebuild', 'main', 'module', 'health', 'audit', 'source', 'mode']

/** 提示段里反复引用的固定收尾问原文（工具返回里也带同一份）。 */
const PAUSE_LINE = `提问的最后一项固定问「${PAUSE_QUESTION}」，选项固定两项：① ${PAUSE_OPTIONS[0]}：只回写文档 + 一句话说明，**本轮立即结束**，不执行任何动作；② ${PAUSE_OPTIONS[1]}：按当前模式继续。这一问也要用 ask_user_question 提交，不要只在正文里列。`

/** 五维清单（提示段与工具描述共用一份）。 */
const DIMENSION_LINE = HEALTH_DIMENSIONS
  .map((dimension) => `\`${dimension.name}\`（${dimension.hint}）`)
  .join('；')

/** 拒绝时的理由：一句话说清「为什么被拦 + 现在该做什么」。 */
function denyReason(toolName, project) {
  const where = typeof project === 'string' && project !== '' ? `（项目「${project}」）` : ''
  return `[拼图模式 · ${MODE_PUZZLE_ONLY}] 已拦下工具「${toolName}」${where}：本模式只提问与更新拼图文档，`
    + `不执行任何动作（不跑命令、不改代码）。当前允许：${PUZZLE_ONLY_ALLOWED_TOOLS.join(' / ')}。`
    + `文档更新请用 puzzle_mode（它带路径守卫），不要用 write / edit。`
    + `请改为：把本轮结论写进文档 → 提出下一次提问 → 最后问一次「${PAUSE_QUESTION}」`
    + `（① ${PAUSE_OPTIONS[0]} ② ${PAUSE_OPTIONS[1]}）。`
    + `用户想执行就把模式切到「${MODE_PUZZLE_WRITE}」（puzzle_mode{op:'mode'} 或面板按钮）。`
}

/**
 * 文档锁的拒绝理由：**与执行模式无关**，任何模式改拼图文档都走这条路。
 *
 * 为什么连「边拼边写」也拦：文档形状由 `puzzle_mode` 统一维护（条目限长、
 * 条数上限、slug 过滤、路径守卫）。绕过去用 `write` 直接覆盖，等于把这些规则全跳过——
 * 一次就能写出超长条目或越界路径，而校验再也不会发生。
 */
function docLockReason(toolName, target) {
  return `[拼图模式 · 文档锁] 已拦下工具「${toolName}」对拼图文档的改动：${target}`
    + `。拼图文档（\`${PUZZLE_DIR}/\` 下的主文档与模块文档）**只能通过 \`puzzle_mode\` 改**：`
    + `主文档用 op:main（section: ${SECTION_ORDER.join(' / ')}），模块文档用 op:module（section: ${MODULE_SECTION_KEYS.join(' / ')}）。`
    + `直接写会绕过条目限长（要点 ${ENTRY_LIMITS.points} / 详细记录 ${ENTRY_LIMITS.detail} / 坑 ${ENTRY_LIMITS.pit} / 主文档 ${ENTRY_LIMITS.index} 字）、`
    + `条数上限（悬而未决 ${ENTRY_CAPS.pending} / 已定 ${ENTRY_CAPS.decided}）、slug 过滤与路径守卫。`
    + `只读请用 read / grep / op:show。`
}

function policyText() {
  return [
    '## 拼图模式',
    '',
    '本会话启用了「拼图模式」：把项目拆成一份**主文档**加若干**模块文档**，用提问把不确定项变成已定项。',
    '',
    '### 提问',
    '- 你**主动提问**，不要等用户想起来才问：一轮 **最多 5 问**，能用选项就用选项，问的是真正卡住决定的点。',
    '- **提问必须调 `ask_user_question` 工具**：在正文里写「① ② ③」**不算提问**——用户看不到可点选项，只能在聊天里手打。有选项就填 `options`（推荐选项放第一项并在标签后加「（推荐）」）。',
    '- 固定收尾问「' + PAUSE_QUESTION + '」同样是提问，同样走 `ask_user_question`。',
    '- ' + PAUSE_LINE,
    '- 提问与文档回写**在同一步完成**：先问、再把问答写进文档，不要只问不写、也不要攒到最后一起写。',
    '',
    '### 项目',
    '**一个会话只绑一个项目**（绑定记在主文档 front-matter 的 `会话:` 数组里，随文档走）。',
    '- 解析顺序只有三步：显式 `project` > 本会话绑定的项目 > **空**。没绑定就是空，**不会**自动占用别的项目。',
    `- 先看有哪些项目：\`puzzle_mode{op:'list'}\`。新会话第一件事：\`op:'read'\` 看绑定；返回 \`projectSource: 'none'\` 就是还没绑。`,
    `- 建项目：\`op:'init'\` 并**显式给 \`project\` 与 \`modules\`**，一次把工作区文件夹、主文档与每个模块文档都建出来（建完自动绑定本会话，并从别的项目上解绑）。不要只建主文档。`,
    `- 已有项目：\`op:'bind'\` 并给 \`project\` 把本会话绑过去；要换成不绑任何项目用 \`op:'unbind'\`。面板里也有建项目 / 绑定 / 解绑入口。`,
    `- 目录固定为 \`<会话工作区>/<项目名>/${PUZZLE_DIR}/主文档.md\` 与 \`${PUZZLE_DIR}/模块/<模块名>.md\`。`,
    '',
    '### 文档分工',
    '- **主文档只有四节**：`## 模块索引`（模块 → 一句话职责 → 文件）、`## 源码索引`、`## 工具索引`、`## 坑`。**除这四节外禁止写任何内容**（用户原话 / 悬而未决 / 已定 / 撤销都不再写进主文档）。',
    '- 主文档每条是**规整的轮汇报式条目**：一句话 ≤' + ENTRY_LIMITS.index + ' 字 + `（源码: 文件[:行]）`；坑 ≤' + ENTRY_LIMITS.pit + ' 字。',
    `- 细节一律下沉到模块文档：\`${HEALTH_HEADING}\`、\`## 进度\`（\`完成度: 0-100\`）、\`## 要点\`（≤${ENTRY_LIMITS.points} 字）、\`## 悬而未决\`（≤${ENTRY_CAPS.pending} 条）、\`## 已定\`（≤${ENTRY_CAPS.decided} 条）、\`## 详细记录\`（轮汇报，≤${ENTRY_LIMITS.detail} 字）。`,
    '- **每条都要带源码出处** `（源码: 文件:行）`：查找方向固定为 **主文档 → 源码**，出处不占字数额度。',
    `- 条目**不用勾选框、不用图标**：悬而未决与已定靠小节区分。超过条数上限时**写入会自动删最旧**的（悬而未决留 ${ENTRY_CAPS.pending} 条、已定留 ${ENTRY_CAPS.decided} 条），不论旧项有没有澄清。`,
    '- **提问等非重要轮不写进文档**；提问的回答只以几句精简结论入库，**不存用户原话、不做解释说明**。撤销项直接删除（不再有「撤销」小节）。',
    '- **一律不得用其他工具改动拼图文档**：`write` / `edit` / `str_replace_editor` 只要目标是 `拼图/` 下的文件就会被宿主拒绝（所有模式生效）。文档只能走 `puzzle_mode`。',
    '',
    '### 项目健康性（五维）',
    `- 每个模块文档的 \`${HEALTH_HEADING}\` 里记五维，**每一维 0-100、越高越好**：${DIMENSION_LINE}。`,
    '- 写法：`任务复杂度: 80`（一行一维，维度名用上面的名字）。**维护系数高分 = 维护负担轻**；若你想写成本，写成 `维护成本: 30` 也会被自动翻成 `维护系数: 70`。',
    '- **没写就用文档内容推导**：有 `## 要点` / `## 详细记录` / `## 悬而未决` / `## 已定` 才有分，空文档五维全 0。所以健康性是「文档里有多少证据」，不是印象分——想让它涨，就真的把内容写进去。',
    `- 项目健康性 = 各模块健康性的均值，由宿主汇总，**不要在文档里手写总分**。想看就调 \`puzzle_mode{op:'read'}\` 或看面板。`,
    '- 每轮提问收尾时，顺手把本轮的结论落到对应维度（例如新定了方案 → 更新模块的 `可拓展性` 与 `## 已定`）。',
    '',
    '### 审查（op:audit）',
    '- 用户问「有什么没完善的 / 可以拓展的 / 这个项目怎么样」，或每过几轮，就调 `puzzle_mode{op:\'audit\'}`：它返回 `findings`（客观发现，带 level/scope/fact/fix）、`ranking`（五维升序）、`prompt`（写点评的指令）。',
    '- **插件只给事实，点评由你写**：照着 `prompt` 写，先点名最弱的一维与它落在哪个模块，每条问题带数字或文档事实，每条配一条可执行的下一步。',
    '- 允许直说：完成度写满而要点为空，就是「在装样子」；手写高分而证据 0 条，就是「自己封的分」。只要事实对得上，就不要和稀泥。',
    '- 禁止空话：「整体不错」「建议持续完善」「保持当前节奏」这类一律不要。最后一句说清**现在最该补的一件事**。',
    `- **条目级发现优先**：\`entry_issue:*\` / \`main_entry_issue:*\` 说明条目本身不合规格（超 ${ENTRY_LIMITS.pit} / ${ENTRY_LIMITS.points} / ${ENTRY_LIMITS.detail} / ${ENTRY_LIMITS.index} 字上限，或缺 \`（源码: …）\`）。这类必须先清，它们让「条数很多」变成假象。`,
    '',
    '### 文档格式版本（puzzle）',
    `- 主文档 front-matter 的 puzzle: 是**文档格式版本**（当前 ${PUZZLE_VERSION}）。op:read 返回的 outdated: true 表示这份文档是旧格式。`,
    '- 旧格式要迁移：调 puzzle_mode 的 op:rebuild 先看预览（**默认 dry-run**，逐文件列出将要改什么），确认后再 apply:true 落盘。面板的「迁移/重构」按钮会把整套提示词填进输入框。',
    '- 重建**只改形状**（front-matter 字段、缺失的小节、拆 悬而未决/已定），**正文一字不动**；唯一"造内容"的地方是把旧完成度折算成五维起点，且只填拿不到证据的维度。',
    '- **迁移不追溯老条目**：已经写下的超长 / 无出处条目不会被 rebuild 清理，只能由你按规格**逐节重写**（`append:false`）。用户点「迁移/重构」时要两件都做：先 rebuild 落盘，再重写正文，最后再跑一次 op:audit 确认条目级发现清零。',
    '- **本项目不自动备份**：工作区通常在 git 里，但若不在，先自行备份再 apply:true。',

    '### 两种执行模式',
    `- **${MODE_PUZZLE_ONLY}**：只提问 + 更新文档；不执行任何动作（越权工具会被宿主 deny，错误里会说明原因）。`,
    `- **${MODE_PUZZLE_WRITE}**：小改动问一次、大改动问一次，问完可以直接执行。`,
    `- 当前模式由 \`puzzle_mode{op:'read'}\` 返回的 \`mode\` / \`canExecute\` 给出，每次动手前先看它；模式只允许 \`${MODES.join('` / `')}\`。`,
    '',
    '若本会话被压缩成 checkpoint，checkpoint 的 `## Critical Context` 必须原样保留本节规则。',
  ].join('\n')
}

/* --------------------------------- 会话与项目定位 --------------------------------- */

/**
 * 取会话工作目录。
 *
 * 返回 `source` 是刻意的：拿不到会话 cwd 时会退回进程工作目录（可能是 `/root`），
 * 那是「文档可能写错地方」的信号，必须让模型和 UI 都能看见，而不是静默发生。
 */
function sessionCwd(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && typeof sessionId === 'string' && sessionId !== '') {
    try {
      const live = sessions.get(sessionId)
      const cwd = live !== undefined && live !== null && live.header !== undefined ? live.header.cwd : undefined
      if (typeof cwd === 'string' && cwd !== '') return { cwd, source: 'session' }
    } catch (_error) {
      /* 会话已不在内存里：退回进程工作目录，但要标出来 */
    }
  }
  try {
    return { cwd: process.cwd(), source: 'process' }
  } catch (_error) {
    return { cwd: '/', source: 'fallback' }
  }
}

/**
 * 定位本次调用要操作的项目。解析顺序**只有三步**：
 *   显式给了 project → 用它（source: 'explicit'，不存在也算显式，如实回报未初始化）；
 *   否则本会话绑定的项目 → 用它（source: 'bound'）；
 *   否则 → **空**（source: 'none'，project 为 ''）。
 *
 * 「空」是刻意的：不再回退「项目根下最新的那个」。那条回退会把新会话塞进上一个会话的项目，
 * 越写越混——这正是「一个会话只绑一个项目」要根治的问题。
 */
function locate(projectRoot, sessionId, requested) {
  const slug = typeof requested === 'string' && requested.trim() !== '' ? slugify(requested) : null
  if (slug !== null) {
    return { project: slug, source: 'explicit', exists: listProjects(projectRoot).some((item) => item.name === slug) }
  }
  const bound = boundProject(projectRoot, sessionId)
  if (bound !== null) return { project: bound, source: 'bound', exists: true }
  return { project: '', source: 'none', exists: false }
}

/** 把定位结果并进返回，让「用的是哪个项目、项目根从哪来」始终可见。 */
function located(ctx, sessionId, requested) {
  const resolved = sessionCwd(ctx, sessionId)
  const where = locate(resolved.cwd, sessionId, requested)
  const extra = {
    projectRoot: resolved.cwd,
    cwdSource: resolved.source,
    projectRequested: where.project,
    projectSource: where.source,
  }
  if (resolved.source !== 'session') {
    extra.hint = `拿不到会话工作目录，已退回进程目录 ${resolved.cwd}——文档可能写到了这里而不是你的工作区。请确认项目根。`
  } else if (where.source === 'none') {
    extra.hint = '本会话还没绑定拼图项目（新会话默认空，不会自动占用别人的项目）。'
      + '新建：op:init 并显式给 project 与 modules，一次把工作区文件夹、主文档与每个模块文档都建出来；'
      + '已有项目：op:bind 并给 project；也可以直接在面板里建项目或绑定。'
  }
  return { project: where.project, projectRoot: resolved.cwd, extra }
}

/* --------------------------------- 工具 --------------------------------- */

const TOOL_DESCRIPTION = [
  '拼图模式：把项目拆成主文档 + 模块文档，用提问把不确定项变成已定项。',
  'op=list 列出现有项目；op=read 读状态（带 brief:true 是精简档）；op=show 读某个模块文档的详情；op=init 一次创建主文档与每个模块一份文档；op=bind 绑定已有项目；op=unbind 解绑本会话；op=rebuild 重建/迁移文档格式（默认 dry-run）；op=main 更新主文档四节之一；op=module 更新（必要时创建）模块文档；op=health 写五维健康性；op=audit 审查（返回五维**真实值**与源码体检，见下）；op=source 记/查源码根；op=mode 切换执行模式。',
  `**主文档只有四节**：${SECTION_ORDER.map((key) => SECTION_HEADINGS[key]).join(' / ')}——除这四节外禁止写任何内容。`,
  `条目格式固定为「一句话（源码: 文件:行）」，查找方向是 主文档 → 源码；限长：要点 ${ENTRY_LIMITS.points} 字 / 详细记录 ${ENTRY_LIMITS.detail} 字 / 坑 ${ENTRY_LIMITS.pit} 字 / 主文档 ${ENTRY_LIMITS.index} 字（出处不占额度，超了报错不截断）。`,
  `条数上限（写入时自动删最旧，不论有没有澄清）：## 悬而未决 ≤${ENTRY_CAPS.pending} 条、## 已定 ≤${ENTRY_CAPS.decided} 条。`,
  `文档格式有版本号（当前 puzzle: ${PUZZLE_VERSION}）。op=read 里 \`outdated: true\` 表示这份文档是旧格式，用 \`op=rebuild\` 迁移——它默认只给预览，加 apply:true 才落盘（本项目不自动备份）。`,
  'op=audit 审查：返回**五维真实值**（由文档证据 + 源码体检算出）与 `inflation` 虚高清单（你自评的分 vs 真实值）、源码体检事实（文件行数/最长函数/目录分层）、findings 与 prompt。**改分数与拆代码由你按 prompt 执行**——插件只给事实，不代改。',
  '**一个会话只绑一个项目**：不给 project 时用本会话绑定的那个；没绑定就是空（projectSource: none），不会自动占用别的项目。换项目要显式给 project，用 op:bind 绑定。',
  `项目健康性由五维决定：${HEALTH_DIMENSIONS.map((d) => d.name).join(' / ')}，每维 0-100、**越高越好**（维护系数高分 = 维护负担轻）。`,
  '写法：在模块文档的 `## 健康性` 里一行一维，如 `任务复杂度: 80`；不写则由文档内容推导（空文档全 0）。项目健康性 = 各模块均值，不要手写总分（主文档也没地方写）。',
  '**拼图文档一律不得用其他工具改动**：write / edit / str_replace_editor 只要目标是 `' + PUZZLE_DIR + '/` 下的文件就会被宿主拒绝（所有模式生效）；只读请用 read / grep / op:show。',
  `每次调用返回都带 askPause:true——**每一次提问的最后都要问「${PAUSE_QUESTION}」，两个选项：${PAUSE_OPTIONS.join(' / ')}**；用户选第一项时只回写文档并结束本轮，不执行任何动作。`,
  `当前模式见返回的 mode/canExecute：${MODE_PUZZLE_ONLY} 只提问与更新文档（越权工具会被 deny）；${MODE_PUZZLE_WRITE} 可执行且小改动问一次、大改动问一次。`,
].join('\n')

function failure(error, hint) {
  return { ok: false, error, hint }
}

export function apply(ctx) {
  ctx.systemPrompt.section({ name: SECTION_NAME, order: ORDER, text: policyText() })

  ctx.tools.register(defineTool({
    name: 'puzzle_mode',
    description: TOOL_DESCRIPTION,
    parameters: {
      op: {
        type: 'string',
        required: true,
        description: 'list 列项目 / read 读状态 / show 读模块详情 / init 新建项目（并绑定本会话）/ bind 绑定已有项目 / unbind 解绑本会话 / rebuild 重建文档格式（默认 dry-run）/ main 主文档小节 / module 模块文档小节 / health 写五维健康性 / audit 按五维审查 / mode 切换模式',
        enum: OPS,
      },
      project: { type: 'string', description: '项目名；省略时用本会话绑定的项目（没绑定就是空）。init 要求显式给（它会成为工作区里的文件夹名），bind 必须给' },
      goal: { type: 'string', description: 'init：这个项目要达成什么（一句话）' },
      modules: {
        type: 'array',
        description: 'init：要同时创建的模块名列表（每个模块一份文档）',
        items: { type: 'string' },
      },
      section: { type: 'string', description: `main：${SECTION_ORDER.join('/')}（主文档只有这四节）；module：${MODULE_SECTION_KEYS.join('/')}` },
      name: { type: 'string', description: 'module / show：模块名（module 时不存在则创建）' },
      content: { type: 'string', description: `要写入的正文（markdown 片段）；health 时为 \`维度名: 0-100\` 若干行。条目式小节每条必须是「一句话（源码: 文件:行）」，限长 要点 ${ENTRY_LIMITS.points} / 详细记录 ${ENTRY_LIMITS.detail} / 坑 ${ENTRY_LIMITS.pit} / 主文档 ${ENTRY_LIMITS.index} 字（出处不占额度），超了报错不截断` },
      append: { type: 'boolean', description: 'true 追加到小节末尾，false 覆盖该小节；默认追加' },
      apply: { type: 'boolean', description: 'rebuild：true 才落盘；不给或 false 只给预览（dry-run）' },
      brief: { type: 'boolean', description: 'read：true 返回接续会话用的精简档（去掉每模块五维明细与五维说明表，附 readNext 指路），省上下文；默认 false 给全量' },
      source: { type: 'boolean', description: 'audit：默认 true，把源码体检（文件行数 / 最长函数 / 目录分层）算进五维真实值；项目还没代码时给 false 跳过' },
      path: { type: 'string', description: 'source：源码根目录的绝对路径（写进主文档 front-matter 的 源码根:）。传空串清掉。' },
      sourceRoot: { type: 'string', description: 'audit：源码根目录的绝对路径。默认取「拼图目录的上一级」，但文档目录与源码目录常常不在一处（例如文档在 /sdcard/…/<项目>/拼图/、源码在 /root/.dsh/plugin-src/<包名>/），这时必须显式给，否则查不到源码' },
      mode: { type: 'string', description: `mode：${MODES.join(' / ')}`, enum: MODES },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      const sessionId = exec !== undefined && exec.agent !== undefined && exec.agent !== null && exec.agent.session !== undefined
        ? exec.agent.session.id
        : undefined
      const resolved = located(ctx, sessionId, args.project)
      const projectRoot = resolved.projectRoot
      const project = resolved.project
      const append = args.append !== false

      if (args.op === 'list') {
        return summarizeList(projectRoot, projectSummaries(projectRoot))
      }

      // read / audit / init / bind 自己处理「没绑定」，其余写操作必须先有项目。
      if (project === '' && !['read', 'audit', 'init', 'bind', 'unbind'].includes(args.op)) {
        return failure('本会话还没绑定拼图项目', `先用 op:init 建一个（显式给 project 与 modules），或用 op:bind 绑已有项目；当前 op=${args.op} 需要项目`)
      }

      if (args.op === 'read') {
        // `brief:true` 是接续会话用的精简档：新会话不必把六个模块的五维明细全拉进上下文。
        return summarize(readState(projectRoot, project), resolved.extra, args.brief === true)
      }

      if (args.op === 'show') {
        if (typeof args.name !== 'string' || args.name === '') return failure('缺少 name', '给出模块名，例如 auth-flow')
        const detail = readModuleDetail(projectRoot, project, args.name)
        if (detail.ok !== true) return failure(detail.error, '检查项目名与模块名')
        return { ...detail, ...resolved.extra, askPause: true, pauseQuestion: PAUSE_QUESTION, pauseOptions: PAUSE_OPTIONS }
      }

      if (args.op === 'init') {
        // 没给 project 就用「日期-关键词」兜底，免得因为缺名字而建不出来。
        const name = project !== '' ? project : defaultProjectName(args.goal ?? '')
        const created = createProject(projectRoot, name, args.goal ?? '', args.modules ?? [], DEFAULT_MODE, sessionId ?? '')
        if (created.ok !== true) return failure(created.error, created.hint)
        const rebound = created.rebound === true
        return summarize(readState(projectRoot, created.project), {
          ...resolved.extra,
          // 真实归属：新建时顺带绑了 → bound；项目本来就在、这次没动绑定 → 按实际（通常 none）。
          projectSource: rebound ? 'bound' : 'none',
          created: true,
          mainCreated: created.mainCreated === true,
          createdModules: created.created,
          existingModules: created.existing,
          // **只在新建时**才顺带绑本会话。项目已存在时不动绑定——否则用户刚解绑的会话
          // 会因为一次「确保存在」式的 op:init 被重新绑回去（就是「解绑后又自动绑定」）。
          rebound,
          bound: created.bound === true,
          released: created.released ?? [],
          bindError: created.bindError ?? null,
          hint: rebound
            ? '项目已建好，并已把本会话绑过来（原先绑的项目已解绑）。'
            : '项目已存在：**本次没有改动绑定**。要改绑用 op:bind 并给 project。',
          next: '现在开始一轮提问（最多 5 问），并在最后问一次要不要先停下',
        })
      }

      if (args.op === 'bind') {
        if (project === '') return failure('缺少 project', 'bind 需要给出要绑定的项目名')
        if (typeof sessionId !== 'string' || sessionId === '') {
          return failure('拿不到会话 ID', '绑定是按会话记的，没有会话 ID 无法绑定')
        }
        const bound = bindSession(projectRoot, project, sessionId)
        if (bound.ok !== true) return failure(bound.error, bound.hint)
        return summarize(readState(projectRoot, bound.project), {
          ...resolved.extra,
          projectSource: 'bound',
          bound: true,
          released: bound.released ?? [],
        })
      }

      if (args.op === 'unbind') {
        if (typeof sessionId !== 'string' || sessionId === '') {
          return failure('拿不到会话 ID', '绑定是按会话记的，没有会话 ID 无法解绑')
        }
        const cut = unbindSession(projectRoot, sessionId)
        if (cut.ok !== true) return failure(cut.error, cut.hint)
        // 解绑后本会话没有项目，所以返回未初始化的状态——如实回报，不要顺手绑一个。
        return summarize(readState(projectRoot, ''), {
          ...resolved.extra,
          projectSource: 'none',
          unbound: true,
          released: cut.released ?? [],
        })
      }

      if (args.op === 'rebuild') {
        // 默认 dry-run：`apply` 不显式给 true 就只报计划。重建会重写 front-matter 与补小节，
        // 本项目不自动备份（工作区通常在 git 里），所以预览就是唯一的刹车。
        const result = rebuildProject(projectRoot, project, args.apply === true)
        if (result.ok !== true) return failure(result.error, result.hint)
        return {
          ok: true,
          project: result.project,
          puzzleDir: result.puzzleDir,
          mainDoc: result.mainDoc,
          version: result.version,
          targetVersion: result.targetVersion,
          outdated: result.outdated,
          migrations: result.migrations,
          totalChanges: result.totalChanges,
          applied: result.applied === true,
          written: result.written ?? [],
          failed: result.failed ?? [],
          files: result.files.map((item) => ({
            kind: item.kind,
            name: item.name,
            file: item.file,
            version: item.version,
            changes: item.changes,
            willWrite: item.changes.length > 0 && typeof item.text === "string",
          })),
          hint: result.applied === true
            ? "已重建，用 op:read 复核；正文一字未动，只改了 front-matter 形状与缺失的小节。"
            : "这是预览（dry-run）。确认无误后加 apply:true 落盘；预览与实际落盘做的是同一件事。",
          ...resolved.extra,
          askPause: true,
          pauseQuestion: PAUSE_QUESTION,
          pauseOptions: PAUSE_OPTIONS,
        }
      }

      if (args.op === 'main') {
        if (typeof args.section !== 'string' || args.section === '') return failure('缺少 section', `可用：${SECTION_ORDER.join(' / ')}（主文档只有这四节）`)
        const result = updateMainSection(projectRoot, project, args.section, args.content ?? '', append)
        if (result.ok !== true) return failure(result.error, result.hint)
        return summarize(readState(projectRoot, project), { ...resolved.extra, section: args.section, entries: result.entries ?? 0 })
      }

      if (args.op === 'module') {
        if (typeof args.name !== 'string' || args.name === '') return failure('缺少 name', '给出模块名，例如 auth-flow')
        if (typeof args.section !== 'string' || args.section === '') return failure('缺少 section', `可用：${MODULE_SECTION_KEYS.join(' / ')}`)
        const result = updateModuleSection(projectRoot, project, args.name, args.section, args.content ?? '', append)
        if (result.ok !== true) return failure(result.error, result.hint)
        return summarize(readState(projectRoot, project), {
          ...resolved.extra,
          module: args.name,
          section: args.section,
          created: result.created,
          entries: result.entries ?? 0,
          // 超上限时如实回报删了几条（悬而未决 4 / 已定 10，删最旧）。
          dropped: Array.isArray(result.dropped) ? result.dropped.length : 0,
          droppedEntries: Array.isArray(result.dropped) ? result.dropped : [],
        })
      }

      if (args.op === 'health') {
        // 五维只写在模块文档上：项目级健康性由宿主按模块均值汇总，写进文档只会与事实矛盾。
        if (typeof args.name !== 'string' || args.name === '') {
          return failure('health 需要 name', '给出模块名：五维写在模块文档的 ## 健康性 里；项目健康性由宿主按模块均值汇总，不要手写')
        }
        const result = updateModuleSection(projectRoot, project, args.name, 'health', args.content ?? '', append)
        if (result.ok !== true) return failure(result.error, result.hint)
        return summarize(readState(projectRoot, project), { ...resolved.extra, module: args.name, section: 'health', created: result.created })
      }

      if (args.op === 'audit') {
        // 只读：把客观事实摆齐（含**五维真实值**），改值由模型按 prompt 执行。
        // 本插件**不生成评价正文**，也不代改分数——它只回答「真实值是多少、差在哪」。
        const state = readState(projectRoot, project)
        if (state.initialized !== true) {
          return failure('尚无拼图项目', '先用 op:init 建出主文档与模块文档，再审查')
        }
        // 源码体检：审查「真实值」需要它。`source:false` 可跳过（项目还没代码时）。
        // `sourceRoot` 用于「文档目录 ≠ 源码目录」的真实情况（本项目就是如此）。
        const inspection = args.source === false ? null : inspectSource(projectRoot, project, args.sourceRoot ?? '')
        const hasSource = inspection !== null && inspection.ok === true && inspection.fileCount > 0
        // 全局（项目级）：证据取所有模块之和，声明值取各模块声明值的均值。
        const mergedEvidence = {}
        for (const key of ['points', 'detail', 'pending', 'decided', 'shared']) {
          mergedEvidence[key] = state.modules.reduce((sum, module) => sum + ((module.evidence ?? {})[key] ?? 0), 0)
        }
        mergedEvidence.pit = state.sections?.pit ?? 0
        const mergedDeclared = {}
        for (const dimension of HEALTH_DIMENSIONS) {
          const values = state.modules.map((module) => module.healthScores?.[dimension.key]).filter((v) => typeof v === 'number')
          if (values.length > 0) mergedDeclared[dimension.key] = Math.round(values.reduce((a, b) => a + b, 0) / values.length)
        }
        const projectTrue = trueHealthOf({ evidence: mergedEvidence, inspection, declared: mergedDeclared, hasSource })
        // 每个模块各算一份真实值（模块范围）。
        const moduleTruth = state.modules.map((module) => {
          const declared = {}
          for (const dimension of HEALTH_DIMENSIONS) {
            if (module.healthSources?.[dimension.key] === 'module') declared[dimension.key] = module.healthScores[dimension.key]
          }
          const truth = trueHealthOf({ evidence: module.evidence ?? {}, inspection, declared, hasSource, files: module.citedFiles ?? [] })
          return {
            name: module.name,
            declaredHealth: module.health,
            trueHealth: truth.health,
            declared: module.healthScores,
            trueValues: truth.scores,
            reasons: truth.reasons,
          }
        })
        // 虚高清单：模型自评高于真实值的地方，逐条摆出来（这是「虚假提高」的直接证据）。
        const inflation = []
        for (const [key, reason] of Object.entries(projectTrue.reasons)) {
          if (reason.inflation === undefined) continue
          inflation.push({
            scope: 'project',
            dimension: key,
            name: HEALTH_DIMENSIONS.find((d) => d.key === key)?.name ?? key,
            declared: reason.inflation.declared,
            trueValue: reason.inflation.trueValue,
            gap: reason.inflation.gap,
            because: reason.verdicts,
          })
        }
        for (const item of moduleTruth) {
          for (const [key, reason] of Object.entries(item.reasons)) {
            if (reason.inflation === undefined) continue
            inflation.push({
              scope: item.name,
              dimension: key,
              name: HEALTH_DIMENSIONS.find((d) => d.key === key)?.name ?? key,
              declared: reason.inflation.declared,
              trueValue: reason.inflation.trueValue,
              gap: reason.inflation.gap,
              because: reason.verdicts,
            })
          }
        }
        // 源码体检的发现并进 findings：这样一份 op:audit 返回里既有文档问题、也有代码问题。
        // 不在 readState 里做体检——`op:read` 每轮都调，不该每次去扫源码树。
        const sourceFindings = hasSource
          ? inspection.findings.map((item) => ({
            id: 'source:' + item.id,
            level: item.level === 'fail' ? 'blocker' : 'warn',
            dimension: item.id === 'source_long_function' ? 'maintenance' : 'extensibility',
            scope: 'project',
            fact: item.fact,
            fix: item.fix,
          }))
          : []
        return {
          ok: true,
          project: state.project,
          projectDir: state.puzzleDir,
          mainDoc: state.mainDoc,
          // 全局范围
          scope: 'project',
          declaredHealth: state.health,
          trueHealth: projectTrue.health,
          declaredDimensions: state.dimensions,
          trueDimensions: projectTrue.scores,
          dimensionMeta: dimensionMeta(),
          // 真实值怎么来的：文档那一侧 vs 源码那一侧（含「没有源码可查」的诚实标注）
          dimensionReasons: projectTrue.reasons,
          ranking: dimensionRanking(projectTrue.scores),
          declaredRanking: dimensionRanking(state.dimensions),
          // 模块范围
          modules: moduleTruth,
          // 虚高清单（模型自评 > 真实值）——审查要据此改值
          inflation,
          // 源码体检原始事实（工程化问题的证据）
          source: hasSource
            ? {
              fileCount: inspection.fileCount,
              totalLines: inspection.totalLines,
              avgLines: inspection.avgLines,
              largest: inspection.largest,
              dirs: inspection.dirs,
              longestFunction: inspection.longestFunction,
              oversized: inspection.oversized,
              findings: inspection.findings,
            }
            : { skipped: true, note: args.source === false ? '按 source:false 跳过' : '这个项目目录下没有源码文件' },
          findings: [...state.findings, ...sourceFindings],
          sections: state.sections,
          prompt: AUDIT_PROMPT,
          ...resolved.extra,
          askPause: true,
          pauseQuestion: PAUSE_QUESTION,
          pauseOptions: PAUSE_OPTIONS,
        }
      }

      if (args.op === 'source') {
        // 记源码根：审查做源码体检要知道去哪看代码（文档目录与源码目录常不在一处）。
        // 传空串 = 清掉，回到默认规则（拼图目录的上一级）。
        if (args.path === undefined && args.sourceRoot === undefined) {
          const state = readState(projectRoot, project)
          const current = state.sourceRoot ?? ''
          const probe = inspectSource(projectRoot, project)
          return {
            ok: true,
            sourceRoot: current,
            effective: probe.ok === true ? probe.base : null,
            fileCount: probe.fileCount ?? 0,
            totalLines: probe.totalLines ?? 0,
            largest: probe.largest ?? null,
            dirs: probe.dirs ?? [],
            sourceFindings: probe.findings ?? [],
            note: current === ''
              ? '还没记源码根，正按默认规则找（拼图目录的上一级）。' + (probe.ok === true && probe.fileCount > 0 ? '' : '没找到源码——用 op:source 带 path 记一下。')
              : '已记源码根。',
            ...resolved.extra,
            askPause: true,
            pauseQuestion: PAUSE_QUESTION,
            pauseOptions: PAUSE_OPTIONS,
          }
        }
        const target = args.path ?? args.sourceRoot
        const result = setSourceRoot(projectRoot, project, target ?? '')
        if (result.ok !== true) return failure(result.error, result.hint)
        const after = inspectSource(projectRoot, project)
        return summarize(readState(projectRoot, project), {
          ...resolved.extra,
          sourceRoot: result.sourceRoot,
          fileCount: after.fileCount ?? 0,
          totalLines: after.totalLines ?? 0,
          sourceFindings: after.findings ?? [],
        })
      }

      if (args.op === 'mode') {
        if (typeof args.mode !== 'string' || !MODES.includes(args.mode)) return failure(`未知模式 ${String(args.mode)}`, `可用：${MODES.join(' / ')}`)
        const result = setMode(projectRoot, project, args.mode)
        if (result.ok !== true) return failure(result.error, result.hint)
        return summarize(readState(projectRoot, project), { ...resolved.extra, modeChanged: args.mode })
      }

      return failure(`未知 op ${String(args.op)}`, `可用：${OPS.join(' / ')}`)
    },
  }), 'dsh-puzzle-mode: puzzle_mode tool')

  /* --------------------- 只拼不写：deny 越权工具（tools/pre-execute） --------------------- */

  if (typeof ctx.on === 'function') {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      // 已经有人拒了就别插话；没有 agent 的派发（如子流程）一律放行。
      if (decision !== null && typeof decision === 'object' && decision.kind === 'deny') return decision
      if (exec === null || typeof exec !== 'object') return decision
      const toolName = typeof exec.name === 'string' ? exec.name : ''
      if (toolName === '' || PUZZLE_ONLY_ALLOWED_TOOLS.includes(toolName)) return decision

      // 文档锁：**先于会话判断、也先于模式判断**，且与两者都无关。
      // 拼图文档只能由 puzzle_mode 改，否则条目限长 / 条数上限 / slug 过滤 / 路径守卫
      // 会被一次 write 全部绕过。没绑定的会话、边拼边写模式，同样拦。
      const target = docMutationTarget(toolName, exec.arguments)
      if (target !== null && isPuzzleDocPath(target)) {
        return { kind: 'deny', reason: docLockReason(toolName, target) }
      }

      const agent = exec.agent
      const sessionId = agent !== undefined && agent !== null && typeof agent.id === 'string' ? agent.id : ''
      if (sessionId === '') return decision

      const resolved = sessionCwd(ctx, sessionId)

      // 只看本会话**绑定**的项目：没绑定就不拦，免得误伤其他会话的普通工作。
      const bound = boundProject(resolved.cwd, sessionId)
      if (bound === null) return decision
      const state = readState(resolved.cwd, bound)
      if (state.initialized !== true || isExecutableMode(state.mode)) return decision

      return { kind: 'deny', reason: denyReason(toolName, bound) }
    }, 'dsh-puzzle-mode: 只拼不写拦截 + 文档锁')
  }

  /* ------------------------------ 浏览器通道 ------------------------------ */

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/puzzle-mode-rpc',
      handler: async (req, res) => {
        const rejection = webCtx.connection.requestRejection(req)
        if (rejection !== undefined) {
          respond(res, rejection, { ok: false, error: '需要当前浏览器鉴权' })
          return
        }
        if (req.method !== 'POST') {
          respond(res, 405, { ok: false, error: 'POST required' })
          return
        }
        let body
        try {
          body = JSON.parse(await readBody(req))
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad body')
        } catch (_error) {
          respond(res, 400, { ok: false, error: '请求正文必须是 { method, sessionId } 对象' })
          return
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') {
          respond(res, 400, { ok: false, error: '缺少 sessionId' })
          return
        }
        // 面板可以显式指定项目；不给就用默认（最新的那个）。
        const requested = typeof body.project === 'string' ? body.project : undefined
        const resolved = located(ctx, sessionId, requested)
        const projectRoot = resolved.projectRoot
        const project = resolved.project

        if (body.method === 'state') {
          // 面板要显示客观发现，所以这里附上完整 findings——
          // `summarize` 只给 findingCount（op:read 要精简），RPC 这一侧才展开。
          const panelState = readState(projectRoot, project)
          respond(res, 200, {
            ok: true,
            result: {
              ...summarize(panelState, resolved.extra),
              findings: Array.isArray(panelState.findings) ? panelState.findings : [],
              ranking: dimensionRanking(panelState.dimensions),
            },
          })
          return
        }
        if (body.method === 'create') {
          const name = typeof body.project === 'string' && body.project.trim() !== '' ? body.project : defaultProjectName(body.goal ?? '')
          const created = createProject(
            projectRoot, name, typeof body.goal === 'string' ? body.goal : '',
            Array.isArray(body.modules) ? body.modules : [], DEFAULT_MODE, sessionId,
          )
          if (created.ok !== true) {
            respond(res, 200, { ok: false, error: created.error })
            return
          }
          respond(res, 200, {
            ok: true,
            result: {
              // 建完之后真实归属是「绑定」（新建时顺带绑了），不是 explicit。
              // 报 explicit 会让面板以为「项目名是外面传进来的」，掩盖绑定状态。
              ...summarize(readState(projectRoot, created.project), {
                ...resolved.extra,
                projectSource: created.rebound === true ? 'bound' : 'none',
              }),
              createdModules: created.created,
              mainCreated: created.mainCreated === true,
              rebound: created.rebound === true,
              released: created.released ?? [],
              // 项目已存在 → 这次没动绑定。必须说清，否则用户会以为「解绑又被绑回去了」。
              hint: created.mainCreated === true
                ? '项目已建好并绑定本会话。'
                : '项目已存在，**没有改动绑定**（要改绑请用 op:bind 或面板下拉）。',
            },
          })
          return
        }
        if (body.method === 'bind') {
          if (typeof body.project !== 'string' || body.project.trim() === '') {
            respond(res, 400, { ok: false, error: '缺少 project' })
            return
          }
          const bound = bindSession(projectRoot, body.project, sessionId)
          if (bound.ok !== true) {
            respond(res, 200, { ok: false, error: bound.error })
            return
          }
          respond(res, 200, { ok: true, result: { ...summarize(readState(projectRoot, bound.project), { ...resolved.extra, projectSource: 'bound' }), released: bound.released ?? [] } })
          return
        }
        if (body.method === 'unbind') {
          const cut = unbindSession(projectRoot, sessionId)
          if (cut.ok !== true) {
            respond(res, 200, { ok: false, error: cut.error })
            return
          }
          respond(res, 200, { ok: true, result: { ...summarize(readState(projectRoot, ''), { ...resolved.extra, projectSource: 'none' }), unbound: true, released: cut.released ?? [] } })
          return
        }
        if (body.method === 'rebuild') {
          const result = rebuildProject(projectRoot, project, body.apply === true)
          if (result.ok !== true) {
            respond(res, 200, { ok: false, error: result.error })
            return
          }
          respond(res, 200, {
            ok: true,
            result: {
              ...summarize(readState(projectRoot, project), resolved.extra),
              version: result.version,
              targetVersion: result.targetVersion,
              outdated: result.outdated,
              totalChanges: result.totalChanges,
              applied: result.applied === true,
              written: result.written ?? [],
            },
          })
          return
        }
        if (body.method === 'list') {
          respond(res, 200, { ok: true, result: summarizeList(projectRoot, projectSummaries(projectRoot)) })
          return
        }
        if (body.method === 'audit') {
          // 面板要显示**真实值**（不只是声明值），所以这里给一份轻量审查结果：
          // 五维真实值 + 虚高清单 + 源码体检摘要。不返回完整 findings（那个走 op:audit）。
          const state = readState(projectRoot, project)
          if (state.initialized !== true) {
            respond(res, 200, { ok: false, error: '尚无拼图项目' })
            return
          }
          const inspection = inspectSource(projectRoot, project)
          const hasSource = inspection.ok === true && inspection.fileCount > 0
          const mergedEvidence = {}
          for (const key of ['points', 'detail', 'pending', 'decided', 'shared']) {
            mergedEvidence[key] = state.modules.reduce((sum, module) => sum + ((module.evidence ?? {})[key] ?? 0), 0)
          }
          mergedEvidence.pit = state.sections?.pit ?? 0
          const mergedDeclared = {}
          for (const dimension of HEALTH_DIMENSIONS) {
            const values = state.modules.map((module) => module.healthScores?.[dimension.key]).filter((v) => typeof v === 'number')
            if (values.length > 0) mergedDeclared[dimension.key] = Math.round(values.reduce((a, b) => a + b, 0) / values.length)
          }
          const truth = trueHealthOf({ evidence: mergedEvidence, inspection, declared: mergedDeclared, hasSource })
          const inflation = []
          for (const [key, reason] of Object.entries(truth.reasons)) {
            if (reason.inflation === undefined) continue
            inflation.push({
              dimension: key,
              name: HEALTH_DIMENSIONS.find((d) => d.key === key)?.name ?? key,
              declared: reason.inflation.declared,
              trueValue: reason.inflation.trueValue,
              gap: reason.inflation.gap,
            })
          }
          respond(res, 200, {
            ok: true,
            result: {
              project: state.project,
              declaredHealth: state.health,
              trueHealth: truth.health,
              declaredDimensions: state.dimensions,
              trueDimensions: truth.scores,
              reasons: truth.reasons,
              inflation,
              source: hasSource
                ? {
                  base: inspection.base,
                  fileCount: inspection.fileCount,
                  totalLines: inspection.totalLines,
                  largest: inspection.largest,
                  dirs: inspection.dirs,
                  findings: inspection.findings,
                }
                : { skipped: true, note: inspection.ok === true ? inspection.note : inspection.error },
            },
          })
          return
        }
        if (body.method === 'module') {
          if (typeof body.name !== 'string' || body.name === '') {
            respond(res, 400, { ok: false, error: '缺少 name' })
            return
          }
          const detail = readModuleDetail(projectRoot, project, body.name)
          if (detail.ok !== true) {
            respond(res, 200, { ok: false, error: detail.error })
            return
          }
          respond(res, 200, { ok: true, result: { ...detail, ...resolved.extra } })
          return
        }
        if (body.method === 'mode') {
          if (!MODES.includes(body.mode)) {
            respond(res, 400, { ok: false, error: `未知模式 ${String(body.mode)}` })
            return
          }
          const result = setMode(projectRoot, project, body.mode)
          if (result.ok !== true) {
            respond(res, 200, { ok: false, error: result.error })
            return
          }
          respond(res, 200, { ok: true, result: summarize(readState(projectRoot, project), resolved.extra) })
          return
        }
        respond(res, 400, { ok: false, error: `未知 method ${String(body.method)}` })
      },
    }), 'dsh-puzzle-mode: rpc route')
  })
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = ''
    let bytes = 0
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_BODY) {
        rejectPromise(new Error('请求过大'))
        req.destroy()
        return
      }
      data += chunk
    })
    req.on('end', () => {
      resolvePromise(data)
    })
    req.on('error', rejectPromise)
    req.on('aborted', () => {
      rejectPromise(new Error('请求已取消'))
    })
  })
}

function respond(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export { policyText, summarize, denyReason, dimensionMeta }

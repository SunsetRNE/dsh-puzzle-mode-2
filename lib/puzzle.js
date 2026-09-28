/**
 * dsh-puzzle-mode —— 纯逻辑层（无 Cordis 依赖，可单独测试）。
 *
 * 这一层定义「拼图文档」的唯一契约：目录布局、主文档小节、模块文档模板、
 * 以及确定性的**项目健康性**算法。工具面（lib/index.js）与 UI 面（lib/client.js）
 * 读的都是同一份数据，所以健康性在任何地方都不会出现两个口径。
 *
 * 目录布局（项目名由用户给或按当天日期生成）：
 *   <项目根>/<项目名>/拼图/主文档.md
 *   <项目根>/<项目名>/拼图/模块/<模块名>.md
 *
 * 不变量：
 *   - 模块名经过 slug 过滤，且解析后的路径必须仍在「拼图/」内（路径守卫）。
 *   - 所有写盘都是「临时文件 + rename」的原子写。
 *   - front-matter 中的 `计划模块:` 是模块清单的权威来源，UI 据此显示「未建」图块。
 *   - 「模式」是**项目级**设置，只存在于主文档；模块文档只记 `模块:`。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** 文档文件夹固定名。 */
export const PUZZLE_DIR = '拼图'
export const MAIN_FILE = '主文档.md'
export const MODULE_DIR = '模块'

/** 两种执行模式。 */
export const MODE_PUZZLE_ONLY = '只拼不写'
export const MODE_PUZZLE_WRITE = '边拼边写'
export const MODES = [MODE_PUZZLE_ONLY, MODE_PUZZLE_WRITE]
export const DEFAULT_MODE = MODE_PUZZLE_ONLY

/**
 * 固定收尾问：**每一次提问都必须带上它**。
 * 选项顺序就是建议顺序——「停下」在前且为推荐项。
 */
export const PAUSE_QUESTION = '要不要先停下？'
export const PAUSE_OPTIONS = ['停下，等我看过再说', '继续，不用停']

/** 主文档 front-matter 里的会话绑定字段：一个会话只绑一个项目。 */
export const SESSION_FIELD = '会话'

/**
 * 主文档 front-matter 里的**源码根**字段。
 *
 * 为什么需要它：文档目录与源码目录常常不是同一处。本项目实测：文档在
 * `/sdcard/dsha222/拼图模式插件/拼图/`，源码却在 `/root/.dsh/plugin-src/dsh-puzzle-mode/`。
 * 审查要做源码体检（文件行数、巨函数、目录分层），必须先知道**去哪看代码**。
 * 没记这个字段就退回「拼图目录的上一级」，找不到就如实说「没查到」，不假装干净。
 */
export const SOURCE_ROOT_FIELD = '源码根'

/**
 * 当前文档格式版本（front-matter 的 `puzzle:` 字段）。
 *
 * **破坏性改动必须 +1，并在 MIGRATIONS 里补一步**——版本号不 +1 的破坏性改动
 * 就是「旧文档静默降级」：读得出来、不报错，但形状已经对不上。
 *
 * v1：`进度/完成度` 单一维度；模块 front-matter 带 `模式:`/`计划模块:`；无 `## 健康性`。
 * v2：五维健康性；模块 front-matter 只留 `项目:`/`模块:`；主文档加 `会话:` 绑定。
 * v3：主文档收敛为四节（模块索引 / 源码索引 / 工具索引 / 坑）；模块拆出
 *     `## 悬而未决`（≤4 条）与 `## 已定`（≤10 条）、去掉勾选框；`## 撤销` 取消；
 *     每条条目限字数且必须带源码出处。
 */
export const PUZZLE_VERSION = 3

/**
 * 旧「完成度」折算成五维时的统一折扣。
 *
 * 完成度只说明**做过**，不足以给高分——它是单维自评，而五维问的是复杂度、可拓展性、
 * 可维护性、质量沉淀、可复用性。统一 ×0.5 是刻意的保守，且**不用伪造逐维精度**：
 * 五个不同的系数看着更"准"，其实是凭空编的比例。折算值只是起点，等真实证据写进来就该被替换。
 */
export const PROGRESS_TO_HEALTH = 0.5

/**
 * 只拼不写模式下仍然允许的工具。
 *
 * 拦截点是 `tools/pre-execute`（可返回 `{kind:'deny'}`）——不是 `agent/pre-step`：
 * 后者的 `decision.messages` 契约是 `UserMessage[]`，里面根本没有 tool-call，
 * 在那上面做「剔除 assistant 消息」的拦截是死代码。
 *
 * 注意：文档写入**只能**走 `puzzle_mode` 工具（它做 slug 过滤与路径守卫）。
 * `write` / `edit` 不在白名单里，是有意的——它们能绕过守卫写到拼图目录之外。
 */
export const PUZZLE_ONLY_ALLOWED_TOOLS = ['puzzle_mode', 'read', 'grep', 'glob', 'ask_user_question', 'todo_write']

/* ------------------------------- 项目健康性 ------------------------------- */

/**
 * 五个健康性维度。**全部越高越好**（含「维护系数」——高分表示维护负担轻）。
 *
 * `derive` 是该维度的证据推导：模型没在文档里显式写分数时，用它从文档内容推。
 * 设计原则：**健康性反映的是「已经写在文档里的证据」，不是模型凭感觉打的印象分**。
 * 所以没有文档就没有健康性——空模块五维全 0，而不是"看起来还行给 60"。
 */
export const HEALTH_DIMENSIONS = [
  {
    key: 'complexity',
    name: '任务复杂度',
    /** 复杂度是中性事实：只有真的记下来了才拿得到分。 */
    hint: '模块实际承担的任务量；记下的要点与细节越多越完整',
    derive: (evidence) => clampPercent((evidence.points * 12) + (evidence.detail * 10)),
  },
  {
    key: 'extensibility',
    name: '可拓展性',
    hint: '还能往哪里长：悬而未决与已定的决策越多，扩展空间越清晰（模块自己的 + 主文档的）',
    // 可拓展性的证据只来自**模块文档**的悬而未决 / 已定：
    // v3 起主文档不再有决策小节（只剩四个索引 + 坑），项目级决策没有载体了。
    derive: (evidence) => clampPercent(
      ((evidence.pending ?? 0) + (evidence.decided ?? 0)) * 20,
    ),
  },
  {
    key: 'maintenance',
    name: '维护系数',
    hint: '维护负担轻的程度（高分 = 好维护）：要点写清了才敢改',
    derive: (evidence) => clampPercent((evidence.points * 18) + (evidence.detail * 8)),
  },
  {
    key: 'quality',
    name: '代码质量',
    hint: '坑与决策的沉淀程度：踩过的坑记下来了，质量才站得住',
    derive: (evidence) => clampPercent((evidence.pit * 25) + (evidence.decided * 15)),
  },
  {
    key: 'reusability',
    name: '可复用性',
    hint: '有多少可被别处复用的东西（共享模块、公共接口、抽象）',
    derive: (evidence) => clampPercent((evidence.shared * 30) + (evidence.points * 10)),
  },
]
export const HEALTH_KEYS = HEALTH_DIMENSIONS.map((dimension) => dimension.key)

/** 维度名的别名 → 规范名。`维护成本` 是反向量，见 parseHealthDeclarations。 */
const HEALTH_ALIASES = new Map([
  ['任务复杂度', 'complexity'],
  ['复杂度', 'complexity'],
  ['可拓展性', 'extensibility'],
  ['可扩展性', 'extensibility'],
  ['拓展性', 'extensibility'],
  ['维护系数', 'maintenance'],
  ['维护成本', 'maintenance'],
  ['代码质量', 'quality'],
  ['质量', 'quality'],
  ['可复用性', 'reusability'],
  ['复用性', 'reusability'],
])

/** 反向维度：写的是成本，取值要翻过来（100 − x）才是「越高越好」。 */
const INVERSE_LABELS = new Set(['维护成本'])

/** 模块文档里的健康性小节（项目级五维汇总也写在这里）。 */
export const HEALTH_HEADING = '## 健康性'

/**
 * 主文档固定小节，顺序即模板顺序。
 *
 * **只有这四节**（用户裁定）：模块索引 / 源码索引 / 工具索引 / 坑。
 * 用户原话、悬而未决、已定、撤销一律不再写进主文档——用户原话不再入库；
 * 决策写在模块文档里；撤销项直接删除。轮汇报写进模块文档的 `## 详细记录`。
 */
export const SECTION_ORDER = ['index', 'source', 'tools', 'pit']
export const SECTION_HEADINGS = {
  index: '## 模块索引',
  source: '## 源码索引',
  tools: '## 工具索引',
  pit: '## 坑',
}
const HEADING_BY_KEY = SECTION_ORDER.map((key) => [key, SECTION_HEADINGS[key]])
const SECTION_KEYS = new Set(SECTION_ORDER)

/** v2 的合并小节：迁移时按勾选框拆成 `## 悬而未决` / `## 已定`。 */
export const RELATED_HEADING = '## 与本模块相关的悬而未决 / 已定 / 撤销'

/** 模块文档固定小节，顺序即模板顺序（**不再有勾选框**）。 */
export const MODULE_SECTION_KEYS = ['health', 'progress', 'points', 'pending', 'decided', 'detail']
export const MODULE_SECTION_HEADINGS = {
  health: HEALTH_HEADING,
  progress: '## 进度',
  points: '## 要点',
  pending: '## 悬而未决',
  decided: '## 已定',
  detail: '## 详细记录',
}
export const MODULE_SECTION_ORDER = MODULE_SECTION_KEYS.map((key) => MODULE_SECTION_HEADINGS[key])

/**
 * 单条条目的字数上限（一个字算 1，标点也算）。
 *
 * 计数只算「一句话」，**源码出处不占额度**：条目格式固定为
 *   `- <一句话>（源码: <文件>[:<行>]）`
 * `（源码…` 之前的部分才计入。超限就**拒绝写入**（不是截断）——
 * 截断会把半句话落进文档，比让模型重写一遍更糟。
 */
export const ENTRY_LIMITS = { index: 50, source: 50, tools: 50, pit: 20, points: 20, detail: 50 }

/**
 * 每模块的条数上限：超了**删最旧**。
 *
 * 条目是追加写的，列表最前面就是最早的，所以保留末尾 N 条。
 */
export const ENTRY_CAPS = { pending: 4, decided: 10 }

/** 条目里源码出处的起始标记。 */
export const SOURCE_MARK = '（源码'

/** 每个图块的满分（用于 UI 显示 得分/满分）。 */
export const PIECE_MAX = 100

/* ---------------------------------- 小工具 ---------------------------------- */

function listFiles(dir) {
  try {
    return readdirSync(dir)
  } catch (_error) {
    return []
  }
}

function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch (_error) {
    return false
  }
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0
  return clampPercent(values.reduce((sum, value) => sum + value, 0) / values.length)
}

/** 解析一个安全 slug；返回 null 表示这个名字不能用。 */
export function slugify(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[\\/:*?"<>|#%&{}$!'@`+=~^[\];,]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 64)
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return null
  return cleaned
}

/** 今天的日期前缀，形如 2026-09-19。 */
export function defaultProjectName(text, now = new Date()) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  const word = slugify(typeof text === 'string' ? text.replace(/[\s，。,.、:：;；!！?？]/g, '/').trim().slice(0, 12) : '')
  const tail = word === null || word === '' ? '项目' : word.split('-').filter(Boolean).slice(0, 2).join('-')
  return `${stamp}-${tail}`
}

export function timestamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    now.getFullYear(), '-', pad(now.getMonth() + 1), '-', pad(now.getDate()),
    ' ', pad(now.getHours()), ':', pad(now.getMinutes()), ':', pad(now.getSeconds()),
  ].join('')
}

/* ------------------------------- front-matter ------------------------------- */

/**
 * 写一段 front-matter。
 *
 * 主文档：`项目 / 模式 / 计划模块 / 会话`；模块文档：`项目 / 模块`。
 * 「模式」是项目级设置，模块文档不带它（早先模板误抄了 `模式:`，已去掉）。
 * 模块列表走 JSON，避免与 `、` 之类的分隔符冲突；`会话` 同理，是 JSON 字符串数组，
 * **只在非空时才写这一行**——老文档没绑定时保持原样，不凭空多出一行。
 */
export function formatFrontMatter(fields) {
  const modules = Array.isArray(fields.modules) ? fields.modules : []
  const lines = [
    '---',
    `puzzle: ${fields.puzzle ?? PUZZLE_VERSION}`,
    `项目: ${fields.project ?? ''}`,
  ]
  if (typeof fields.module === 'string' && fields.module !== '') {
    lines.push(`模块: ${fields.module}`)
  } else {
    lines.push(`模式: ${fields.mode ?? DEFAULT_MODE}`)
    lines.push(`计划模块: ${JSON.stringify(modules)}`)
    // 源码根：**文档目录与源码目录常常不在一处**（本项目就是：文档在
    // /sdcard/dsha222/拼图模式插件/拼图/，源码在 /root/.dsh/plugin-src/dsh-puzzle-mode/）。
    // 记在文档里，审查的源码体检才知道去哪看；没记就退回「项目目录」。
    const sourceRoot = typeof fields.sourceRoot === 'string' ? fields.sourceRoot.trim() : ''
    if (sourceRoot !== '') lines.push(`${SOURCE_ROOT_FIELD}: ${sourceRoot}`)
    // 会话绑定只写在主文档上：一个会话只绑一个项目，绑定随文档走。
    const sessions = normalizeSessions(fields.sessions)
    if (sessions.length > 0) lines.push(`${SESSION_FIELD}: ${JSON.stringify(sessions)}`)
  }
  lines.push(`更新时间: ${fields.updated ?? timestamp()}`, '---')
  return lines.join('\n')
}

/** 读一份文档开头的 front-matter；没有则返回一个空对象。 */
export function parseFrontMatter(text) {
  const out = { fields: {}, body: text }
  if (typeof text !== 'string') return out
  const normalized = text.replace(/^\uFEFF/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalized)
  if (match === null) return out
  const parsed = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    parsed[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { fields: parsed, body: normalized.slice(match[0].length) }
}

/** 归一化会话 ID 列表：去空、去重、保序。 */
function normalizeSessions(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (typeof item !== "string") continue
    const value = item.trim()
    if (value === "" || out.includes(value)) continue
    out.push(value)
  }
  return out
}

/** 读主文档 front-matter 里的 `会话:` 数组；缺失或坏 JSON 都当作空列表，不抛错。 */
export function parseSessionList(fields) {
  const raw = fields !== null && typeof fields === "object" ? fields[SESSION_FIELD] : undefined
  if (typeof raw !== "string" || raw.trim() === "") return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return normalizeSessions(parsed)
  } catch (_error) {
    // 坏 JSON 不能让整个状态读取失败：当成没绑定，面板照样能用。
    return []
  }
}

/**
 * 读主文档 front-matter 里的 `源码根:`；缺失返回空串（= 用默认规则去找）。
 *
 * 与 `parseSessionList` 一样**不抛错**：坏值当没写，审查退回默认源码根。
 */
export function parseSourceRoot(fields) {
  const raw = fields !== null && typeof fields === 'object' ? fields[SOURCE_ROOT_FIELD] : undefined
  return typeof raw === 'string' ? raw.trim() : ''
}

/* --------------------------------- 小节读写 --------------------------------- */

/** 取出某个 `## 标题` 小节的正文（到下一个 `## ` 为止）。 */
export function getSection(text, heading) {
  const lines = String(text ?? '').split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === heading.trim()) {
      start = i + 1
      break
    }
  }
  if (start < 0) return null
  let end = lines.length
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

/** 按 KEY → 标题 读出全部小节。 */
export function sectionMap(text) {
  const out = {}
  for (const [key, heading] of HEADING_BY_KEY) out[key] = getSection(text, heading)
  return out
}

/**
 * 替换/插入一个小节。返回值直接写盘，所以只在这里做一次行级拼装：
 * 找到 `## 标题` 就替换它的正文，找不到就插到最后一个已知小节之后（没有就插到文末）。
 */
export function withSection(text, heading, content) {
  const body = String(content ?? '').replace(/^\n+/, '').replace(/\s+$/, '')
  const lines = String(text ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === heading.trim())
  const block = body === '' ? [] : body.split('\n')

  if (start >= 0) {
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^##\s/.test(lines[i])) {
        end = i
        break
      }
    }
    // 小节之间保留一个空行：`block` 后面紧跟下一个 `## ` 会让标题贴着上一条，
    // 渲染出来是一个大段落。只有当后面**确实还有内容**（end < lines.length）时才补。
    const tail = end < lines.length ? [''] : []
    return [...lines.slice(0, start + 1), ...block, ...tail, ...lines.slice(end)].join('\n')
  }

  let insertAt = lines.length
  for (const [, known] of HEADING_BY_KEY) {
    const at = lines.findIndex((line) => line.trim() === known.trim())
    if (at >= 0) insertAt = Math.max(insertAt, at + 1)
  }
  if (insertAt < lines.length) {
    let end = lines.length
    for (let i = insertAt; i < lines.length; i += 1) {
      if (/^##\s/.test(lines[i])) {
        end = i
        break
      }
    }
    insertAt = end
  }
  return [...lines.slice(0, insertAt), '', heading, ...block, ...lines.slice(insertAt)].join('\n')
}

/** 覆盖或追加一个小节。 */
export function applySection(text, heading, content, append) {
  const current = getSection(text, heading)
  if (append === true && current !== null && current.trim() !== '') {
    const merged = `${current.replace(/\s+$/, '')}\n${String(content ?? '').replace(/^\n+/, '').replace(/\s+$/, '')}`
    return withSection(text, heading, merged)
  }
  return withSection(text, heading, content)
}

/* --------------------------------- 健康性解析 --------------------------------- */

/** 五维各一行，`维度: 分数`。这是模型可以直接写、人也能一眼看懂的格式。 */
export function healthLines(scores) {
  return HEALTH_DIMENSIONS
    .map((dimension) => `- ${dimension.name}: ${clampPercent(scores[dimension.key] ?? 0)}`)
    .join('\n')
}

/**
 * 模板里的健康性小节：**只列维度名、不写数字**。
 *
 * 早先的模板直接写 `任务复杂度: 0`，结果那五行被当成「显式声明 0」，
 * 推导永远不生效——空文档看起来像是"评估过了，全是 0"。
 * 留空则解析不出声明，推导正常工作，模型想覆盖再填数字。
 */
export function healthTemplateLines() {
  return HEALTH_DIMENSIONS
    .map((dimension) => `- ${dimension.name}: `)
    .join('\n')
}

/**
 * 解析文档里显式写的维度分数。
 *
 * 接受 `任务复杂度: 80`、`- 可拓展性：75`、`**维护系数**: 90` 等写法；
 * `维护成本: 30` 会被翻成 `维护系数: 70`（成本型 → 越高越好）。
 */
export function parseHealthDeclarations(text) {
  const declared = {}
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    // 顺序要紧：先去掉 `**粗体**`，再去列表符。
    // 反过来会把 `**维护系数**: 90` 开头的 `*` 当成列表符吃掉一个，
    // 剩下 `*维护系数: 90` 就再也匹配不上维度名了。
    const line = raw
      .replace(/\*\*/g, '')
      .replace(/^\s*[-*]\s*/, '')
      .trim()
    const match = /^([\u4e00-\u9fa5]{2,8})\s*[:：]\s*(\d{1,3})\s*$/.exec(line)
    if (match === null) continue
    const key = HEALTH_ALIASES.get(match[1])
    if (key === undefined) continue
    const value = clampPercent(Number(match[2]))
    declared[key] = INVERSE_LABELS.has(match[1]) ? clampPercent(100 - value) : value
  }
  return declared
}

/**
 * 从一份模块文档算出五维分数。
 *
 * 显式写了就用显式值（模型有上下文，比公式准）；没写则由证据推导。
 * `return` 里带 `sources`，说明每一维是显式还是推导来的——面板据此标注，
 * 免得把"公式推出来的"当成"模型评估过的"。
 */
export function healthOf(moduleText, projectText) {
  const text = typeof moduleText === 'string' ? moduleText : ''
  const body = text === '' ? '' : parseFrontMatter(text).body
  const projectBody = typeof projectText === 'string' && projectText !== '' ? parseFrontMatter(projectText).body : ''

  const pointsText = getSection(body, MODULE_SECTION_HEADINGS.points) ?? ''
  const detailText = getSection(body, MODULE_SECTION_HEADINGS.detail) ?? ''
  // v3 起悬而未决 / 已定是模块文档里的**两个独立小节**，不再靠勾选框区分。
  // 旧格式（v2）的合并小节在迁移时会被拆开，所以这里只认新小节。
  const pendingText = getSection(body, MODULE_SECTION_HEADINGS.pending) ?? ''
  const decidedText = getSection(body, MODULE_SECTION_HEADINGS.decided) ?? ''
  const sharedText = getSection(body, '## 可复用') ?? ''
  // 主文档的「坑」是所有模块共用的项目级证据（v3 主文档只剩四节，坑是其中之一）。
  const projectPitText = getSection(projectBody, SECTION_HEADINGS.pit) ?? ''

  const evidence = {
    points: countItems(pointsText),
    detail: countItems(detailText),
    pending: countItems(pendingText),
    decided: countItems(decidedText),
    pit: countItems(projectPitText),
    shared: countItems(sharedText),
  }

  const declaredModule = parseHealthDeclarations(getSection(body, HEALTH_HEADING) ?? '')
  // 项目级显式分数已取消：v3 的主文档只剩四个索引 + 坑，没有 `## 健康性` 的容身处。
  // 五维一律来自模块文档（显式或推导），项目健康性 = 各模块均值。
  const scores = {}
  const sources = {}
  for (const dimension of HEALTH_DIMENSIONS) {
    if (Object.hasOwn(declaredModule, dimension.key)) {
      scores[dimension.key] = declaredModule[dimension.key]
      sources[dimension.key] = 'module'
    } else {
      scores[dimension.key] = dimension.derive(evidence)
      sources[dimension.key] = 'derived'
    }
  }
  return { scores, sources, evidence, health: average(HEALTH_KEYS.map((key) => scores[key])) }
}

/** 项目健康性 = 各模块健康性的均值（没有模块就是 0）。 */
export function projectHealthOf(modules) {
  if (!Array.isArray(modules) || modules.length === 0) return 0
  return average(modules.map((module) => (module.health === undefined ? 0 : module.health)))
}

/** 五维在项目层面的均值（面板顶部的五个维度块用它）。 */
export function dimensionAverages(modules) {
  const out = {}
  for (const key of HEALTH_KEYS) {
    out[key] = average((Array.isArray(modules) ? modules : []).map((module) => (
      module.healthScores === undefined ? 0 : module.healthScores[key] ?? 0
    )))
  }
  return out
}

/* --------------------------------- 审查 --------------------------------- */

/**
 * 审查 = 客观事实（本文件算）+ 一针见血的评价（模型写）。
 *
 * 这里只做前半段：把「文档里能数出来的事实」摆齐，每条带一个可执行的下一步。
 * 评价不在这里生成——规则写不出人话，而「一针见血」恰恰要上下文：这个项目在
 * 干什么、哪条证据本该有却没有。所以 `op:'audit'` 返回事实 + `AUDIT_PROMPT`，
 * 由模型照着写点评（用户选定：审查正文只由模型自由点评）。
 */

/** 一个维度「本该有」的证据来自哪些计数。 */
const DIMENSION_EVIDENCE = {
  complexity: ['points', 'detail'],
  extensibility: ['pending', 'decided'],
  maintenance: ['points', 'detail'],
  quality: ['pit', 'decided'],
  reusability: ['shared', 'points'],
}

/** 每一维「怎么提高」的具体动作（审查建议的落点，不是泛泛而谈）。 */
export const DIMENSION_FIX = {
  complexity: '把该模块的关键结论写进 ## 要点（一行一条事实），需要时补 ## 详细记录。',
  extensibility: '把还没定的写进「悬而未决」、定了的写进「已定」——两项都是 0 就没有扩展空间可言。',
  maintenance: '要点写清了才敢改：先补 ## 要点，再补模块之间的依赖关系。',
  quality: '把踩过的坑写进主文档 ## 坑，把结论写进 ## 已定。',
  reusability: '把可被别处复用的接口 / 共享模块单独写出来（模块文档的 ## 可复用）。',
}

/** 给模型照着写点评的指令。**不生成点评本身**——那是模型的事。 */
export const AUDIT_PROMPT = [
  '现在按五维写审查，**并把分数改成真实值**（这是审查的目的，不只是评论）。',
  '',
  '### 一、先说事实（不要空话）',
  '1. 先点名**最弱的一维**、它落在哪个模块，再逐条列问题；每条问题后面必须带数字或文档事实。',
  '2. 允许直说：写「这一维的分数是自己封的」都不过分，只要事实对得上。',
  '3. 每条问题配一条**可执行的下一步**（动哪个 op、写哪一节）。',
  '',
  '### 二、把虚高的分改回真实值（必做）',
  '返回里的 `inflation` 数组就是「你之前自评的分数」与「真实值」的差额，逐条列好了：',
  '`declared` 是手写值，`trueValue` 是**由文档证据 + 源码体检算出来的**，`because` 是差在哪。',
  '- 对每一条，用 `puzzle_mode{op:"health", name:"<模块名>", content:"<维度名>: <trueValue>…", append:false}`',
  '  **把该模块的分改成 `trueValue`**——一次把该模块五维都写上，别只改被点名的那一维。',
  '- 全局值不用手写（项目健康性 = 各模块均值，宿主汇总）；改完模块，全局自然跟着降。',
  '- **不许反过来**：不要为了保住高分去改文档凑证据。分数是结论，不是目标。',
  '',
  '### 三、工程化问题要真的动代码',
  '`source` 里是源码体检事实（文件行数、最长函数、目录分层）。`source_*` 类问题',
  '**改分数解决不了**——那是代码结构的问题，必须真的拆文件 / 拆函数：',
  '- 单文件超 800 行 → 按职责拆；超 2000 行（fail）→ 必须先拆再谈别的。',
  '- 巨函数（>60 行）→ 按步骤拆成几个小函数，名字就是文档。',
  '- 「一个文件装下整个项目」→ 先切成 4-8 个文件。',
  '拆完再跑一次 `op:audit`，真实值应当自己回升——**靠拆代码涨的分才是真的**。',
  '',
  '### 四、两类条目级发现优先清',
  '`entry_issue` / `main_entry_issue` 说明条目本身不合规格（超字数，或缺 `（源码: 文件:行）`）。',
  '修法固定：`op:main` / `op:module` 带 `append:false` 重写那一节。',
  '',
  '### 五、诚实边界',
  '- 某维 `fromSource` 是 `null` 表示**没有源码可查**，那一维不是实测值——要如实说，不要当成测过了。',
  '- 最后一句整体判断：这个项目现在最该补的一件事是什么。',
].join('\n')

function dimensionName(key) {
  const found = HEALTH_DIMENSIONS.find((dimension) => dimension.key === key)
  return found === undefined ? key : found.name
}

/** 一个维度的证据总量（用它判断「手写分数有没有依据」）。 */
function evidenceOf(evidence, key) {
  const list = DIMENSION_EVIDENCE[key] ?? []
  return list.reduce((sum, name) => sum + (evidence?.[name] ?? 0), 0)
}

/** 主文档各节的证据条数（去掉空行与模板占位）。 */
export function sectionCounts(body) {
  const out = {}
  for (const key of SECTION_ORDER) out[key] = countItems(getSection(body, SECTION_HEADINGS[key]) ?? '')
  return out
}

/** 五维按分数升序排列——审查先说最弱的那一维。 */
export function dimensionRanking(dimensions) {
  const source = dimensions !== null && typeof dimensions === 'object' ? dimensions : {}
  return HEALTH_KEYS
    .map((key) => ({ key, name: dimensionName(key), value: source[key] ?? 0 }))
    .sort((left, right) => left.value - right.value)
}

function finding(id, level, dimension, scope, fact, fix) {
  return { id, level, dimension, scope, fact, fix }
}

/**
 * 把当前状态过一遍，输出**客观发现清单**。只陈述事实，不做评价。
 *
 * 不抛错：状态缺字段一律按 0 处理（未初始化的项目也会走到这里）。
 */
export function auditOf(state) {
  const safe = state !== null && typeof state === 'object' ? state : {}
  const modules = Array.isArray(safe.modules) ? safe.modules : []
  const sections = safe.sections !== null && typeof safe.sections === 'object' ? safe.sections : {}
  const dimensions = safe.dimensions !== null && typeof safe.dimensions === 'object' ? safe.dimensions : {}
  const findings = []

  // 旧格式先报：它是「数字可能偏低」的上游原因，排在其它发现前面。
  if (safe.outdated === true) {
    findings.push(finding('doc_outdated', 'warn', null, 'project',
      '文档格式是 puzzle ' + (safe.version ?? '?') + '，当前是 ' + PUZZLE_VERSION + '：旧格式主文档有六个小节（含已取消的 用户原话 / 撤销），模块文档缺 ## 悬而未决 / ## 已定，五维只能靠推导，分数会偏低。',
      "用 op:rebuild 看预览（默认 dry-run），确认后 apply:true 迁移；它只改形状，正文不动。"))
  }

  if (modules.length === 0) {
    findings.push(finding('no_modules', 'blocker', null, 'project',
      '项目里一个模块都没有，五维无从算起，项目健康性是 0。',
      '用 op:init 带 modules 一次建齐，或用 op:module 建第一个模块。'))
  }

  // 主文档只剩四节，其中「坑」是所有模块共用的项目级证据。
  if ((sections.pit ?? 0) === 0) {
    findings.push(finding('pit_empty', 'warn', 'quality', 'project',
      '主文档「坑」0 条：踩过的坑没有沉淀下来，代码质量这一维只能靠模块的「已定」撑。',
      DIMENSION_FIX.quality))
  }
  if ((sections.source ?? 0) === 0) {
    findings.push(finding('source_empty', 'info', null, 'project',
      '主文档「源码索引」0 条：查找方向是 主文档 → 源码，索引为空就只能靠翻目录。',
      '把关键实现文件用 op:main section:source 记进去（一句话 + 源码: 文件:行）。'))
  }
  if ((sections.tools ?? 0) === 0) {
    findings.push(finding('tools_empty', 'info', null, 'project',
      '主文档「工具索引」0 条：本项目用到的 op / 脚本 / 外部命令没有一处索引。',
      '把常用入口用 op:main section:tools 记进去（一句话 + 源码: 文件:行）。'))
  }

  // 主文档的条目也逐条验：四节里任何一条超长/无出处，都是 v3 规格破了。
  // 只报**条数与样例**，不逐条刷屏。
  for (const issue of Array.isArray(safe.mainEntryIssues) ? safe.mainEntryIssues : []) {
    const parts = []
    if (issue.tooLong > 0) parts.push(issue.tooLong + ' 条超 ' + issue.limit + ' 字')
    if (issue.noSource > 0) parts.push(issue.noSource + ' 条没出处')
    findings.push(finding('main_entry_issue:' + issue.key, 'warn', null, 'project',
      '主文档「' + issue.heading + '」有 ' + parts.join('、') + '（例：' + issue.sample + '…）。',
      '用 op:main section:' + issue.key + ' append:false 重写这一节：每条一句话（≤' + issue.limit + ' 字）+（源码: 文件:行）。'))
  }

  // 「五维全靠公式推」的模块先收集起来：全都如此时只报一条，免得刷屏。
  const unreviewed = []
  for (const module of modules) {
    const name = String(module.name ?? '?')
    const counts = module.counts ?? {}
    const evidence = module.evidence ?? {}
    const progress = module.progress

    if (module.exists !== true) {
      findings.push(finding('module_missing:' + name, 'warn', null, name,
        '模块「' + name + '」只有图块、没有文档，五维全 0。',
        '用 op:module name:' + name + ' section:points 写下第一段事实。'))
      continue
    }

    // 已存在的条目不受写入校验约束（迁移不追溯），所以这里逐条查——
    // 否则「要点 15 条」看着充实，实则 15 条全超长且全无出处。
    for (const issue of Array.isArray(module.entryIssues) ? module.entryIssues : []) {
      const parts = []
      if (issue.tooLong > 0) parts.push(issue.tooLong + ' 条超 ' + issue.limit + ' 字')
      if (issue.noSource > 0) parts.push(issue.noSource + ' 条没出处')
      findings.push(finding('entry_issue:' + name + ':' + issue.key, 'warn', null, name,
        '模块「' + name + '」的「' + issue.heading + '」有 ' + parts.join('、') + '。',
        '用 op:module name:' + name + ' section:' + issue.key + ' append:false 重写这一节：每条一句话（≤'
        + issue.limit + ' 字）+（源码: 文件:行）。'))
    }

    const content = (counts.points ?? 0) + (evidence.detail ?? 0) + (counts.pending ?? 0) + (counts.decided ?? 0)
    if (content === 0) {
      findings.push(finding('module_empty:' + name, 'blocker', null, name,
        '模块「' + name + '」文档里 0 条要点、0 条详细记录、0 条决策：五维全 0。',
        '先补 ## 要点（2-3 条事实），再补 ## 详细记录；空文档没有健康性可谈。'))
    } else if ((counts.pending ?? 0) === 0 && (counts.decided ?? 0) === 0) {
      findings.push(finding('no_open_questions:' + name, 'warn', 'extensibility', name,
        '模块「' + name + '」既没有悬而未决也没有已定：可拓展性拿不到分。',
        DIMENSION_FIX.extensibility))
    }

    // 上限是硬规则（悬而未决 ≤4 / 已定 ≤10），超了就是没按规则删旧的。
    for (const key of ['pending', 'decided']) {
      const cap = ENTRY_CAPS[key]
      const count = counts[key] ?? 0
      if (count <= cap) continue
      findings.push(finding('over_cap:' + name + ':' + key, 'warn', 'extensibility', name,
        '模块「' + name + '」的「' + MODULE_SECTION_HEADINGS[key] + '」有 ' + count + ' 条，超过上限 ' + cap + ' 条。',
        '写入时会自动删最旧的，保留末尾 ' + cap + ' 条；也可以自己先用 op:module section:' + key + ' append:false 重写一份。'))
    }

    if (typeof progress === 'number' && progress >= 80 && (counts.points ?? 0) === 0) {
      findings.push(finding('progress_no_points:' + name, 'blocker', 'maintenance', name,
        '模块「' + name + '」完成度写 ' + progress + '，但要点 0 条。',
        '要么把要点补上（完成度才有依据），要么把完成度改成真实值。'))
    }

    for (const dimension of HEALTH_DIMENSIONS) {
      const source = (module.healthSources ?? {})[dimension.key]
      if (source !== 'module' && source !== 'project') continue
      if (evidenceOf(evidence, dimension.key) > 0) continue
      const score = (module.healthScores ?? {})[dimension.key] ?? 0
      findings.push(finding('declared_without_evidence:' + name + ':' + dimension.key, 'warn', dimension.key, name,
        '模块「' + name + '」的「' + dimension.name + '」手写了 ' + score + ' 分，但对应证据 0 条。',
        DIMENSION_FIX[dimension.key]))
    }

    const allDerived = HEALTH_KEYS.every((key) => (module.healthSources ?? {})[key] === 'derived')
    if (allDerived && module.health > 0) unreviewed.push(name)
  }

  if (unreviewed.length > 0) {
    const scope = unreviewed.length === modules.length && modules.length > 0 ? 'project' : unreviewed.join('、')
    findings.push(finding('never_reviewed', 'info', null, scope,
      unreviewed.length + ' 个模块的五维全是公式推出来的，没有一处人工判断：' + unreviewed.join('、') + '。',
      '对最弱的一维写显式分数并说明理由（## 健康性 里写「维度名: 分数」）。'))
  }

  const ranking = dimensionRanking(dimensions)
  if (modules.length > 0 && ranking[0].value < 100) {
    findings.push(finding('weakest_dimension', 'info', ranking[0].key, 'project',
      '最弱一维是「' + ranking[0].name + '」= ' + ranking[0].value + '%（跨模块均值）。',
      DIMENSION_FIX[ranking[0].key]))
  }

  // 源码工程化的发现**不在这里**：`auditOf` 由 `readState` 调用，而 `op:read` 每轮都跑，
  // 不该每次都去扫源码树。源码体检只在 `op:audit` 里做，发现由调用方并进返回。
  return findings
}

/* ------------------------------- 版本与迁移 ------------------------------- */

/** 读一份文档的 front-matter 版本；缺失或坏值都按 1（最早的那版）。 */
export function docVersion(text) {
  const { fields } = parseFrontMatter(typeof text === "string" ? text : "")
  const raw = fields.puzzle
  const value = Number.parseInt(typeof raw === "string" ? raw : "", 10)
  if (!Number.isFinite(value) || value < 1) return 1
  return value
}

/**
 * 迁移链：每一步把文档从 `from` 版改到 `to` 版。
 *
 * 只在**形状**上动手（front-matter 字段、小节是否存在与顺序），不动用户写的正文；
 * 唯一一处"造内容"是 v1→v2 把旧完成度折算成五维，且只在推导拿不到分时才填。
 * `changes` 里逐条说明改了什么，dry-run 与落盘共用同一份结果。
 */
const MIGRATIONS = [
  {
    from: 1,
    to: 2,
    label: "v1 → v2：模块 front-matter 去 模式:/计划模块: 并补 模块:；补 ## 健康性（旧完成度折算）；主文档补 会话:",
  },
  {
    from: 2,
    to: 3,
    label: "v2 → v3：主文档收敛为 模块索引/源码索引/工具索引/坑 四节（用户原话·悬而未决·已定·撤销整节删除）；模块的合并小节拆成 ## 悬而未决（≤4）与 ## 已定（≤10）并去掉勾选框",
  },
]

export function pendingMigrations(version) {
  return MIGRATIONS.filter((step) => step.from >= version)
}

/**
 * v2 及更早版本里主文档有、v3 已取消的小节（整节删除，内容不外迁）。
 *
 * `## 健康性` 也在列：v3 起项目级健康性不再写进文档（它是模块均值，写下来只会与事实矛盾）。
 */
const DROPPED_MAIN_SECTIONS = ['## 用户原话', '## 悬而未决', '## 已定', '## 撤销', '## 健康性']

/** 旧模板的说明行（整行完全一致才替换），迁移时换成 v3 的三行说明。 */
const OLD_PREAMBLE_LINES = new Set([
  '> 本文件只做检索、坑、原话与三类决策；细节一律在 `模块/` 下。',
  '> 项目健康性由模块文档的五维分数汇总得出，不在本文件手写总分。',
])

/** v3 模板的三行说明（迁移时补齐）。 */
export const PREAMBLE_LINES = [
  '> 只有四节：模块索引 / 源码索引 / 工具索引 / 坑。决策与轮汇报在 `模块/` 下。',
  '> 每条一句话 + 出处（源码: 文件:行）；查找方向固定为 主文档 → 源码。',
  '> 项目健康性由模块文档的五维分数汇总得出，不在本文件手写总分。',
]

/**
 * 把正文拆成 `## ` 小节：前导部分 + 标题 → 内容行。
 *
 * 同名小节**合并**而不是丢弃——重复标题是老文档里真实出现过的
 * （手工编辑留下的第二份），丢掉第二份就是静默删内容。
 */
function splitSections(body) {
  const lines = String(body ?? '').split(/\r?\n/)
  const preamble = []
  const groups = new Map()
  const order = []
  let current = null
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      const heading = line.trim()
      if (!groups.has(heading)) {
        groups.set(heading, [])
        order.push(heading)
      }
      current = heading
      continue
    }
    if (current === null) preamble.push(line)
    else groups.get(current).push(line)
  }
  return { preamble, groups, order }
}

/** 按给定顺序把拆出来的小节拼回去；未列出的小节按原顺序附在末尾。 */
function joinSections(preamble, groups, order, headings) {
  const parts = []
  const head = preamble.join('\n').replace(/\s+$/, '')
  if (head.trim() !== '') parts.push(head)
  const emitted = new Set()
  const push = (heading) => {
    emitted.add(heading)
    const lines = groups.get(heading) ?? []
    parts.push([heading, ...lines].join('\n').replace(/\s+$/, ''))
  }
  for (const heading of headings) if (groups.has(heading)) push(heading)
  // `order` 里可能还留着**已被删除**的标题（删的是 groups 里的键，order 没跟着动）。
  // 必须再查一次 groups，否则删掉的小节会以空标题的形式重新出现——实测就是这么错的。
  for (const heading of order) if (!emitted.has(heading) && groups.has(heading)) push(heading)
  return parts.join('\n\n') + '\n'
}

/**
 * 迁移期的条目搬移：**只去勾选框、只按上限删最旧，不校验字数与出处**。
 *
 * 为什么不能用 `normalizeEntries`：它会要求每条都带 `（源码: …）`，
 * 而老文档里的条目本来就没有出处——那会让整段内容**静默变成「（待补）」**。
 * 迁移只改形状，正文不能因为新规则而被抹掉；新规则从下一次写入开始生效。
 */
function migrateEntries(lines, cap) {
  const out = entryLines(lines.join('\n'))
  const overflow = cap !== undefined && out.length > cap ? out.slice(0, out.length - cap) : []
  return { kept: overflow.length > 0 ? out.slice(out.length - cap) : out, dropped: overflow }
}

/**
 * 主文档的规范化：front-matter 补版本与 会话:，并把它收敛成**四节**。
 *
 * v3 起主文档只有 模块索引 / 源码索引 / 工具索引 / 坑。旧版的
 * 用户原话 / 悬而未决 / 已定 / 撤销 **整节删除**（用户裁定：用户原话不再入库，
 * 撤销项直接删除，决策只写在模块文档里）——所以这一步会真的丢内容，
 * dry-run 预览里逐条列出来，落盘前能看清。
 */
function migrateMainDoc(text, projectName, planned) {
  const { fields, body } = parseFrontMatter(text)
  const changes = []
  const version = docVersion(text)
  const sessions = parseSessionList(fields)
  if (version < PUZZLE_VERSION) changes.push("版本 " + version + " → " + PUZZLE_VERSION)
  // 会话行只在**真的需要规范化**时报：
  //   · 完全没有这一行，但有 id 要写 → `formatFrontMatter` 会补出来；
  //   · 有这一行但不是 JSON 数组（手写的 `会话: a、b`）→ 会被归一化成数组。
  // 已经是规范 JSON 数组时什么都不报——否则新建项目每次都被判「有改动」，幂等就破了。
  const rawSessions = fields[SESSION_FIELD]
  const normalized = JSON.stringify(normalizeSessions(sessions))
  if (sessions.length > 0 && (typeof rawSessions !== "string" || rawSessions.trim() !== normalized)) {
    changes.push("front-matter 会话: 归位为 JSON 数组")
  }

  // 用「拆分 → 改 → 按规范顺序拼回」而不是逐个 withSection：
  // withSection 找不到小节时会**追加到末尾**，于是 `## 坑` 会被插到 `## 模块索引` 之前、
  // `## 详细记录` 会被插到 `## 悬而未决` 之前——实测 v2 备份迁移后顺序就是乱的。
  const main = splitSections(body)
  // 旧的「检索索引」改名成「模块索引」：内容合并进新标题，旧标题消失。
  if (main.groups.has('## 检索索引')) {
    const old = main.groups.get('## 检索索引')
    if (main.groups.has(SECTION_HEADINGS.index)) main.groups.get(SECTION_HEADINGS.index).push(...old)
    else main.groups.set(SECTION_HEADINGS.index, old)
    main.groups.delete('## 检索索引')
    changes.push("小节改名 ## 检索索引 → " + SECTION_HEADINGS.index)
  }
  // 说明段：旧模板的措辞（"原话与三类决策"）在 v3 已是错的。
  // 做法是**先摘掉全部说明行再按新顺序补回**，而不是「缺哪行补哪行」——
  // 后者会把新说明追加到旧说明之后，顺序变成 [第3行, 第1行, 第2行]，看着像没改干净。
  // 同时只把**确实过时**的行算作改动：第 3 行新旧完全一致，算成改动会让幂等永远不成立。
  const stale = new Set([...OLD_PREAMBLE_LINES].filter((line) => !PREAMBLE_LINES.includes(line)))
  const hasStale = main.preamble.some((line) => stale.has(line.trim()))
  // 只有真的要改时才动说明行：已经是 v3 说明的文档必须原样保留，
  // 否则「先摘掉再补回」在幂等那次会把三行说明整个删掉。
  const keptPreamble = hasStale
    ? main.preamble.filter((line) => {
      const trimmed = line.trim()
      return !stale.has(trimmed) && !PREAMBLE_LINES.includes(trimmed)
    })
    : main.preamble.slice()
  if (hasStale) {
    // 说明行统一放在标题（与它后面的空行）之后，顺序固定。
    let at = keptPreamble.findIndex((line) => /^#\s/.test(line))
    at = at < 0 ? keptPreamble.length : at + 1
    while (at < keptPreamble.length && keptPreamble[at].trim() === '') at += 1
    keptPreamble.splice(at, 0, ...PREAMBLE_LINES)
    changes.push("更新文件头说明（v3 只剩四节）")
  }
  // 标题与说明之间可能留下连续空行（删行后残留），压成一个。
  const compact = []
  for (const line of keptPreamble) {
    if (line.trim() === '' && compact.length > 0 && compact[compact.length - 1].trim() === '') continue
    compact.push(line)
  }
  main.preamble.length = 0
  main.preamble.push(...compact)
  for (const heading of DROPPED_MAIN_SECTIONS) {
    if (!main.groups.has(heading)) continue
    const count = countItems(main.groups.get(heading).join('\n'))
    main.groups.delete(heading)
    changes.push("删除小节 " + heading + "（v3 已取消，含 " + count + " 条）")
  }
  for (const key of SECTION_ORDER) {
    const heading = SECTION_HEADINGS[key]
    if (main.groups.has(heading)) continue
    // 缺的小节补成占位行：形状补全是重建的目的，内容仍由人写。
    main.groups.set(heading, [key === 'index' ? "- （尚未拆分模块）" : "- （待补）"])
    changes.push("补小节 " + heading)
  }
  const nextBody = joinSections(main.preamble, main.groups, main.order, SECTION_ORDER.map((key) => SECTION_HEADINGS[key]))
  const head = formatFrontMatter({
    puzzle: PUZZLE_VERSION,
    project: fields["项目"] ?? projectName,
    mode: MODES.includes(fields["模式"]) ? fields["模式"] : DEFAULT_MODE,
    modules: planned,
    sessions,
    sourceRoot: parseSourceRoot(fields),
    updated: timestamp(),
  })
  return { text: [head, nextBody.replace(/^\n+/, "")].join("\n"), changes, version, sessions }
}

/**
 * 模块文档的规范化：front-matter 只留 项目:/模块:，缺 ## 健康性 就补，
 * 并把 v2 的合并小节 `## 与本模块相关的悬而未决 / 已定 / 撤销` 拆成
 * `## 悬而未决` / `## 已定` 两个小节（去掉勾选框、按上限删最旧）。
 *
 * 补健康性时：**该维已经有推导分就不填数字**（填了就变成"显式声明"，反而把推导冻住）；
 * 推导为 0 且文档里有旧「完成度」时，按 PROGRESS_TO_HEALTH 折算一个起点，
 * 并在小节里留一行说明——它不是评估结果，是迁移值。
 */
function migrateModuleDoc(text, name, projectText) {
  const { fields, body } = parseFrontMatter(text)
  const changes = []
  const version = docVersion(text)
  if (version < PUZZLE_VERSION) changes.push("版本 " + version + " → " + PUZZLE_VERSION)
  if (fields["模块"] !== name) changes.push("front-matter 补 模块: " + name)
  if (Object.hasOwn(fields, "模式")) changes.push("去掉模块文档上多余的 模式:（模式是项目级设置）")
  if (Object.hasOwn(fields, "计划模块")) changes.push("去掉模块文档上多余的 计划模块:")

  const mod = splitSections(body)
  // 拆分合并小节：`[ ]` → 悬而未决，`[x]` → 已定，其余（说明行）丢掉。
  if (mod.groups.has(RELATED_HEADING)) {
    const lines = mod.groups.get(RELATED_HEADING)
    const pending = lines.filter((raw) => /^\s*[-*]\s*\[ \]/.test(raw))
    const decided = lines.filter((raw) => /^\s*[-*]\s*\[[xX]\]/.test(raw))
    mod.groups.delete(RELATED_HEADING)
    const splitPending = migrateEntries(pending, ENTRY_CAPS.pending)
    const splitDecided = migrateEntries(decided, ENTRY_CAPS.decided)
    // 合并进已有的同名小节（老文档可能已经有 `## 已定`），不覆盖。
    const mergeInto = (heading, kept) => {
      if (kept.length === 0) return
      if (mod.groups.has(heading)) mod.groups.get(heading).push(...kept)
      else mod.groups.set(heading, kept)
    }
    mergeInto(MODULE_SECTION_HEADINGS.pending, splitPending.kept)
    mergeInto(MODULE_SECTION_HEADINGS.decided, splitDecided.kept)
    // 报**真的搬过去**的条数：`- [ ] （待补）` 这类占位行会被 entryLines 丢掉，
    // 按原始行数报就会说「1 + 0 条」而实际一条也没搬——文案与结果不符。
    changes.push("拆分小节 " + RELATED_HEADING + " → " + MODULE_SECTION_HEADINGS.pending
      + " / " + MODULE_SECTION_HEADINGS.decided
      + "（搬了 " + splitPending.kept.length + " + " + splitDecided.kept.length + " 条"
      + (splitPending.dropped.length + splitDecided.dropped.length > 0
        ? "，按上限删了 " + (splitPending.dropped.length + splitDecided.dropped.length) + " 条旧项"
        : "")
      + "）")
  }

  // 旧格式里条目还挂着勾选框；v3 起按小节区分，勾选框一律去掉。
  for (const key of ["pending", "decided", "points", "detail"]) {
    const heading = MODULE_SECTION_HEADINGS[key]
    if (!mod.groups.has(heading)) continue
    const lines = mod.groups.get(heading)
    if (!lines.some((raw) => /^\s*[-*]\s*\[[ xX]\]/.test(raw))) continue
    const cleaned = migrateEntries(lines, ENTRY_CAPS[key]).kept
    mod.groups.set(heading, cleaned)
    changes.push("去掉 " + heading + " 里的勾选框（v3 用两个小节区分）")
  }

  for (const key of ["progress", "points", "pending", "decided", "detail"]) {
    const heading = MODULE_SECTION_HEADINGS[key]
    if (mod.groups.has(heading)) continue
    mod.groups.set(heading, [key === "progress" ? "完成度: 0" : "- （待补）"])
    changes.push("补小节 " + heading)
  }

  if (!mod.groups.has(HEALTH_HEADING)) {
    const progressText = mod.groups.get(MODULE_SECTION_HEADINGS.progress).join("\n")
    const match = /完成度\s*[:：]\s*(\d{1,3})/.exec(progressText)
    const progress = match === null ? null : clampPercent(Number(match[1]))
    const derived = healthOf(text, projectText)
    const lines = HEALTH_DIMENSIONS.map((dimension) => "- " + dimension.name + ": ")
    let filled = 0
    if (progress !== null && progress > 0) {
      const seeded = clampPercent(Math.round(progress * PROGRESS_TO_HEALTH))
      for (let i = 0; i < HEALTH_DIMENSIONS.length; i += 1) {
        const dimension = HEALTH_DIMENSIONS[i]
        // 推导拿得到分的维度不填：一填就变「显式声明」，反而把推导冻在折算值上。
        const hasEvidence = (derived.sources[dimension.key] === "derived" && (derived.scores[dimension.key] ?? 0) > 0)
          || derived.sources[dimension.key] === "module"
        if (hasEvidence) continue
        lines[i] = "- " + dimension.name + ": " + seeded
        filled += 1
      }
      // 说明行只在**真的填了数字**时加：一个都没填却挂着「折算为 N」就是文案与事实矛盾。
      if (filled > 0) {
        lines.push("- （迁移：旧「完成度 " + progress + "」×" + PROGRESS_TO_HEALTH + " = " + seeded + " 分，填给了 " + filled + " 个还拿不到证据的维度；这是起点不是评估，请按真实情况修正）")
      }
    }
    mod.groups.set(HEALTH_HEADING, lines)
    changes.push(filled > 0
      ? "补小节 " + HEALTH_HEADING + "（按旧完成度 " + progress + " 折算，填了 " + filled + " 维）"
      : "补小节 " + HEALTH_HEADING + "（留空；旧完成度缺省或为 0）")
  }

  // 顺序按当前模板：标题 → 健康性 → 进度 → 要点 → 悬而未决 → 已定 → 详细记录。
  const nextBody = joinSections(mod.preamble, mod.groups, mod.order, MODULE_SECTION_ORDER)
  const head = formatFrontMatter({ puzzle: PUZZLE_VERSION, project: fields["项目"] ?? name, module: name, updated: timestamp() })
  return { text: [head, nextBody.replace(/^\n+/, "")].join("\n"), changes, version }
}

/** 磁盘上真的有文件的模块名（不依赖 front-matter 声明）。 */
function modulesOnDisk(puzzleDir) {
  const out = []
  for (const entry of listFiles(join(puzzleDir, MODULE_DIR))) {
    if (!entry.endsWith(".md")) continue
    const name = slugify(entry.slice(0, -3))
    if (name !== null && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * 算「重建要做哪些改动」，**只读不写**。dry-run 与落盘的产物是同一份，
 * 所以「预览里看到的」就是「落盘会做的」。
 */
export function planRebuild(projectRoot, projectName) {
  const slug = slugify(projectName)
  if (slug === null) return { ok: false, error: "项目名不合法", hint: "检查项目名" }
  const puzzleDir = puzzleDirOf(projectRoot, slug)
  if (puzzleDir === null) return { ok: false, error: "项目路径越界", hint: "检查项目名" }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: "项目尚未创建", hint: "先执行 op=init" }
  const mainText = readText(mainDoc)
  if (mainText === null) return { ok: false, error: "主文档读不出来", hint: "检查文件权限" }

  const { fields } = parseFrontMatter(mainText)
  // 计划模块取「声明 ∪ 磁盘」：声明了但没建的要留着（还没写），磁盘上有但没声明的也要迁。
  const declared = safePlanned(fields)
  const onDisk = modulesOnDisk(puzzleDir)
  const names = [...declared]
  for (const name of onDisk) if (!names.includes(name)) names.push(name)

  const main = migrateMainDoc(mainText, slug, names)
  const files = [{
    kind: "main",
    name: slug,
    file: mainDoc,
    version: main.version,
    changes: main.changes,
    text: main.text,
  }]

  for (const name of names) {
    const file = safeJoin(puzzleDir, MODULE_DIR, name + ".md")
    if (file === null || !isFile(file)) {
      files.push({ kind: "module", name, file: file ?? "", version: 0, missing: true, changes: ["模块文档不存在（只有图块）；要用 op:module 写第一段内容才会建出来"], text: null })
      continue
    }
    const text = readText(file)
    if (text === null) {
      files.push({ kind: "module", name, file, version: 0, changes: ["文档存在但读不出来"], text: null })
      continue
    }
    const done = migrateModuleDoc(text, name, mainText)
    files.push({ kind: "module", name, file, version: done.version, changes: done.changes, text: done.text })
  }

  const touched = files.filter((item) => item.changes.length > 0 && typeof item.text === "string")
  return {
    ok: true,
    project: slug,
    puzzleDir,
    mainDoc,
    version: docVersion(mainText),
    targetVersion: PUZZLE_VERSION,
    outdated: docVersion(mainText) < PUZZLE_VERSION,
    migrations: pendingMigrations(docVersion(mainText)).map((step) => step.label),
    files,
    totalChanges: files.reduce((sum, item) => sum + item.changes.length, 0),
    writable: touched.map((item) => item.name),
  }
}

/**
 * 重建一个项目的文档：默认**只报计划**，`apply:true` 才落盘。
 *
 * 为什么默认 dry-run：重建是破坏性的（重写 front-matter、补小节）。
 * 本项目**不自动备份**（工作区通常已在 git 里），所以预览这一道就是唯一的刹车。
 */
export function rebuildProject(projectRoot, projectName, apply = false) {
  const plan = planRebuild(projectRoot, projectName)
  if (plan.ok !== true) return plan
  if (apply !== true) return { ...plan, applied: false }

  const written = []
  const failed = []
  for (const item of plan.files) {
    if (item.changes.length === 0 || typeof item.text !== "string") continue
    try {
      atomicWrite(item.file, item.text)
      written.push(item.name)
    } catch (error) {
      failed.push(item.name + "：" + String(error && error.message ? error.message : error))
    }
  }
  return { ...plan, applied: true, written, failed }
}

/* --------------------------------- 模板 --------------------------------- */

/**
 * 主文档模板：**只有四节**（模块索引 / 源码索引 / 工具索引 / 坑）。
 *
 * 条目格式固定为「一句话（源码: 文件[:行]）」——查找方向是 主文档 → 源码，
 * 所以每条都得能回查。字数上限见 `ENTRY_LIMITS`（写入时校验，超了报错）。
 */
export function mainTemplate(project, modules, goal, mode = DEFAULT_MODE, sessions = []) {
  const lines = [
    formatFrontMatter({ project, mode, modules, sessions, updated: timestamp() }),
    `# ${project} · 主文档`,
    '',
    ...PREAMBLE_LINES,
  ]
  if (typeof goal === 'string' && goal.trim() !== '') lines.push('', `> 目标：${goal.trim().replace(/\n+/g, ' ')}`)
  lines.push('', SECTION_HEADINGS.index)
  if (modules.length === 0) lines.push('- （尚未拆分模块）')
  for (const module of modules) lines.push(`- 模块：${module} —— （一句话职责，${ENTRY_LIMITS.index} 字内） —— 模块/${module}.md`)
  for (const key of ['source', 'tools', 'pit']) lines.push('', SECTION_HEADINGS[key], '- （待补）')
  return `${lines.join('\n')}\n`
}

/**
 * 模块文档模板：`## 悬而未决` 与 `## 已定` 是两个独立小节（**不用勾选框**）。
 *
 * 悬而未决 ≤4 条、已定 ≤10 条，超限时写入会自动删最旧的（见 `ENTRY_CAPS`）。
 */
export function moduleTemplate(module) {
  return [
    formatFrontMatter({ project: module, module, updated: timestamp() }),
    `# ${module}`,
    '',
    HEALTH_HEADING,
    healthTemplateLines(),
    '- （五维都是 0-100、**越高越好**；留空则由文档内容推导，想覆盖就填数字）',
    '',
    MODULE_SECTION_HEADINGS.progress,
    '完成度: 0',
    '',
    MODULE_SECTION_HEADINGS.points,
    `- （该模块的关键结论；一句话 ${ENTRY_LIMITS.points} 字内 + 源码: 文件:行）`,
    '',
    MODULE_SECTION_HEADINGS.pending,
    `- （还没定的，最多 ${ENTRY_CAPS.pending} 条，超了删最旧；一句话 + 源码出处）`,
    '',
    MODULE_SECTION_HEADINGS.decided,
    `- （已定的，最多 ${ENTRY_CAPS.decided} 条，超了删最旧；一句话 + 源码出处）`,
    '',
    MODULE_SECTION_HEADINGS.detail,
    `- （轮汇报：一条一句话 ${ENTRY_LIMITS.detail} 字内 + 源码: 文件:行）`,
    '',
  ].join('\n')
}

/* --------------------------------- 路径与落盘 --------------------------------- */

/** 把相对路径拼到 root 下，并确认结果没有逃出 root。 */
export function safeJoin(root, ...parts) {
  const target = resolve(root, ...parts)
  const base = resolve(root)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

/** 解析项目根下的 拼图/ 目录；不在项目根内则返回 null。 */
export function puzzleDirOf(projectRoot, projectName) {
  if (typeof projectRoot !== 'string' || projectRoot === '') return null
  const slug = slugify(projectName)
  if (slug === null) return null
  return safeJoin(projectRoot, slug, PUZZLE_DIR)
}

/**
 * 目标路径是不是「拼图文档」（`.../拼图/...`）。
 *
 * 用于**文档锁**：`write` / `edit` / `str_replace_editor` 只要落在这里就被拒，
 * 任何模式都一样——拼图文档只能走 `puzzle_mode`（它带 slug 过滤与路径守卫）。
 * 判断只看路径段，不要求文件已存在（新建也算），所以按 `/拼图/` 或结尾 `拼图` 认。
 */
export function isPuzzleDocPath(target) {
  if (typeof target !== 'string' || target.trim() === '') return false
  const normalized = target.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized === PUZZLE_DIR || normalized.endsWith('/' + PUZZLE_DIR) || normalized.includes('/' + PUZZLE_DIR + '/')
}

/** 会**改动**文档的工具及其路径参数名；`str_replace_editor` 的 `view` 是只读，不在列。 */
export const DOC_MUTATING_TOOLS = {
  write: { pathField: 'file_path' },
  edit: { pathField: 'file_path' },
  str_replace_editor: { pathField: 'path', mutatingCommands: ['create', 'str_replace', 'insert'] },
}

/**
 * 从一次工具调用里取出「它要改的文件路径」；不是会改文档的调用就返回 null。
 *
 * 纯函数、不抛错：拿不到 arguments 或字段就当作与文档锁无关（放行）。
 */
export function docMutationTarget(toolName, args) {
  const spec = DOC_MUTATING_TOOLS[toolName]
  if (spec === undefined) return null
  const input = args !== null && typeof args === 'object' ? args : {}
  if (Array.isArray(spec.mutatingCommands)) {
    const command = typeof input.command === 'string' ? input.command : ''
    if (!spec.mutatingCommands.includes(command)) return null
  }
  const value = input[spec.pathField]
  return typeof value === 'string' && value !== '' ? value : null
}

/** 扫出项目根下所有已有拼图项目（按修改时间倒序）。 */
export function listProjects(projectRoot) {
  const found = []
  for (const entry of listFiles(projectRoot)) {
    const main = join(projectRoot, entry, PUZZLE_DIR, MAIN_FILE)
    if (!isFile(main)) continue
    let mtimeMs = 0
    try {
      mtimeMs = statSync(main).mtimeMs
    } catch (_error) {
      mtimeMs = 0
    }
    found.push({ name: entry, dir: join(projectRoot, entry, PUZZLE_DIR), mainDoc: main, mtimeMs })
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found
}

/**
 * 列出项目根下每个拼图项目的摘要（供 `op:'list'` 用）。
 *
 * 存在的意义：`op:'read'` 不给 `project` 时只能取「最新」那个，多项目工作区里
 * 模型看不出自己选错了。有了这个 op，模型可以先列出来再显式指定。
 */
export function projectSummaries(projectRoot) {
  return listProjects(projectRoot).map((entry) => {
    const state = readState(projectRoot, entry.name)
    return {
      name: entry.name,
      project: state.project,
      mode: state.mode,
      health: state.health,
      dimensions: state.dimensions,
      moduleCount: state.modules.length,
      builtModuleCount: state.modules.filter((module) => module.exists).length,
      updated: state.updated ?? null,
      updatedAt: new Date(entry.mtimeMs).toISOString(),
      degraded: state.degraded === true,
    }
  })
}

/** 原子写：先写同目录临时文件再 rename，避免读到半截文档。 */
export function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (_error) {
    return null
  }
}

/* --------------------------------- 计数 --------------------------------- */

/**
 * 模板自带的说明性占位行——**只认这几种固定说法**。
 *
 * 早先的实现把「整行就是一对括号」一律当占位，于是用户写的
 * 「（见模块 auth-flow）」这类真内容会被误判为空、少算条数。
 */
const PLACEHOLDER_PATTERNS = [
  /^（?待补）?$/,
  /^[（(][^）)]*待补[^）)]*[）)]$/,
  /^[（(][^）)]*(尚未拆分模块)[^）)]*[）)]$/,
  /^[（(][^）)]*(一句话职责)[^）)]*[）)]$/,
  /^[（(][^）)]*(该模块的关键结论|只留事实)[^）)]*[）)]$/,
  /^[（(][^）)]*(细化记录|主文档只留一行索引)[^）)]*[）)]$/,
  /^[（(][^）)]*五维都是[^）)]*[）)]$/,
  // v3 模板的说明行。**必须整行是括号**才认占位——真实的条目形如
  // `- 主文档改为轮汇报条目（源码: …）`，它不以括号开头，所以不会被误判成占位。
  // （早先「整行是一对括号就当占位」的写法把「（见模块 auth-flow）」这类真内容吃掉了。）
  /^[（(][^）)]*(最多 \d+ 条)[^）)]*[）)]$/,
  /^[（(][^）)]*轮汇报[：:][^）)]*[）)]$/,
]

/** 剔掉空行与模板占位行。同时剥掉列表符与勾选框，好让 `- [ ] （待补）` 也认得出是占位。 */
function nonEmptyLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, '').replace(/^\[[ xX]\]\s*/, '').trim())
    .filter((line) => line !== '' && !PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(line)))
}

function countItems(text) {
  return nonEmptyLines(text).length
}

/* ------------------------------- 条目规整与限长 ------------------------------- */

/**
 * 把一段正文拆成条目行（保留 `- ` 前缀，供回写用）。
 *
 * 与 `nonEmptyLines` 的区别：这里**保留原始行**，因为限长与截断要按行回写，
 * 不能只拿剥掉标记的文本。空行与模板占位行仍然剔除。
 */
function entryLines(text) {
  const out = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    const bare = trimmed.replace(/^\s*[-*]\s*/, '').replace(/^\[[ xX]\]\s*/, '').trim()
    if (bare === '' || PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(bare))) continue
    // 勾选框一律去掉：v3 用 `## 悬而未决` / `## 已定` 两个小节区分，不再用 `[ ]`。
    out.push('- ' + bare)
  }
  return out
}

/** 条目正文里「源码出处」之前的那部分——限长只算它，出处不占额度。 */
export function entryBody(line) {
  const bare = String(line ?? '').trim().replace(/^\s*[-*]\s*/, '').trim()
  const at = bare.indexOf(SOURCE_MARK)
  return at < 0 ? bare : bare.slice(0, at).trim()
}

/** 字数：按 Unicode 码点算，一个汉字算 1。 */
export function charCount(text) {
  return [...String(text ?? '')].length
}

/**
 * 校验一条条目：限长 +（可选）必须带源码出处。
 *
 * 返回 `{ ok:true }` 或 `{ ok:false, error, hint }`。**不截断**——
 * 半句话落进文档比报错更糟，模型收到错误后会自己重写。
 *
 * `requireSource` 只在「这条指向源码」时才为真：模块索引指向的是模块文档
 * （`模块/X.md` 本身就是回查路径），所以只限长、不要求 `（源码: …）`。
 */
export function checkEntry(line, limit, requireSource = true) {
  const bare = String(line ?? '').trim().replace(/^\s*[-*]\s*/, '').trim()
  if (bare === '') return { ok: false, error: '空条目', hint: '一条一句话，不要写空行' }
  const body = entryBody(bare)
  if (body === '') return { ok: false, error: '条目只有源码出处、没有正文', hint: '先写一句话，再在末尾加「' + SOURCE_MARK + ': 文件:行）」' }
  const count = charCount(body)
  if (count > limit) {
    return {
      ok: false,
      error: `条目 ${count} 字，超过上限 ${limit} 字`,
      hint: `精简到 ${limit} 字以内（只算「${SOURCE_MARK}…」之前的那句话；出处不占额度）：${body}`,
    }
  }
  if (requireSource && !bare.includes(SOURCE_MARK)) {
    return {
      ok: false,
      error: '条目缺少源码出处',
      hint: `每条都要能回查源码，末尾加「${SOURCE_MARK}: lib/xxx.js:123）」。查找方向固定为 主文档 → 源码。`,
    }
  }
  return { ok: true, body, count }
}

/**
 * 把要写入的条目规整成最终文本：逐条校验 + 按上限**删最旧**。
 *
 * `cap` 是条数上限（悬而未决 4 / 已定 10）；旧条目在前、新条目在后，
 * 超限保留末尾 `cap` 条。返回 `dropped` 让调用方如实回报删了几条。
 */
export function normalizeEntries(content, limit, cap, requireSource = true) {
  const incoming = entryLines(content)
  for (const line of incoming) {
    const checked = checkEntry(line, limit, requireSource)
    if (checked.ok !== true) return { ok: false, error: checked.error, hint: checked.hint }
  }
  const dropped = cap !== undefined && incoming.length > cap ? incoming.slice(0, incoming.length - cap) : []
  const kept = dropped.length > 0 ? incoming.slice(incoming.length - cap) : incoming
  return { ok: true, text: kept.join('\n'), dropped, kept: kept.length, incoming: incoming.length }
}

/**
 * 扫一份文档正文里**不合规的条目**，按小节汇总。
 *
 * 为什么要有它：`ENTRY_LIMITS` / 源码出处只在**写入时**拦，老文档里已经存在的
 * 长条目与无出处条目不会被追溯。审查如果不看这些，就会说「要点 15 条，很充实」，
 * 而实际上 15 条全都超过 20 字、全都没有出处——数字漂亮，规格全破。
 *
 * `spec` 是「小节 key → {heading, limit, requireSource}」；主文档与模块文档各传一份。
 */
export function entryIssuesIn(body, spec) {
  const out = []
  for (const [key, entry] of Object.entries(spec)) {
    let tooLong = 0
    let noSource = 0
    let sample = ''
    for (const line of entryLines(getSection(body, entry.heading) ?? '')) {
      const checked = checkEntry(line, entry.limit, entry.requireSource !== false)
      if (checked.ok === true) continue
      if (checked.error.includes('超过上限')) tooLong += 1
      else if (checked.error.includes('缺少源码出处')) noSource += 1
      else continue
      if (sample === '') sample = entryBody(line).slice(0, 24)
    }
    if (tooLong === 0 && noSource === 0) continue
    out.push({ key, heading: entry.heading, limit: entry.limit, tooLong, noSource, sample })
  }
  return out
}

/** 主文档四节的条目规格（模块索引指向模块文档，不强制源码出处）。 */
const MAIN_ENTRY_SPEC = Object.fromEntries(SECTION_ORDER.map((key) => [key, {
  heading: SECTION_HEADINGS[key],
  limit: ENTRY_LIMITS[key],
  requireSource: key !== 'index',
}]))

/** 模块文档四个条目式小节的规格。 */
const MODULE_ENTRY_SPEC = Object.fromEntries(['points', 'pending', 'decided', 'detail'].map((key) => [key, {
  heading: MODULE_SECTION_HEADINGS[key],
  limit: ENTRY_LIMITS[key],
  requireSource: true,
}]))

/* --------------------------------- 源码工程化 --------------------------------- */

/**
 * 源码体检：**客观测出**「这个项目的代码有没有在变成屎山」。
 *
 * 为什么需要它（用户原话：模型不经约束很容易把源码写成屎山，文件少又长，
 * 导致可拓展性差、维护困难，甚至加大模型自己的施工难度）：
 * 文档写得再整齐，代码本身如果是一坨，五维里的「可拓展性 / 可维护性」就是假的。
 * 所以这里只看**可测量的东西**，不看文笔：
 *   - 文件数与规模分布（有没有「一个文件塞下整个项目」）；
 *   - 单文件最大行数、超过阈值的大文件；
 *   - 最长函数（用缩进/括号配对粗略估算，不引依赖）；
 *   - 模块化程度（顶层导出数、是否只有一个巨型文件）；
 *   - 命名与分层痕迹（是否有 src/ lib/ 之类的目录分层）。
 *
 * 阈值是**经验值**，不是真理：超过就报事实 + 给可执行的下一步，由模型/人决定怎么拆。
 */
export const SOURCE_RULES = {
  /** 单文件行数上限：超过就该考虑拆。800 行是「明显偏大」，2000 行是「必须拆」。 */
  fileLinesWarn: 800,
  fileLinesFail: 2000,
  /** 单函数行数上限：超过就难读、难测、难改。 */
  functionLinesWarn: 60,
  functionLinesFail: 150,
  /** 一个目录里源码文件少于这个数，且总行数很大 → 是「一个文件装下整个项目」。 */
  fewFilesMax: 3,
  /** 源码总行数超过这个值才谈「工程化」（小脚本不必套这套）。 */
  totalLinesMin: 400,
}

/** 这些目录不算「项目源码」：依赖、产物、版本库、文档目录。 */
const SOURCE_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.cache',
  '.next', 'vendor', 'target', 'tmp', '.tmp', PUZZLE_DIR, '拼图',
])

/** 算作源码的后缀。 */
const SOURCE_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.sh']

function isSourceFile(name) {
  const lower = String(name).toLowerCase()
  return SOURCE_EXTS.some((ext) => lower.endsWith(ext))
}

function countLines(text) {
  if (typeof text !== 'string' || text === '') return 0
  return text.split(/\r?\n/).length
}

/**
 * 递归收集源码文件（限深度，避免钻进深层依赖）。
 *
 * 只读不写；任何读不了的目录直接跳过（不抛错）——审查不该因为一个坏软链就整个失败。
 */
export function collectSourceFiles(root, maxDepth = 6) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    for (const entry of listFiles(dir)) {
      if (entry.startsWith('.') && entry !== '.github') continue
      if (SOURCE_SKIP_DIRS.has(entry)) continue
      const full = join(dir, entry)
      let stat
      try {
        stat = statSync(full)
      } catch (_error) {
        continue
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!stat.isFile() || !isSourceFile(entry)) continue
      const text = readText(full)
      if (text === null) continue
      out.push({ file: full, name: entry, lines: countLines(text), text })
    }
  }
  walk(root, 0)
  return out
}

/**
 * 粗估最长函数：按「行首缩进 + 上一行以 `{`/`=>` 结尾」起算，遇到同级或更浅的 `}` 收尾。
 *
 * 这是**启发式**，不是语法分析（不引依赖）。它对「一坨几百行的大函数」足够敏感，
 * 对回调嵌套会高估——所以只用来报警，不用来卡人。
 */
export function longestFunction(lines) {
  let best = { lines: 0, at: 0 }
  let start = -1
  let startIndent = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()
    // 函数起点：以 `{` 结尾，或箭头函数体，或 `function` 开头。
    const opensBlock = /[{(]\s*$/.test(trimmed) || /=>\s*$/.test(trimmed) || /^\s*(export\s+)?(async\s+)?function\b/.test(line)
    if (start < 0 && opensBlock) {
      start = i
      startIndent = indent
      continue
    }
    // 收尾：回到不深于起点的 `}`（或 `})` 等）。
    if (start >= 0 && indent <= startIndent && /^[}\]);,]+$/.test(trimmed)) {
      const size = i - start + 1
      if (size > best.lines) best = { lines: size, at: start + 1 }
      start = -1
    }
  }
  return best
}

/**
 * 体检一个项目的源码工程化程度。**只读**，返回可量化的客观事实。
 *
 * `sourceRoot` 优先级：显式参数 > 主文档 front-matter 的 `源码根:` > 拼图目录的上一级。
 *
 * 为什么要三级：**文档目录与源码目录常常不是同一处**。本项目实测：文档在
 * `/sdcard/dsha222/拼图模式插件/拼图/`，源码在 `/root/.dsh/plugin-src/dsh-puzzle-mode/`。
 * 找不到源码时**如实说「没查到」**，而不是把 0 个文件当成「代码很干净」。
 */
export function inspectSource(projectRoot, projectName, sourceRoot = '') {
  const projectDir = puzzleDirOf(projectRoot, projectName)
  if (projectDir === null) return { ok: false, error: '项目名不合法' }
  let recorded = ''
  try {
    const mainDoc = join(projectDir, MAIN_FILE)
    if (isFile(mainDoc)) recorded = parseSourceRoot(parseFrontMatter(readText(mainDoc) ?? '').fields)
  } catch (_error) {
    recorded = ''
  }
  const explicit = typeof sourceRoot === 'string' ? sourceRoot.trim() : ''
  const base = resolve(explicit !== '' ? explicit : (recorded !== '' ? recorded : resolve(projectDir, '..')))
  let baseOk = false
  try {
    baseOk = statSync(base).isDirectory()
  } catch (_error) {
    baseOk = false
  }
  if (!baseOk) {
    return {
      ok: false,
      base,
      error: '源码目录不存在或读不了：' + base,
      hint: '把源码根记进主文档（op:source 带 path），或调用时显式给 sourceRoot。',
    }
  }
  const files = collectSourceFiles(base)
  if (files.length === 0) {
    return {
      ok: true,
      base,
      fileCount: 0,
      totalLines: 0,
      files: [],
      largest: null,
      oversized: [],
      longestFunction: null,
      dirs: [],
      findings: [],
      note: '在 ' + base + ' 下没有找到源码文件。**这不代表代码没问题，只代表没查到**——'
        + '源码若在别处，请用 op:audit 的 sourceRoot 参数指过去。',
    }
  }

  const totalLines = files.reduce((sum, item) => sum + item.lines, 0)
  const sorted = files.slice().sort((left, right) => right.lines - left.lines)
  const oversized = files
    .filter((item) => item.lines >= SOURCE_RULES.fileLinesWarn)
    .map((item) => ({ file: item.file, name: item.name, lines: item.lines }))
    .sort((left, right) => right.lines - left.lines)

  // 目录分层：看源码落在几个不同目录里。
  const dirSet = new Set(files.map((item) => {
    const rel = item.file.slice(base.length + 1)
    const at = rel.lastIndexOf(sep)
    return at < 0 ? '.' : rel.slice(0, at)
  }))
  const dirs = [...dirSet].sort()

  // 最长函数：只对最大的那个文件算（大文件里才最可能藏着巨函数）。
  const biggest = sorted[0]
  const fn = longestFunction(biggest.text.split(/\r?\n/))

  const findings = []
  // 规则一：单文件过大。
  for (const item of oversized) {
    const level = item.lines >= SOURCE_RULES.fileLinesFail ? 'fail' : 'warn'
    findings.push({
      id: 'source_big_file',
      level,
      fact: item.name + ' 有 ' + item.lines + ' 行（阈值 ' + SOURCE_RULES.fileLinesWarn + ' 行' + (level === 'fail' ? '，硬上限 ' + SOURCE_RULES.fileLinesFail : '') + '）。',
      fix: '按职责拆成多个文件：一个文件只做一件事。先拆出纯逻辑（无 IO）、再拆出 IO、最后留薄薄一层入口。',
    })
  }
  // 规则二：一个文件装下整个项目。
  if (files.length <= SOURCE_RULES.fewFilesMax && totalLines >= SOURCE_RULES.totalLinesMin) {
    findings.push({
      id: 'source_too_few_files',
      level: 'fail',
      fact: '整个项目只有 ' + files.length + ' 个源码文件，却共 ' + totalLines + ' 行（' + dirs.length + ' 个目录）。',
      fix: '这是「一个文件装下整个项目」的形态：模型改任何一处都要先读完整文件，施工难度与出错率都会陡增。先按职责切成 4-8 个文件。',
    })
  }
  // 规则三：巨函数。
  if (fn.lines >= SOURCE_RULES.functionLinesWarn) {
    findings.push({
      id: 'source_long_function',
      level: fn.lines >= SOURCE_RULES.functionLinesFail ? 'fail' : 'warn',
      fact: biggest.name + ' 第 ' + fn.at + ' 行起有一个约 ' + fn.lines + ' 行的函数（阈值 ' + SOURCE_RULES.functionLinesWarn + ' 行）。',
      fix: '把函数体按步骤拆成几个小函数，每步一个名字——名字就是文档，也是可测试点。',
    })
  }
  // 规则四：没有目录分层。
  if (files.length >= 6 && dirs.length === 1) {
    findings.push({
      id: 'source_flat',
      level: 'warn',
      fact: files.length + ' 个源码文件全在同一层目录（' + dirs[0] + '）。',
      fix: '按角色分目录（如 lib/ 纯逻辑、bin/ 入口、test/ 测试），让「东西该放哪」有答案。',
    })
  }

  return {
    ok: true,
    base,
    fileCount: files.length,
    totalLines,
    files: sorted.map((item) => ({ name: item.name, lines: item.lines })),
    largest: { name: biggest.name, lines: biggest.lines },
    oversized,
    longestFunction: { file: biggest.name, at: fn.at, lines: fn.lines },
    dirs,
    avgLines: Math.round(totalLines / files.length),
    findings,
  }
}

/* --------------------------------- 五维真实性 --------------------------------- */

/**
 * 五维「真实值」的评估：**由证据算，不由模型声明**。
 *
 * 为什么需要它（用户原话：模型只会在任务完成后提高值，可这是虚假的，
 * 因为他并不清楚自己写出的代码好坏）：
 * `## 健康性` 里手写的分数是**自评**——模型刚写完代码，天然觉得自己写得好，
 * 于是把分数调高。而「可拓展性」「可维护性」这种维度，恰恰是**代码本身**才能回答的。
 *
 * 所以这里做两件事：
 *   1. 用**文档证据 + 源码体检**算出每一维的真实值（`evidenceScore`）；
 *   2. 与手写值比对，差得离谱就报「虚高」（`inflation`），并给出真实值让模型改。
 *
 * 关键设计：**只有能测的才计入**。没有源码就不硬编一个分，而是标注 `unmeasured`——
 * 「没测」和「测出来是 0」是两回事，混在一起又会变成假数字。
 */

/** 每个维度会被哪些源码发现扣分（按 finding id 匹配，**不按文案匹配**）。 */
const SOURCE_HITS = {
  extensibility: ['source_big_file', 'source_too_few_files', 'source_flat'],
  maintenance: ['source_long_function', 'source_big_file'],
  quality: ['source_big_file', 'source_too_few_files', 'source_long_function', 'source_flat'],
  // 任务复杂度与可复用性不由源码体检扣分：前者是中性事实，后者要看有没有抽公共件，
  // 靠行数判断不了。宁可少扣，也不编一个说不清理由的分。
  complexity: [],
  reusability: [],
}

/** 源码体检结果 → 对五维的修正（文案给人看）。 */
export function sourceVerdicts(inspection) {
  const out = {}
  for (const key of HEALTH_KEYS) out[key] = []
  if (inspection === null || inspection === undefined || inspection.ok !== true) return out
  for (const item of (inspection.findings ?? [])) {
    for (const key of HEALTH_KEYS) {
      if (!(SOURCE_HITS[key] ?? []).includes(item.id)) continue
      out[key].push(item.fact)
    }
  }
  return out
}

/**
 * 由「文档证据 + 源码体检」算出五维真实值（0-100）。
 *
 * 与 `HEALTH_DIMENSIONS[].derive` 的区别：`derive` 只看文档条数（要点/详细记录/决策/坑），
 * 回答的是「文档写全了没有」；这里额外把**源码体检**算进来，回答的是
 * 「代码本身撑不撑得住这个分数」。两者都算，取**较低**的那个——
 * 文档写得漂亮但代码是一坨，真实值就该被代码拖下来。
 */
export function trueHealthOf({ evidence = {}, inspection = null, declared = {}, hasSource = false }) {
  const scores = {}
  const reasons = {}
  const verdictsByDim = sourceVerdicts(inspection)
  for (const dimension of HEALTH_DIMENSIONS) {
    const fromDoc = dimension.derive(evidence)
    const hitIds = SOURCE_HITS[dimension.key] ?? []
    // 源码有硬伤就按条扣：每条 fail 扣 25、warn 扣 10，扣到底 0。
    let penalty = 0
    const verdicts = []
    for (const item of (inspection?.findings ?? [])) {
      if (!hitIds.includes(item.id)) continue
      penalty += item.level === 'fail' ? 25 : 10
      verdicts.push(item.fact)
    }
    const fromSource = hasSource ? clampPercent(100 - penalty) : null
    // 取较低值：文档与源码任一说不行，就不给高分。
    const value = fromSource === null ? fromDoc : Math.min(fromDoc, fromSource)
    scores[dimension.key] = value
    reasons[dimension.key] = {
      fromDoc,
      fromSource,
      verdicts,
      note: fromSource === null
        ? '没有源码可查，这一维只由文档证据推出——**不是实测值**。'
        : (fromSource < fromDoc ? '源码比文档差，取源码那一侧。' : '文档与源码一致，或文档那一侧更严。'),
    }
    // 手写值明显高于真实值 → 虚高。
    const declaredValue = declared[dimension.key]
    if (typeof declaredValue === 'number' && declaredValue - value >= 15) {
      reasons[dimension.key].inflation = {
        declared: declaredValue,
        trueValue: value,
        gap: declaredValue - value,
      }
    }
  }
  return { scores, reasons, health: average(HEALTH_KEYS.map((key) => scores[key])), verdicts: verdictsByDim }
}

/* --------------------------------- 状态读取 --------------------------------- */

function moduleEntries(puzzleDir, modules, projectText) {
  return modules.map((name) => {
    const file = join(puzzleDir, MODULE_DIR, `${name}.md`)
    const text = isFile(file) ? readText(file) : null
    const health = text === null
      ? { scores: Object.fromEntries(HEALTH_KEYS.map((key) => [key, 0])), sources: {}, evidence: {}, health: 0 }
      : healthOf(text, projectText)
    const body = text === null ? '' : parseFrontMatter(text).body
    const progress = text === null ? null : getSection(body, MODULE_SECTION_HEADINGS.progress)
    const progressMatch = progress === null ? null : /完成度\s*[:：]\s*(\d{1,3})/.exec(progress)
    return {
      name,
      file,
      exists: text !== null,
      health: health.health,
      healthScores: health.scores,
      healthSources: health.sources,
      evidence: health.evidence,
      progress: progressMatch === null ? null : clampPercent(Number(progressMatch[1])),
      // 不合规条目（超长 / 无出处）：审查据此点名，而不是只看条数。
      entryIssues: text === null ? [] : entryIssuesIn(body, MODULE_ENTRY_SPEC),
      // 计数直接来自 health 的证据：悬而未决 / 已定是独立小节，不再按勾选框过滤。
      counts: {
        points: health.evidence.points ?? 0,
        pending: health.evidence.pending ?? 0,
        decided: health.evidence.decided ?? 0,
      },
    }
  })
}

/**
 * 读一个项目的最新状态。**从不抛错、从不写盘**：
 * 目录不存在 → initialized:false；主文档坏 → 记 degraded 并继续尽力解析。
 */
export function readState(projectRoot, projectName) {
  const slug = typeof projectName === 'string' ? slugify(projectName) : null
  const puzzleDir = slug === null ? null : puzzleDirOf(projectRoot, slug)
  const mainDoc = puzzleDir === null ? null : join(puzzleDir, MAIN_FILE)
  const base = {
    initialized: false,
    degraded: false,
    projectRoot: typeof projectRoot === 'string' ? projectRoot : '',
    project: slug ?? '',
    puzzleDir: puzzleDir ?? '',
    mainDoc: mainDoc ?? '',
    mode: DEFAULT_MODE,
    modeSource: 'default',
    modules: [],
    dimensions: Object.fromEntries(HEALTH_KEYS.map((key) => [key, 0])),
    health: 0,
    sections: {},
    findings: [],
    planned: [],
    sessions: [],
    /** 文档格式版本；base 里给当前值，未初始化就没有「旧格式」可言。 */
    version: PUZZLE_VERSION,
    outdated: false,
    error: null,
  }
  if (mainDoc === null || !isFile(mainDoc)) return base

  const text = readText(mainDoc)
  if (text === null) return { ...base, error: '主文档存在但读不出来' }

  const { fields, body } = parseFrontMatter(text)
  let planned = []
  const rawModules = fields['计划模块']
  if (typeof rawModules === 'string' && rawModules.trim() !== '') {
    try {
      const parsed = JSON.parse(rawModules)
      if (Array.isArray(parsed)) planned = parsed.filter((item) => typeof item === 'string')
    } catch (_error) {
      base.degraded = true
    }
  }
  if (planned.length === 0) {
    for (const entry of listFiles(join(puzzleDir, MODULE_DIR))) {
      if (entry.endsWith('.md')) planned.push(entry.slice(0, -3))
    }
  }
  planned = [...new Set(planned.map((item) => slugify(item)).filter((item) => item !== null))]

  const modules = moduleEntries(puzzleDir, planned, text)
  const declaredMode = MODES.includes(fields['模式']) ? fields['模式'] : null
  const dimensions = dimensionAverages(modules)

  const state = {
    ...base,
    initialized: true,
    degraded: base.degraded,
    project: typeof fields['项目'] === 'string' && fields['项目'].trim() !== '' ? fields['项目'].trim() : slug,
    mode: declaredMode ?? DEFAULT_MODE,
    modeSource: declaredMode === null ? 'default' : 'front-matter',
    updated: fields['更新时间'] ?? null,
    modules,
    dimensions,
    health: projectHealthOf(modules),
    sections: sectionCounts(body),
    planned,
    sessions: parseSessionList(fields),
    /** 源码根（front-matter 的 `源码根:`）；空串表示按默认规则找。 */
    sourceRoot: parseSourceRoot(fields),
    version: docVersion(text),
    outdated: docVersion(text) < PUZZLE_VERSION,
    /** 主文档四节里不合规的条目（超长 / 无出处），供审查点名。 */
    mainEntryIssues: entryIssuesIn(body, MAIN_ENTRY_SPEC),
    goal: (body.split(/\r?\n/).find((line) => line.startsWith('> 目标：')) ?? '').replace(/^>\s*目标：/, '').trim(),
  }
  // 审查发现要同时看模块证据与主文档小节，所以在状态装配完成后再算。
  state.findings = auditOf(state)
  return state
}

/**
 * 读某个模块文档的正文小节（供 UI 点开图块看详情，以及模型按需回读）。
 * 文件不存在时返回 exists:false，不抛错、不建文件。
 */
export function readModuleDetail(projectRoot, projectName, moduleName) {
  const slug = slugify(moduleName)
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (slug === null) return { ok: false, error: '模块名不合法' }
  if (puzzleDir === null) return { ok: false, error: '项目名不合法' }
  const file = safeJoin(puzzleDir, MODULE_DIR, `${slug}.md`)
  if (file === null) return { ok: false, error: '模块路径越界' }

  const mainDoc = join(puzzleDir, MAIN_FILE)
  const projectText = isFile(mainDoc) ? readText(mainDoc) : null
  if (!isFile(file)) {
    return {
      ok: true,
      name: slug,
      exists: false,
      file,
      health: 0,
      dimensions: Object.fromEntries(HEALTH_KEYS.map((key) => [key, 0])),
      points: null,
      pending: null,
      decided: null,
      detail: null,
    }
  }
  const text = readText(file)
  if (text === null) return { ok: false, error: '模块文档读不出来' }
  const { body } = parseFrontMatter(text)
  const health = healthOf(text, projectText)
  return {
    ok: true,
    name: slug,
    exists: true,
    file,
    health: health.health,
    dimensions: health.scores,
    sources: health.sources,
    points: (getSection(body, MODULE_SECTION_HEADINGS.points) ?? '').trim(),
    pending: (getSection(body, MODULE_SECTION_HEADINGS.pending) ?? '').trim(),
    decided: (getSection(body, MODULE_SECTION_HEADINGS.decided) ?? '').trim(),
    detail: (getSection(body, MODULE_SECTION_HEADINGS.detail) ?? '').trim(),
  }
}

/* --------------------------------- 写入 --------------------------------- */

/** 从 front-matter 里安全读出模块清单（坏 JSON 当空数组）。 */
function safePlanned(fields) {
  try {
    const parsed = JSON.parse(fields['计划模块'] ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => slugify(item)).filter((item) => item !== null)
  } catch (_error) {
    return []
  }
}

/** 只改主文档的行为字段（模式 / 模块清单），保留其余内容。 */
export function setMainFields(text, patch) {
  const { fields, body } = parseFrontMatter(text)
  const next = {
    puzzle: fields.puzzle ?? 1,
    project: patch.project ?? fields['项目'] ?? '',
    mode: patch.mode ?? fields['模式'] ?? DEFAULT_MODE,
    modules: patch.modules ?? safePlanned(fields),
    // 绑定必须透传：这两个函数会整份重写 front-matter，漏一次就把绑定丢了。
    sessions: patch.sessions ?? parseSessionList(fields),
    // 源码根同理必须透传：漏一次，审查就找不到源码（退化成「查不到」）。
    sourceRoot: patch.sourceRoot ?? parseSourceRoot(fields),
    updated: timestamp(),
  }
  if (!Array.isArray(next.modules)) next.modules = []
  if (!MODES.includes(next.mode)) next.mode = DEFAULT_MODE
  return `${formatFrontMatter(next)}\n${body.replace(/^\n+/, '')}`
}

/**
 * 会话绑定的读侧：扫项目根，返回这个会话绑定的项目名；没绑定返回 null。
 *
 * **只认 front-matter，不猜**：找不到就是 null。早先「回退到最新项目」正是文档混成一团的根因。
 */
export function boundProject(projectRoot, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return null
  for (const entry of listProjects(projectRoot)) {
    const text = readText(entry.mainDoc)
    if (text === null) continue
    if (parseSessionList(parseFrontMatter(text).fields).includes(sessionId)) return entry.name
  }
  return null
}

/** 把主文档的会话列表改成给定的一份（其余 front-matter 字段原样保留）。 */
function writeSessionList(mainDoc, text, sessions) {
  try {
    const { fields, body } = parseFrontMatter(text)
    const next = [
      formatFrontMatter({
        puzzle: fields.puzzle ?? 1,
        project: fields["项目"] ?? "",
        mode: MODES.includes(fields["模式"]) ? fields["模式"] : DEFAULT_MODE,
        modules: safePlanned(fields),
        sessions: normalizeSessions(sessions),
        sourceRoot: parseSourceRoot(fields),
        updated: timestamp(),
      }),
      body.replace(/^\n+/, ""),
    ].join("\n")
    atomicWrite(mainDoc, next)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
}

/**
 * 解绑一个会话：把它从**所有**项目的 `会话:` 数组里摘掉，让本会话回到「没绑定」。
 *
 * 为什么扫全量而不是只改「当前绑定的那个」：绑定是文档里的一行文本，可能因为手工编辑、
 * 或旧版本插件而被写成多处命中。解绑的语义是「这个会话不再绑任何项目」，必须扫全量。
 * 返回被摘掉的项目名列表，好让调用方如实回报。
 */
export function unbindSession(projectRoot, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") {
    return { ok: false, error: "缺少会话 ID", hint: "解绑需要一个会话 ID" }
  }
  const released = []
  for (const entry of listProjects(projectRoot)) {
    const text = readText(entry.mainDoc)
    if (text === null) continue
    const list = parseSessionList(parseFrontMatter(text).fields)
    if (!list.includes(sessionId)) continue
    const cut = writeSessionList(entry.mainDoc, text, list.filter((item) => item !== sessionId))
    if (cut.ok !== true) {
      return { ok: false, error: "解绑失败：" + entry.name, hint: cut.error }
    }
    released.push(entry.name)
  }
  return { ok: true, released }
}

/**
 * 把一个会话绑到某个项目：目标项目写进本会话，**其他项目上先解绑**。
 *
 * 「先解绑再绑定」是这条不变量的唯一执行点：一个会话只能出现在一个项目的 `会话:` 数组里。
 */
export function bindSession(projectRoot, projectName, sessionId) {
  const slug = slugify(projectName)
  if (slug === null) return { ok: false, error: "项目名不合法", hint: "检查项目名" }
  if (typeof sessionId !== "string" || sessionId === "") {
    return { ok: false, error: "缺少会话 ID", hint: "绑定需要一个会话 ID" }
  }
  const puzzleDir = puzzleDirOf(projectRoot, slug)
  if (puzzleDir === null) return { ok: false, error: "项目路径越界", hint: "检查项目名" }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: "项目尚未创建", hint: "先执行 op=init" }

  // 先把本会话从**所有**项目上摘掉（含目标项目，随后重新加上），再绑目标项目。
  // 复用 unbindSession 而不是自己写一遍循环：解绑语义只有一处实现。
  const cut = unbindSession(projectRoot, sessionId)
  if (cut.ok !== true) return { ok: false, error: cut.error, hint: cut.hint }
  const released = cut.released.filter((name) => name !== slug)

  const text = readText(mainDoc)
  if (text === null) return { ok: false, error: "主文档读不出来", hint: "检查文件权限" }
  const list = parseSessionList(parseFrontMatter(text).fields)
  if (!list.includes(sessionId)) list.push(sessionId)
  const written = writeSessionList(mainDoc, text, list)
  if (written.ok !== true) return { ok: false, error: "写入绑定失败", hint: written.error }
  return { ok: true, project: slug, mainDoc, sessions: normalizeSessions(list), released }
}

/** 建目录 + 主文档 + N 份模块文档（已存在的模块文档不覆盖）。 */
export function createProject(projectRoot, projectName, goal, modules, mode = DEFAULT_MODE, sessionId = '') {
  const slug = slugify(projectName)
  if (slug === null) return { ok: false, error: '项目名不合法', hint: '换一个不含路径符号的名字' }
  const projectDir = safeJoin(projectRoot, slug)
  if (projectDir === null) return { ok: false, error: '项目路径越界', hint: '项目名不能包含 ../' }
  const puzzleDir = join(projectDir, PUZZLE_DIR)
  const mainDoc = join(puzzleDir, MAIN_FILE)
  const names = []
  for (const raw of Array.isArray(modules) ? modules : []) {
    const name = slugify(raw)
    if (name === null) continue
    if (!names.includes(name)) names.push(name)
  }

  try {
    mkdirSync(join(puzzleDir, MODULE_DIR), { recursive: true })
    const mainCreated = !isFile(mainDoc)
    const bindTo = typeof sessionId === 'string' && sessionId !== '' ? [sessionId] : []
    if (mainCreated) atomicWrite(mainDoc, mainTemplate(slug, names, goal, mode, bindTo))
    const created = []
    for (const name of names) {
      const file = join(puzzleDir, MODULE_DIR, `${name}.md`)
      if (isFile(file)) continue
      atomicWrite(file, moduleTemplate(name))
      created.push(name)
    }
    // 主文档建好后立刻落绑定：即使后续模块创建失败，绑定关系也已经成立。
    //
    // **只在主文档是这次新建的时候才绑**：项目已经存在时再走一次 `op:init`（模型很常见：
    // 「建项目」被当成幂等的「确保存在」），无条件 `bindSession` 会把用户刚解绑的会话
    // **重新写回 `会话:` 行** —— 表现就是「解绑了过一会又自动绑定」。
    // 已有项目要改绑，走 `op:bind`（显式意图）或面板下拉。
    const shouldBind = mainCreated && bindTo.length > 0
    const bound = shouldBind ? bindSession(projectRoot, slug, bindTo[0]) : null
    return {
      ok: true,
      project: slug,
      puzzleDir,
      mainDoc,
      mainCreated,
      created,
      modules: names,
      existing: names.filter((name) => !created.includes(name)),
      // `rebound: false` 明确告诉调用方「项目已存在，这次没有动绑定」，别把它当成绑成功。
      bound: bound !== null && bound.ok === true,
      rebound: shouldBind,
      released: bound !== null && bound.ok === true ? bound.released : [],
      bindError: bound !== null && bound.ok !== true ? bound.error : null,
    }
  } catch (error) {
    return { ok: false, error: '创建文档失败', hint: String(error && error.message ? error.message : error) }
  }
}

/**
 * 更新主文档的一个小节；index 小节同时刷新 front-matter 的模块清单。
 *
 * v3 起四节都有**字数上限**且每条必须带源码出处（`ENTRY_LIMITS`）：
 * 校验不过就整次拒绝（不截断——半句话落进文档比报错更糟）。
 * `index` 小节是模块清单，条目格式不同，只做字数校验。
 */
export function updateMainSection(projectRoot, projectName, section, content, append = true) {
  if (!SECTION_KEYS.has(section)) {
    return { ok: false, error: `未知小节 ${section}`, hint: `可用：${SECTION_ORDER.join(' / ')}（主文档只有这四节）` }
  }
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readText(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }

  // 模块索引指向的是模块文档（`模块/X.md` 就是回查路径），所以只限长、不强制 `（源码: …）`。
  const checked = normalizeEntries(content, ENTRY_LIMITS[section], undefined, section !== 'index')
  if (checked.ok !== true) return { ok: false, error: checked.error, hint: checked.hint }

  const { fields, body } = parseFrontMatter(text)
  const nextBody = applySection(body, SECTION_HEADINGS[section], checked.text, append !== false)
  let planned = null
  if (section === 'index') {
    // 模块索引里出现过的模块名，同步进 front-matter 的模块清单（UI 的图块据此建出来）。
    const names = []
    for (const line of String(content ?? '').split(/\r?\n/)) {
      const match = /模块\s*[:：]\s*([^\s—\-–]+)/.exec(line) ?? /模块\/([^\s./]+)\.md/.exec(line)
      if (match === null) continue
      const name = slugify(match[1])
      if (name !== null && !names.includes(name)) names.push(name)
    }
    planned = [...new Set([...safePlanned(fields), ...names])]
  }
  const next = [
    formatFrontMatter({
      puzzle: PUZZLE_VERSION,
      project: fields['项目'] ?? projectName,
      mode: MODES.includes(fields['模式']) ? fields['模式'] : DEFAULT_MODE,
      modules: planned ?? safePlanned(fields),
      sessions: parseSessionList(fields),
      sourceRoot: parseSourceRoot(fields),
      updated: timestamp(),
    }),
    nextBody.replace(/^\n+/, ''),
  ].join('\n')
  try {
    atomicWrite(mainDoc, next)
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, mainDoc, section, entries: checked.incoming }
}

/**
 * 更新（必要时创建）模块文档的一个小节。
 *
 * `points` / `pending` / `decided` / `detail` 都是**条目式**小节：
 * 每条限字数、必须带源码出处；`pending` ≤4、`decided` ≤10，超限**删最旧**。
 */
export function updateModuleSection(projectRoot, projectName, moduleName, section, content, append = true) {
  if (!MODULE_SECTION_KEYS.includes(section)) {
    return { ok: false, error: `未知模块小节 ${section}`, hint: `可用：${MODULE_SECTION_KEYS.join(' / ')}` }
  }
  const slug = slugify(moduleName)
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (slug === null) return { ok: false, error: '模块名不合法', hint: '换一个不含路径符号的名字' }
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const file = safeJoin(puzzleDir, MODULE_DIR, `${slug}.md`)
  if (file === null) return { ok: false, error: '模块路径越界', hint: '模块名不能包含 ../' }

  let text = isFile(file) ? readText(file) : null
  const created = text === null
  if (text === null) text = moduleTemplate(slug)

  let dropped = []
  let entries = 0
  if (section === 'progress') {
    const percent = clampPercent(Number(String(content).replace(/[^\d]/g, '')))
    text = applySection(text, MODULE_SECTION_HEADINGS.progress, `完成度: ${percent}`, false)
  } else if (section === 'health') {
    // 只接受五个已知维度名；其余行（说明文字）原样保留在正文里。
    text = applySection(text, HEALTH_HEADING, content, append !== false)
  } else {
    const checked = normalizeEntries(content, ENTRY_LIMITS[section], ENTRY_CAPS[section])
    if (checked.ok !== true) return { ok: false, error: checked.error, hint: checked.hint }
    entries = checked.incoming
    dropped = checked.dropped
    // 条数上限是**硬规则**：先按 append 合并新旧，再整体裁到末尾 N 条（最旧的先删）。
    const merged = applySection(text, MODULE_SECTION_HEADINGS[section], checked.text, append !== false)
    const cap = ENTRY_CAPS[section]
    if (cap === undefined) {
      text = merged
    } else {
      const all = entryLines(getSection(parseFrontMatter(merged).body, MODULE_SECTION_HEADINGS[section]) ?? '')
      const overflow = all.length > cap ? all.slice(0, all.length - cap) : []
      if (overflow.length > 0) {
        dropped = overflow
        text = withSection(merged, MODULE_SECTION_HEADINGS[section], all.slice(all.length - cap).join('\n'))
      } else {
        text = merged
      }
    }
  }

  try {
    mkdirSync(join(puzzleDir, MODULE_DIR), { recursive: true })
    atomicWrite(file, text)
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }

  // 模块第一次出现时，把它补进主文档 front-matter 的模块清单。
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (isFile(mainDoc)) {
    const mainText = readText(mainDoc)
    if (mainText !== null) {
      const { fields } = parseFrontMatter(mainText)
      const planned = safePlanned(fields)
      if (!planned.includes(slug)) {
        try {
          atomicWrite(mainDoc, setMainFields(mainText, { modules: [...planned, slug] }))
        } catch (_error) {
          /* 补清单失败不影响模块文档本身的写入结果 */
        }
      }
    }
  }

  return { ok: true, file, created, section, entries, dropped }
}

/**
 * 写模块文档的「健康性」小节。
 *
 * **项目级健康性不写进文档**（v3 起主文档只有四节，没有它的容身处）：
 * 项目健康性 = 各模块健康性的均值，由宿主汇总，手写只会与事实矛盾。
 */
export function updateProjectHealth() {
  return {
    ok: false,
    error: '项目级健康性不再写进文档',
    hint: '主文档只有 模块索引 / 源码索引 / 工具索引 / 坑 四节。五维请用 op:health 并给 name 写到对应模块文档，项目健康性由宿主按模块均值汇总。',
  }
}

/** 写模式（主文档 front-matter）。 */
export function setMode(projectRoot, projectName, mode) {
  if (!MODES.includes(mode)) return { ok: false, error: `未知模式 ${mode}`, hint: `可用：${MODES.join(' / ')}` }
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readText(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }
  try {
    atomicWrite(mainDoc, setMainFields(text, { mode }))
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, mode, mainDoc }
}

/**
 * 写主文档的**源码根**（front-matter 的 `源码根:`）。
 *
 * 为什么要有它：审查要做源码体检（文件行数、巨函数、目录分层），而文档目录与源码目录
 * 常常不在一处。把它记进文档，之后每次审查都知道去哪看代码，不必每次手填。
 * 传空串 = 清掉这一行（回到默认规则：拼图目录的上一级）。
 */
export function setSourceRoot(projectRoot, projectName, sourceRoot) {
  const value = typeof sourceRoot === 'string' ? sourceRoot.trim() : ''
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  // 给了路径就校验它确实存在——写进去一个不存在的路径，等于给审查埋一个「查不到」。
  if (value !== '') {
    let ok = false
    try {
      ok = statSync(value).isDirectory()
    } catch (_error) {
      ok = false
    }
    if (!ok) return { ok: false, error: '源码目录不存在或读不了：' + value, hint: '给一个存在的绝对路径' }
    const found = collectSourceFiles(value)
    if (found.length === 0) {
      return { ok: false, error: '该目录下没有源码文件：' + value, hint: '确认路径指向的是源码目录（不是只有文档或产物的目录）' }
    }
  }
  const text = readText(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }
  try {
    atomicWrite(mainDoc, setMainFields(text, { sourceRoot: value }))
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, sourceRoot: value, mainDoc }
}

/* --------------------------------- 汇总输出 --------------------------------- */

/** 每次返回都带上的固定收尾问（三处口径一致：提示段 / 工具返回 / UI 模板）。 */
function pauseFields() {
  return { askPause: true, pauseQuestion: PAUSE_QUESTION, pauseOptions: PAUSE_OPTIONS }
}

/** 五维的元信息（名字 + 方向），让模型知道每一维是什么、往哪边算好。 */
export function dimensionMeta() {
  return HEALTH_DIMENSIONS.map((dimension) => ({ key: dimension.key, name: dimension.name, hint: dimension.hint }))
}

/**
 * 工具返回给模型的最小事实集（不序列化任何宿主对象）。
 *
 * `brief: true` 是**接续会话用的精简档**：去掉每模块的五维明细与来源、去掉五维元信息表，
 * 只留「有哪些模块、各自健康性、健康性总分、下一步该读什么」。
 * 本项目实测：全量 2916 字符 → 精简档约 1000 字符（模块明细占原本的 67%）。
 * 要明细再 `op:show` 看单个模块，不必一次把六个模块的分数全塞进上下文。
 */
export function summarize(state, extra = {}, brief = false) {
  if (state.initialized !== true) {
    return {
      ok: true,
      initialized: false,
      projectRoot: state.projectRoot,
      error: state.error ?? null,
      // `project` 即使为空也要给：面板靠它区分「未绑定」与「绑定的项目名叫空」。
      project: state.project ?? '',
      hint: `本会话还没绑定拼图项目：用 op=init 并显式给 project 一次创建（目录 ${'<工作区>/<项目名>/' + PUZZLE_DIR}/），或用面板的建项目按钮`,
      dimensions: dimensionMeta(),
      findingCount: 0,
      ...pauseFields(),
      ...extra,
    }
  }
  const modules = state.modules.map((module) => (brief
    ? { name: module.name, exists: module.exists, health: module.health, progress: module.progress }
    : {
      name: module.name,
      exists: module.exists,
      health: module.health,
      dimensions: module.healthScores,
      sources: module.healthSources,
      progress: module.progress,
      counts: module.counts,
    }))
  return {
    ok: true,
    initialized: true,
    degraded: state.degraded === true,
    projectRoot: state.projectRoot,
    projectDir: state.puzzleDir,
    mainDoc: state.mainDoc,
    project: state.project,
    /** 文档格式版本与「是否旧格式」：旧格式要 op:rebuild 迁移，别当它是当前形状。 */
    version: state.version ?? PUZZLE_VERSION,
    outdated: state.outdated === true,
    mode: state.mode,
    modeSource: state.modeSource ?? 'default',
    /** 项目健康性 = 各模块五维健康性的均值。 */
    health: state.health,
    // 精简档用**中文维度名**：说明表（dimensionMeta）在精简档里被去掉了，
    // 再给英文 key 就等于给了数字不给图例。全量档保持英文 key（面板按 key 取数）。
    dimensions: brief
      ? Object.fromEntries(HEALTH_DIMENSIONS.map((dimension) => [dimension.name, (state.dimensions ?? {})[dimension.key] ?? 0]))
      : state.dimensions,
    // 五维元信息表有 372 字符，作用是给第一次接触的模型解释「每维什么意思」；
    // 接续会话的精简档不需要，省下来。
    ...(brief ? {} : { dimensionMeta: dimensionMeta() }),
    /**
     * 审查发现**不塞进这里**：`op:read` 是模型每轮都会调的，要精简。
     * 想看完整发现走 `op:audit`；面板则走 RPC 的 `state`（它自己附上）。
     * 这里只给一个数量，好让模型知道「有东西可审」。
     */
    findingCount: Array.isArray(state.findings) ? state.findings.length : 0,
    sections: state.sections ?? {},
    modules,
    updated: state.updated ?? null,
    canExecute: state.mode === MODE_PUZZLE_WRITE,
    // 接续会话的第一步就是「按需读」：把该读什么直接写进返回，省一次摸索。
    ...(brief
      ? {
        readNext: [
          '只读主文档（查找入口，四节：模块索引 / 源码索引 / 工具索引 / 坑）：' + (state.mainDoc ?? ''),
          '再按本轮要动的地方只读一个模块文档；不确定读哪个就问用户，别通读模块目录。',
          '需要看实现时按主文档的「源码索引」直接跳源码。',
        ],
        hint: '这是精简档（brief）。要每模块的五维明细用 op:read 且不带 brief；单个模块的正文用 op:show。',
      }
      : {}),
    ...pauseFields(),
    ...extra,
  }
}

/** `op:'list'` 的返回：所有项目 + 哪个是「不给 project 时的默认」。 */
export function summarizeList(projectRoot, projects) {
  return {
    ok: true,
    initialized: projects.length > 0,
    projectRoot,
    projectCount: projects.length,
    projects,
    defaultProject: projects.length > 0 ? projects[0].name : null,
    hint: projects.length > 0
      ? '多个项目并存时请在调用里显式给 project，否则默认用最新的那个。'
      : '项目根下还没有拼图项目，用 op=init 新建。',
    ...pauseFields(),
  }
}

export function isExecutableMode(mode) {
  return mode === MODE_PUZZLE_WRITE
}

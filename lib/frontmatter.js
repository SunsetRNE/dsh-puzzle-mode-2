/**
 * front-matter 解析/生成、小节读写、文档格式版本。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { join } from 'node:path'
import { DEFAULT_MODE, SESSION_FIELD, CURRENT_SESSION_FIELD, SOURCE_ROOT_FIELD, WORKFLOW_ARCHIVE_FIELD, PUZZLE_VERSION, HEADING_BY_KEY, HEADING_SUFFIX_SEPARATOR } from './constants.js'
import { slugify, timestamp } from './util.js'


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
    // 会话绑定只写在主文档上：一个会话可以绑多个项目（v7），绑定随文档走。
    const sessions = normalizeSessions(fields.sessions)
    if (sessions.length > 0) lines.push(`${SESSION_FIELD}: ${JSON.stringify(sessions)}`)
    // 当前会话：这些会话里，**本会话的当前项目是这里**（工具不给 project 时落在这）。
    // 不变量 `当前会话 ⊆ 会话` 在这里做最后一道收口：写进来的当前会话必须在绑定里，
    // 否则会造出「当前项目是本项目，但本项目其实没绑这个会话」这种自相矛盾的文档——
    // 那种文档读起来处处诡异（绑列表里没有它，却把它当当前项目）。
    const current = normalizeSessions(fields.currentSessions).filter((id) => sessions.includes(id))
    if (current.length > 0) lines.push(`${CURRENT_SESSION_FIELD}: ${JSON.stringify(current)}`)
    // 工作流归档（被删掉、可恢复的工作流条目）：**只在非空时才写这一行**。
    // 空数组写出来就是一行噪音，而且会让「新建项目」的产物带上一个永远为空的字段。
    const archive = normalizeArchive(fields.workflowArchive)
    if (archive.length > 0) lines.push(`${WORKFLOW_ARCHIVE_FIELD}: ${JSON.stringify(archive)}`)
  }
  lines.push(`更新时间: ${fields.updated ?? timestamp()}`, '---')
  return lines.join('\n')
}

/** 读一份文档开头的 front-matter；没有则返回一个空对象。 */


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


/** 归一化会话 ID 列表：去空、去重、保序。 */
export function normalizeSessions(raw) {
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
  return parseJsonIdList(fields, SESSION_FIELD)
}

/**
 * 读主文档 front-matter 里的 `当前会话:` 数组；缺失或坏 JSON 都当作空列表，不抛错。
 *
 * 与 `parseSessionList` 共用 `parseJsonIdList`：两者形状完全一样（JSON 字符串数组），
 * 差别只在字段名。分开写成两个导出而不是让调用方传字段名，是因为**调用点很多**，
 * 每次都要记得传对字段名，迟早会有一处传错——那种错还很安静（读出来是空列表，
 * 表现为「当前项目没了」而不是报错）。
 */
export function parseCurrentSessionList(fields) {
  return parseJsonIdList(fields, CURRENT_SESSION_FIELD)
}

/**
 * 读一个「JSON 字符串数组」字段，坏值一律当空列表。
 *
 * 为什么全部吞掉错误：这两个字段都在**每次工具调用**的热路径上（绑定解析 + 面板），
 * 一行坏 JSON 不能让整个状态读取失败——面板会因此整个打不开，
 * 而用户只是手工编辑时打错了一个字符。读不出来最多是「绑定丢了」，重绑即可。
 */
function parseJsonIdList(fields, field) {
  const raw = fields !== null && typeof fields === "object" ? fields[field] : undefined
  if (typeof raw !== "string" || raw.trim() === "") return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return normalizeSessions(parsed)
  } catch (_error) {
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

/**
 * 归一化工作流归档列表：只做形状归一（v5 的字符串 → v6 的 `{name, steps}` 块）。
 *
 * 与 `normalizeSessions` 分开写而不是复用一个「通用字符串数组」函数：两者的**语义不同**
 * （会话 ID 是标识符，归档是整条流水线），将来任一方的规则变（比如归档要限长）
 * 都不该牵动另一方。重复实现只有几行，比耦合便宜。
 *
 * **不按名字去重**：那是 `normalizeArchiveCapped` 的职责（它带 10 条上限）。
 * 本函数保持纯形状转换，谁调它都不会意外吃掉一条记录。
 */
export function normalizeArchive(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    // v5 及更早的字符串归档项：当作「只有名字、没有步骤」的块收下，别丢用户删过的记录。
    if (typeof item === 'string') {
      const value = item.trim()
      if (value === '') continue
      out.push({ name: value, steps: [] })
      continue
    }
    if (item === null || typeof item !== 'object') continue
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (name === '') continue
    out.push({
      name,
      steps: Array.isArray(item.steps) ? item.steps.filter((s) => typeof s === 'string' && s.trim() !== '') : [],
    })
  }
  return out
}

/**
 * 读主文档 front-matter 里的 `工作流归档:`；缺失或坏 JSON 都当作空列表，不抛错。
 *
 * 与 `parseSessionList` 一样**不抛错**：坏值当没写。归档读不出来最多是「不能回滚」，
 * 绝不能让整个状态读取失败——面板会因为一行坏 JSON 整个打不开。
 */
export function parseWorkflowArchive(fields) {
  const raw = fields !== null && typeof fields === 'object' ? fields[WORKFLOW_ARCHIVE_FIELD] : undefined
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return normalizeArchive(parsed)
  } catch (_error) {
    return []
  }
}

/* --------------------------------- 小节读写 --------------------------------- */

/** 取出某个 `## 标题` 小节的正文（到下一个 `## ` 为止）。 */


/* --------------------------------- 小节读写 --------------------------------- */

/**
 * 判断一行是不是「某个规范标题」的小节头，允许后面跟一段说明。
 *
 * `## 源码索引（src/，共 110 文件）` 要能匹配 `## 源码索引`——否则那一节读不出来，
 * 写的时候还会另起一个空节，原文永远看不见（实测 bug）。
 * 但只容忍**分隔符开头**的后缀：`## 坑与决策` 不是 `## 坑`，
 * 否则会把两个不同的小节误合并。
 */
export function headingMatches(line, heading) {
  const text = String(line ?? '').trim()
  const want = String(heading ?? '').trim()
  if (text === want) return true
  if (!text.startsWith(want)) return false
  return HEADING_SUFFIX_SEPARATOR.test(text.slice(want.length))
}

/** 取出某个 `## 标题` 小节的正文（到下一个 `## ` 为止）。 */
export function getSection(text, heading) {
  const lines = String(text ?? '').split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (headingMatches(lines[i], heading)) {
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

/**
 * 找出文档里**规范之外**的小节标题。
 *
 * 判定用 `headingMatches`：`## 源码索引（src/…）` 不算多余（它属于 `## 源码索引`），
 * 而 `## 模块 → 文档` 算多余。审查与 rebuild 共用这一份判定，
 * 免得「一个说要删、另一个说不算」。
 */
export function extraSectionsIn(body, canonicalHeadings) {
  const seen = []
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (!/^##\s/.test(line)) continue
    const heading = line.trim()
    if (seen.includes(heading)) continue
    seen.push(heading)
  }
  return seen.filter((heading) => !canonicalHeadings.some((known) => headingMatches(heading, known)))
}

/** 按 KEY → 标题 读出全部小节。 */


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
  // 用容忍后缀的匹配：`## 源码索引（src/…）` 要原地替换，而不是另起一个空节。
  const at0 = lines.findIndex((line) => headingMatches(line, heading))
  const start = at0
  const block = body === '' ? [] : body.split('\n')

  if (start >= 0) {
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^##\s/.test(lines[i])) {
        end = i
        break
      }
    }
    // 标题本身也归一化成规范写法：说明后缀（「（src/，共 110 文件）」）是旧文档的
    // 残留，写一次就顺手清掉，免得同一节长期存在两种标题。
    // 小节之间保留一个空行：`block` 后面紧跟下一个 `## ` 会让标题贴着上一条，
    // 渲染出来是一个大段落。只有当后面**确实还有内容**（end < lines.length）时才补。
    const tail = end < lines.length ? [''] : []
    return [...lines.slice(0, start), heading, ...block, ...tail, ...lines.slice(end)].join('\n')
  }

  let insertAt = lines.length
  for (const [, known] of HEADING_BY_KEY) {
    const at = lines.findIndex((line) => headingMatches(line, known))
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


/** 旧模板的说明行（整行完全一致才替换），迁移时换成当前版的说明。 */
export const OLD_PREAMBLE_LINES = new Set([
  '> 本文件只做检索、坑、原话与三类决策；细节一律在 `模块/` 下。',
  '> 项目健康性由模块文档的五维分数汇总得出，不在本文件手写总分。',
  '> 只有五节：模块索引 / 源码索引 / 工具索引 / 坑 / 工作流。决策与轮汇报在 `模块/` 下。',
  '> 每条一句话 + 出处（源码: 文件:行）；查找方向固定为 主文档 → 源码。',
  '> `## 工作流` 约束模型在特定操作下别做别的事（≤5 条，可在面板删除与恢复）。',
])

/**
 * 模板的说明行（v6 起是四行）。
 *
 * 最后一行在 v6 改写了：工作流从「约束清单」重定义为**标准化流水线**
 * （用户原话：为完成特定任务，把重复步骤、工具、规则按顺序串成的流水线）。
 * 旧的那句「约束模型在特定操作下别做别的事」放进 `OLD_PREAMBLE_LINES`，
 * 迁移时整行替换——否则老文档会永远留着一句与新语义矛盾的自述。
 */
export const PREAMBLE_LINES = [
  '> 只有五节：模块索引 / 源码索引 / 工具索引 / 坑 / 工作流。决策与轮汇报在 `模块/` 下。',
  '> 每条一句话 + 出处（源码: 文件:行）；查找方向固定为 主文档 → 源码。',
  '> 项目健康性由模块文档的五维分数汇总得出，不在本文件手写总分。',
  '> `## 工作流` 是**标准化流水线**：一条一个 `### 名字` 块，块内按顺序写步骤（≤5 条 / 每条 ≤12 步）。',
]

/**
 * 把正文拆成 `## ` 小节：前导部分 + 标题 → 内容行。
 *
 * 同名小节**合并**而不是丢弃——重复标题是老文档里真实出现过的
 * （手工编辑留下的第二份），丢掉第二份就是静默删内容。
 */


/* --------------------------------- 写入 --------------------------------- */

/** 从 front-matter 里安全读出模块清单（坏 JSON 当空数组）。 */
export function safePlanned(fields) {
  try {
    const parsed = JSON.parse(fields['计划模块'] ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => slugify(item)).filter((item) => item !== null)
  } catch (_error) {
    return []
  }
}

/** 只改主文档的行为字段（模式 / 模块清单），保留其余内容。 */

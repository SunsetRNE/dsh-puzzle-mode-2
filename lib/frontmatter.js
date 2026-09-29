/**
 * front-matter 解析/生成、小节读写、文档格式版本。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { join } from 'node:path'
import { DEFAULT_MODE, SESSION_FIELD, SOURCE_ROOT_FIELD, PUZZLE_VERSION, HEADING_BY_KEY } from './constants.js'
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
    // 会话绑定只写在主文档上：一个会话只绑一个项目，绑定随文档走。
    const sessions = normalizeSessions(fields.sessions)
    if (sessions.length > 0) lines.push(`${SESSION_FIELD}: ${JSON.stringify(sessions)}`)
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


/** 旧模板的说明行（整行完全一致才替换），迁移时换成 v3 的三行说明。 */
export const OLD_PREAMBLE_LINES = new Set([
  '> 本文件只做检索、坑、原话与三类决策；细节一律在 `模块/` 下。',
  '> 项目健康性由模块文档的五维分数汇总得出，不在本文件手写总分。',
])

/** v3 模板的三行说明（迁移时补齐）。 */


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

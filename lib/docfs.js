/**
 * 拼图目录的路径守卫与原子写。**任何**写盘都必须经过这里，路径不许绕过 puzzleDirOf。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { PUZZLE_DIR } from './constants.js'
import { slugify } from './util.js'


/* --------------------------------- 路径与落盘 --------------------------------- */

/** 把相对路径拼到 root 下，并确认结果没有逃出 root。 */
export function safeJoin(root, ...parts) {
  const target = resolve(root, ...parts)
  const base = resolve(root)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

/** 解析项目根下的 拼图/ 目录；不在项目根内则返回 null。 */


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


export function readText(file) {
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

/**
 * 无依赖的小工具：文件枚举、百分比夹取、均值、slug、时间戳、finding 构造。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'


/* ---------------------------------- 小工具 ---------------------------------- */

export function listFiles(dir) {
  try {
    return readdirSync(dir)
  } catch (_error) {
    return []
  }
}


export function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch (_error) {
    return false
  }
}


export function clampPercent(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}


export function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0
  return clampPercent(values.reduce((sum, value) => sum + value, 0) / values.length)
}

/** 解析一个安全 slug；返回 null 表示这个名字不能用。 */


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


export function finding(id, level, dimension, scope, fact, fix) {
  return { id, level, dimension, scope, fact, fix }
}

/**
 * 把当前状态过一遍，输出**客观发现清单**。只陈述事实，不做评价。
 *
 * 不抛错：状态缺字段一律按 0 处理（未初始化的项目也会走到这里）。
 */

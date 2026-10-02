/**
 * 全局设置：拼图模式的「按会话禁用」名单。
 *
 * 为什么存在**全局文件**里、而不是写进项目文档：它管的是「哪些会话不要拼图模式」，
 * 与任何具体项目无关——一个会话可能还没绑定项目就想先关掉它。存在 `$DSH_HOME` 下，
 * 跨 profile、跨项目一致；但记的是**会话 ID 名单**，所以只影响被点名的那个会话。
 *
 * 为什么需要它：拼图模式会往每一轮的 system prompt 里注入一段规则、并注册
 * `puzzle_mode` 工具。总有场景你只想安安静静改个代码，不想被提问规则牵着走——
 * 但你又不想卸载插件。这个开关就是那条退路，而且**随时能恢复**。
 *
 * 语义（用户裁定「单独会话禁用不是全局」）：
 *   - 记的是**会话 ID 名单**，不是时刻；
 *   - 只有名单里的会话被禁用，其余会话照旧——互不影响；
 *   - 关掉**立即生效**：宿主每个 step 都重新 assemble 提示段
 *     （`dsh-agent-loop` 的 `preStep` 里 `systemPrompt.assemble(...)`），
 *     所以本会话下一轮就不再注入拼图规则、也不再拦工具。
 *
 * 早先的版本记的是「禁用时刻」，只对**此后新建**的会话生效——那个语义被用户明确否掉。
 * 旧文件里的 `disabledSince` 字段现在**直接忽略**：读不到 `disabledSessions` 就当没人被禁用。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { atomicWrite, readTextCached } from './docfs.js'

/** 设置文件名（放在 DSH_HOME 根下）。 */
export const SETTINGS_FILE = '.dsh-puzzle-mode.json'

/** 禁用名单上限：防长期使用把它撑成无限大。超了丢最旧的。 */
export const MAX_DISABLED_SESSIONS = 200

/** 设置目录：优先 `$DSH_HOME`，拿不到就退回 `~/.dsh`（与插件管理器的口径一致）。 */
export function settingsDir() {
  const home = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return home !== '' ? home : join(homedir(), '.dsh')
}

export function settingsPath() {
  return join(settingsDir(), SETTINGS_FILE)
}

/**
 * 读设置。**从不抛错**：文件缺失、读不出来、JSON 坏掉，一律当作「没有会话被禁用」。
 * 宁可少拦，也不要因为一个坏文件让所有会话都用不了拼图。
 *
 * 为什么带缓存（实测数字，2026-10-02）：本函数在**每一次工具调用**（`tools/pre-execute`）
 * 与**每一个 step**（提示段 assemble）上都会走到，而它原先每次都要
 * `isFile` + `statSync` + 读文件 + `JSON.parse`——实测单次 **1.4–3.5ms**，
 * 全部是同步阻塞。设置文件的内容**只在用户点面板开关时才变**，
 * 所以按 `mtimeMs + size` 指纹缓存解析结果，命中时只剩一次 `statSync`。
 *
 * 为什么不用「写时清缓存」了事：设置也可能被**别的进程**（另一个 profile）改，
 * 所以指纹比「只在 `writeSettings` 里失效」更稳；两者都做，代价可忽略。
 */
let settingsCache = null

export function readSettings() {
  const file = settingsPath()
  let stat = null
  try {
    stat = statSync(file)
  } catch (_error) {
    // 文件不存在 / 读不到：按「没人被禁用」处理，并清掉可能过期的缓存。
    settingsCache = null
    return { disabledSessions: [] }
  }
  const fingerprint = `${stat.mtimeMs}:${stat.size}`
  if (settingsCache !== null && settingsCache.file === file && settingsCache.fingerprint === fingerprint) {
    return settingsCache.value
  }
  const text = readTextCached(file)
  if (text === null) {
    settingsCache = null
    return { disabledSessions: [] }
  }
  let value = { disabledSessions: [] }
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.disabledSessions)) {
      // 去重 + 只留非空字符串：坏数据不要带进内存。
      const seen = new Set()
      const clean = []
      for (const item of parsed.disabledSessions) {
        if (typeof item !== 'string' || item === '' || seen.has(item)) continue
        seen.add(item)
        clean.push(item)
      }
      value = { disabledSessions: clean }
    }
  } catch (_error) {
    value = { disabledSessions: [] }
  }
  settingsCache = { file, fingerprint, value }
  return value
}

function writeSettings(disabledSessions) {
  atomicWrite(settingsPath(), JSON.stringify({ disabledSessions }, null, 2) + '\n')
  // 写完立刻失效：`atomicWrite` 的 rename 在同一毫秒内可能让指纹看起来没变，
  // 而同进程紧接着读必须看到新值（用户点开关 → 下一轮立即生效，这条不能破）。
  settingsCache = null
}

/**
 * 这个会话是否被禁用。
 *
 * 判定只认**会话 ID**——拿不到 ID 时返回 `false`（不禁用）：这是个 opt-in 的开关，
 * 判定不了就别拦；漏拦一个会话，比误伤一个正在干活的会话代价小得多。
 */
export function isSessionDisabled(sessionId, settings = readSettings()) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  const list = settings === null || settings === undefined ? null : settings.disabledSessions
  if (!Array.isArray(list)) return false
  return list.includes(sessionId)
}

/** 禁用**这一个**会话。重复调用是幂等的。 */
export function disableSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, error: '缺少会话 ID，无法禁用' }
  }
  const prev = readSettings()
  if (prev.disabledSessions.includes(sessionId)) {
    return { ok: true, sessionId, alreadyDisabled: true, disabledSessions: prev.disabledSessions }
  }
  // 满了就丢最旧的那个（数组头部），保证名单有界。
  const next = [...prev.disabledSessions, sessionId]
  while (next.length > MAX_DISABLED_SESSIONS) next.shift()
  writeSettings(next)
  return { ok: true, sessionId, alreadyDisabled: false, disabledSessions: next }
}

/** 恢复**这一个**会话。其余会话的禁用状态不受影响。 */
export function enableSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, error: '缺少会话 ID，无法恢复' }
  }
  const prev = readSettings()
  if (!prev.disabledSessions.includes(sessionId)) {
    return { ok: true, sessionId, wasDisabled: false, disabledSessions: prev.disabledSessions }
  }
  const next = prev.disabledSessions.filter((id) => id !== sessionId)
  writeSettings(next)
  return { ok: true, sessionId, wasDisabled: true, disabledSessions: next }
}

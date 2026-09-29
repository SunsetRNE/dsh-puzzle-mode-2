/**
 * 全局设置：拼图模式的「对新会话禁用」开关。
 *
 * 为什么是**全局**而不是项目级：它管的是「以后新建的会话要不要带上拼图模式」，
 * 与任何具体项目无关。存在 `$DSH_HOME` 下，跨 profile、跨项目一致。
 *
 * 为什么需要它：拼图模式会往每一轮的 system prompt 里注入一段规则、并注册
 * `puzzle_mode` 工具。总有场景你只想安安静静改个代码，不想被提问规则牵着走——
 * 但你又不想卸载插件。这个开关就是那条退路，而且**随时能恢复**。
 *
 * 语义（用户原话「只针对新会话」）：
 *   - 禁用记下**时刻**，不是布尔值；
 *   - `会话创建时间 >= 禁用时刻` 的会话才算「新会话」，才被禁用；
 *   - 因此**当前会话不受影响**——你是在这个会话里按下开关的，它出生在前。
 *   - 恢复时清掉时刻，所有会话（含禁用期间新建的）都回到拼图模式。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isFile } from './util.js'
import { atomicWrite, readText } from './docfs.js'

/** 设置文件名（放在 DSH_HOME 根下）。 */
export const SETTINGS_FILE = '.dsh-puzzle-mode.json'

/** 设置目录：优先 `$DSH_HOME`，拿不到就退回 `~/.dsh`（与插件管理器的口径一致）。 */
export function settingsDir() {
  const home = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return home !== '' ? home : join(homedir(), '.dsh')
}

export function settingsPath() {
  return join(settingsDir(), SETTINGS_FILE)
}

/**
 * 读设置。**从不抛错**：文件缺失、读不出来、JSON 坏掉，一律当作「没禁用」。
 * 宁可少拦，也不要因为一个坏文件让所有会话都用不了拼图。
 */
export function readSettings() {
  const file = settingsPath()
  if (!isFile(file)) return { disabledSince: null }
  const text = readText(file)
  if (text === null) return { disabledSince: null }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { disabledSince: null }
    const since = parsed.disabledSince
    return { disabledSince: typeof since === 'number' && Number.isFinite(since) ? since : null }
  } catch (_error) {
    return { disabledSince: null }
  }
}

function writeSettings(disabledSince) {
  atomicWrite(settingsPath(), JSON.stringify({ disabledSince }, null, 2) + '\n')
}

/**
 * 禁用：记下时刻。**重复调用不改时刻**——否则每次按一下都把界线往后推，
 * 会把「已经出生但还没开始干活」的会话反复漏掉。
 */
export function disableForNewSessions(now = Date.now()) {
  const prev = readSettings()
  if (prev.disabledSince !== null) {
    return { ok: true, disabledSince: prev.disabledSince, alreadyDisabled: true }
  }
  writeSettings(now)
  return { ok: true, disabledSince: now, alreadyDisabled: false }
}

/** 恢复：清掉时刻。所有会话（含禁用期间新建的）都回到拼图模式。 */
export function enableForAllSessions() {
  const prev = readSettings()
  if (prev.disabledSince === null) return { ok: true, wasDisabled: false, disabledSince: null }
  writeSettings(null)
  return { ok: true, wasDisabled: true, disabledSince: null, previousDisabledSince: prev.disabledSince }
}

/**
 * 这个会话是否被禁用。
 *
 * `createdAt` 拿不到时**返回 false**（不禁用）：这是个 opt-in 的开关，
 * 判定不了就别拦——漏拦一个会话，比误伤一个正在干活的会话代价小得多。
 */
export function isDisabledFor(createdAt, settings = readSettings()) {
  const since = settings === null || settings === undefined ? null : settings.disabledSince
  if (since === null || since === undefined) return false
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return false
  return createdAt >= since
}

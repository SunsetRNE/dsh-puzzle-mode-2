/**
 * 条目规格：限长、必须带源码出处、超条数删最旧。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { join } from 'node:path'
import { SECTION_ORDER, SECTION_HEADINGS, MODULE_SECTION_HEADINGS, ENTRY_LIMITS, SOURCE_MARK } from './constants.js'
import { getSection } from './frontmatter.js'


/* --------------------------------- 计数 --------------------------------- */

/**
 * 模板自带的说明性占位行——**只认这几种固定说法**。
 *
 * 早先的实现把「整行就是一对括号」一律当占位，于是用户写的
 * 「（见模块 auth-flow）」这类真内容会被误判为空、少算条数。
 */
export const PLACEHOLDER_PATTERNS = [
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
  // `## 可复用` 的模板说明行。**必须单独列一条**：它长得像真条目
  // （「可被别处复用的接口 / 共享模块…」），不认出来就会被算成 1 条证据，
  // 于是新建的模块可复用性直接有 30 分——凭空来的分。
  /^[（(][^）)]*(可被别处复用)[^）)]*[）)]$/,
]

/** 剔掉空行与模板占位行。同时剥掉列表符与勾选框，好让 `- [ ] （待补）` 也认得出是占位。 */


/** 剔掉空行与模板占位行。同时剥掉列表符与勾选框，好让 `- [ ] （待补）` 也认得出是占位。 */
export function nonEmptyLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, '').replace(/^\[[ xX]\]\s*/, '').trim())
    .filter((line) => line !== '' && !PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(line)))
}


export function countItems(text) {
  return nonEmptyLines(text).length
}

/* ------------------------------- 条目规整与限长 ------------------------------- */

/**
 * 把一段正文拆成条目行（保留 `- ` 前缀，供回写用）。
 *
 * 与 `nonEmptyLines` 的区别：这里**保留原始行**，因为限长与截断要按行回写，
 * 不能只拿剥掉标记的文本。空行与模板占位行仍然剔除。
 */


/* ------------------------------- 条目规整与限长 ------------------------------- */

/**
 * 把一段正文拆成条目行（保留 `- ` 前缀，供回写用）。
 *
 * 与 `nonEmptyLines` 的区别：这里**保留原始行**，因为限长与截断要按行回写，
 * 不能只拿剥掉标记的文本。空行与模板占位行仍然剔除。
 */
export function entryLines(text) {
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


/** 条目正文里「源码出处」之前的那部分——限长只算它，出处不占额度。 */
export function entryBody(line) {
  const bare = String(line ?? '').trim().replace(/^\s*[-*]\s*/, '').trim()
  const at = bare.indexOf(SOURCE_MARK)
  return at < 0 ? bare : bare.slice(0, at).trim()
}

/** 字数：按 Unicode 码点算，一个汉字算 1。 */


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

/**
 * 从文档正文里抽出**被引用到的源码文件名**（`（源码: lib/x.js:12）` → `x.js`）。
 *
 * 为什么要它：审查要给「模块级」源码真实值，但源码体检是**项目级**的。
 * 不做映射的话，每个模块都会拿到同一份项目级硬伤——8 个模块的分一模一样，
 * 而且会把「client.js 1303 行」算到「会话绑定」头上：那是编出来的因果。
 *
 * 只取 basename：文档里写 `lib/x.js`，体检结果里是 `x.js`，两边对齐靠文件名。
 * 抽不到任何文件（文档没写出处）时返回空数组——调用方据此判定「这个模块没指到代码」，
 * 应当**只用文档证据**算分，而不是拿全项目硬伤去扣。
 */
export function citedSourceFiles(body) {
  const out = new Set()
  const re = /（源码:\s*([^:：）]+?)(?:[:：]\d+)?\s*）/g
  let match = re.exec(body)
  while (match !== null) {
    const raw = match[1].trim()
    // 只认像源码文件的（带扩展名），排除 `模块/x.md` 这类文档自身引用。
    if (/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|sh)$/.test(raw)) {
      const at = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
      out.add(at < 0 ? raw : raw.slice(at + 1))
    }
    match = re.exec(body)
  }
  return [...out].sort()
}

/** 主文档四节的条目规格（模块索引指向模块文档，不强制源码出处）。 */


/** 主文档四节的条目规格（模块索引指向模块文档，不强制源码出处）。 */
export const MAIN_ENTRY_SPEC = Object.fromEntries(SECTION_ORDER.map((key) => [key, {
  heading: SECTION_HEADINGS[key],
  limit: ENTRY_LIMITS[key],
  requireSource: key !== 'index',
}]))

/** 模块文档四个条目式小节的规格。 */


/**
 * 模块文档的条目式小节规格（`## 可复用` 也在此列：它是「可复用性」的证据来源）。
 *
 * `limit` **不做 `?? 默认值` 兜底**：早先写成 `ENTRY_LIMITS[key] ?? ENTRY_LIMITS.points`，
 * 于是 `ENTRY_LIMITS` 漏了 `pending` / `decided` 时静默退化成「用 points 的上限」，
 * 更早的一版则直接传 `undefined`——`count > undefined` 恒为 `false`，
 * 「悬而未决 / 已定 ≤20 字」这条规格**从来没生效过**，而且一声不吭。
 * 现在缺上限会直接抛错，宁可炸在启动时，也不要静默放过。
 */
export const MODULE_ENTRY_SPEC = Object.fromEntries(['points', 'pending', 'decided', 'reuse', 'detail'].map((key) => {
  const limit = ENTRY_LIMITS[key]
  if (typeof limit !== 'number') throw new Error('ENTRY_LIMITS 缺少 ' + key + ' 的上限')
  return [key, { heading: MODULE_SECTION_HEADINGS[key], limit, requireSource: true }]
}))

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

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

/**
 * 从文档正文里抽出**被引用到的源码文件路径**（`（源码: lib/x.js:12）` → `lib/x.js`）。
 *
 * 为什么要它：审查要给「模块级」源码真实值，但源码体检是**项目级**的。
 * 不做映射的话，每个模块都会拿到同一份项目级硬伤——8 个模块的分一模一样，
 * 而且会把「client.js 1303 行」算到「会话绑定」头上：那是编出来的因果。
 *
 * 三条口径（每条都对应一个真实缺陷）：
 *  1. **保留相对路径，不只留 basename**：`src/a/index.ts` 与 `src/b/index.ts`
 *     必须能区分，否则两条被去重成一条，命中一个文件的扣分会错误地摊给另一个模块。
 *  2. **反引号包裹也要认**：`` `src/gi/pool.ts:30` `` 是 markdown 里的主流写法，
 *     老实现把反引号一起捕获，结尾不是 `.ts`，整条静默丢弃。
 *  3. **「待建 / TODO / 计划」这类前缀的引用要剔除**：它们指的是**还不存在**的文件，
 *     算进「测过」会把没开工的模块抬成源码侧满分（方向性错误）。
 *
 * 抽不到任何文件（文档没写出处）时返回空数组——调用方据此判定「这个模块没指到代码」，
 * 应当**只用文档证据**算分，而不是拿全项目硬伤去扣。
 */
export function citedSourceFiles(body) {
  const out = new Set()
  // 允许反引号/空格包裹路径；路径里不允许出现冒号（`:行号` 与 Windows 盘符都排除）。
  const re = /（源码[:：]\s*`?\s*([^:：）`]+?)\s*`?(?:[:：]\s*\d+)?\s*）/g
  let match = re.exec(body)
  while (match !== null) {
    const raw = match[1].trim()
    // 「待建 / 计划 / TODO / 未建」开头的引用指的是不存在的文件，不算已测量。
    // ⚠️ **不能用 `\b`**：汉字不是 `\w`，`/待建\b/` 永远不匹配（踩过）——
    // 用「后面跟空白或结束」代替词边界。
    if (/^(待建|计划|规划|未建|未开工|todo|planned|tbd)(\s|$)/i.test(raw)) {
      match = re.exec(body)
      continue
    }
    // 只认像源码文件的（带扩展名），排除 `模块/x.md` 这类文档自身引用。
    if (/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|sh)$/i.test(raw)) {
      out.add(raw.replace(/\\/g, '/').replace(/^\.\//, ''))
    }
    match = re.exec(body)
  }
  return [...out].sort()
}

/**
 * 主文档五节的条目规格。
 *
 * `index` 指向模块文档（`模块/X.md` 本身就是回查路径），所以只限长、不要求出处。
 * `workflow` **不强制出处**：它约束的是「完成某任务的流程」，不是对代码事实的断言——
 * 强行要求 `（源码: …）` 只会逼出编造的出处。
 *
 * ⚠️ **v6 起 `workflow` 不再走本表**：它是 `### 块 + 步骤` 结构，不是「一行一条」，
 * 所以 `updateMainSection` 里对 workflow 单独走 `normalizeWorkflowEntries`。
 * 这里保留它的键（`limit` 只是占位，无实际校验作用），是为了让 `SECTION_ORDER`
 * 的每一项在本表里都有对应项——少一项会让按 key 取规格的旧调用点读到 `undefined`。
 * 其余三节（源码索引 / 工具索引 / 坑）必须能回查源码。
 */
export const MAIN_ENTRY_SPEC = Object.fromEntries(SECTION_ORDER.map((key) => [key, {
  heading: SECTION_HEADINGS[key],
  limit: ENTRY_LIMITS[key],
  requireSource: key !== 'index' && key !== 'workflow',
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

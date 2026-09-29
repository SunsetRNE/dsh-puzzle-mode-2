/**
 * 文档格式迁移与重建：只改形状，正文一字不动。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { join } from 'node:path'
import { MAIN_FILE, MODULE_DIR, MODES, DEFAULT_MODE, SESSION_FIELD, PUZZLE_VERSION, PROGRESS_TO_HEALTH, HEALTH_HEADING, SECTION_ORDER, SECTION_HEADINGS, RELATED_HEADING, MODULE_SECTION_HEADINGS, MODULE_SECTION_ORDER, ENTRY_CAPS } from './constants.js'
import { listFiles, isFile, clampPercent, slugify, timestamp } from './util.js'
import { safeJoin, puzzleDirOf, atomicWrite, readText } from './docfs.js'
import { formatFrontMatter, parseFrontMatter, normalizeSessions, parseSessionList, parseSourceRoot, docVersion, headingMatches, OLD_PREAMBLE_LINES, PREAMBLE_LINES, safePlanned } from './frontmatter.js'
import { countItems, entryLines } from './entries.js'
import { HEALTH_DIMENSIONS, healthOf } from './health.js'


/**
 * 迁移链：每一步把文档从 `from` 版改到 `to` 版。
 *
 * 只在**形状**上动手（front-matter 字段、小节是否存在与顺序），不动用户写的正文；
 * 唯一一处"造内容"是 v1→v2 把旧完成度折算成五维，且只在推导拿不到分时才填。
 * `changes` 里逐条说明改了什么，dry-run 与落盘共用同一份结果。
 */
export const MIGRATIONS = [
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


/**
 * v2 及更早版本里主文档有、v3 已取消的小节（整节删除，内容不外迁）。
 *
 * `## 健康性` 也在列：v3 起项目级健康性不再写进文档（它是模块均值，写下来只会与事实矛盾）。
 */
export const DROPPED_MAIN_SECTIONS = ['## 用户原话', '## 悬而未决', '## 已定', '## 撤销', '## 健康性']

/** 旧模板的说明行（整行完全一致才替换），迁移时换成 v3 的三行说明。 */


/**
 * 把正文拆成 `## ` 小节：前导部分 + 标题 → 内容行。
 *
 * 同名小节**合并**而不是丢弃——重复标题是老文档里真实出现过的
 * （手工编辑留下的第二份），丢掉第二份就是静默删内容。
 */
export function splitSections(body) {
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


/** 按给定顺序把拆出来的小节拼回去；未列出的小节按原顺序附在末尾。 */
export function joinSections(preamble, groups, order, headings) {
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


/**
 * 迁移期的条目搬移：**只去勾选框、只按上限删最旧，不校验字数与出处**。
 *
 * 为什么不能用 `normalizeEntries`：它会要求每条都带 `（源码: …）`，
 * 而老文档里的条目本来就没有出处——那会让整段内容**静默变成「（待补）」**。
 * 迁移只改形状，正文不能因为新规则而被抹掉；新规则从下一次写入开始生效。
 */
export function migrateEntries(lines, cap) {
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


/**
 * 主文档的规范化：front-matter 补版本与 会话:，并把它收敛成**四节**。
 *
 * v3 起主文档只有 模块索引 / 源码索引 / 工具索引 / 坑。旧版的
 * 用户原话 / 悬而未决 / 已定 / 撤销 **整节删除**（用户裁定：用户原话不再入库，
 * 撤销项直接删除，决策只写在模块文档里）——所以这一步会真的丢内容，
 * dry-run 预览里逐条列出来，落盘前能看清。
 */
export function migrateMainDoc(text, projectName, planned) {
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
  // 先归一化**带说明后缀的规范标题**：`## 源码索引（src/，共 110 文件）` 的内容
  // 合并进 `## 源码索引`。必须在删非规范小节**之前**做，否则它会被当成多余小节删掉
  // ——那正是「内容还在但读不出来」的另一半。
  for (const heading of main.order.slice()) {
    if (!main.groups.has(heading)) continue
    const key = SECTION_ORDER.find((k) => headingMatches(heading, SECTION_HEADINGS[k]))
    if (key === undefined) continue
    const canonical = SECTION_HEADINGS[key]
    if (heading === canonical) continue
    const lines = main.groups.get(heading)
    main.groups.delete(heading)
    if (main.groups.has(canonical)) main.groups.get(canonical).push(...lines)
    else main.groups.set(canonical, lines)
    changes.push("小节标题归一化 " + heading + " → " + canonical)
  }
  // 规范清单之外的小节一律删掉：主文档**只允许**四节。
  //
  // 这是「删不掉的小节」那个 bug 的根：早先只删固定白名单，其它标题被 joinSections
  // 原样附回末尾——于是 `## 模块 → 文档` 这类小节永远活着。
  // 白名单天生跟不上实际写法，所以改成**白名单的反面**：不在规范里就删。
  for (const heading of main.order.slice()) {
    if (!main.groups.has(heading)) continue
    if (SECTION_ORDER.some((key) => headingMatches(heading, SECTION_HEADINGS[key]))) continue
    const count = countItems(main.groups.get(heading).join('\n'))
    main.groups.delete(heading)
    changes.push("删除非规范小节 " + heading + "（主文档只允许四节，含 " + count + " 条）")
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


/**
 * 模块文档的规范化：front-matter 只留 项目:/模块:，缺 ## 健康性 就补，
 * 并把 v2 的合并小节 `## 与本模块相关的悬而未决 / 已定 / 撤销` 拆成
 * `## 悬而未决` / `## 已定` 两个小节（去掉勾选框、按上限删最旧）。
 *
 * 补健康性时：**该维已经有推导分就不填数字**（填了就变成"显式声明"，反而把推导冻住）；
 * 推导为 0 且文档里有旧「完成度」时，按 PROGRESS_TO_HEALTH 折算一个起点，
 * 并在小节里留一行说明——它不是评估结果，是迁移值。
 */
export function migrateModuleDoc(text, name, projectText) {
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

  for (const key of ["progress", "points", "pending", "decided", "reuse", "detail"]) {
    const heading = MODULE_SECTION_HEADINGS[key]
    if (mod.groups.has(heading)) continue
    mod.groups.set(heading, [key === "progress" ? "完成度: 0" : "- （待补）"])
    changes.push("补小节 " + heading)
  }

  // 模块文档同样只允许规范小节：`## 可复用` 这类没有写入通道的小节会被删掉。
  // （`## 可复用` 曾是「可复用性」的证据来源，但没有任何 op 能写它——
  //  等于一条只能靠手改文档才能维持的分。见 health.js 的说明。）
  for (const heading of mod.order.slice()) {
    if (!mod.groups.has(heading)) continue
    if (MODULE_SECTION_ORDER.some((known) => headingMatches(heading, known))) continue
    const count = countItems(mod.groups.get(heading).join('\n'))
    mod.groups.delete(heading)
    changes.push("删除非规范小节 " + heading + "（模块文档只允许 " + MODULE_SECTION_ORDER.length + " 节，含 " + count + " 条）")
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


/** 磁盘上真的有文件的模块名（不依赖 front-matter 声明）。 */
export function modulesOnDisk(puzzleDir) {
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

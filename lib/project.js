/**
 * 项目级读写：建/绑/解绑、写小节、写健康性、汇总状态。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PUZZLE_DIR, MAIN_FILE, MODULE_DIR, MODES, DEFAULT_MODE, PUZZLE_VERSION, MODE_PUZZLE_WRITE, MODE_RENAME_VERSION, normalizeMode, HEALTH_HEADING, SECTION_ORDER, SECTION_HEADINGS, SECTION_KEYS, MODULE_SECTION_KEYS, MODULE_SECTION_HEADINGS, MODULE_SECTION_ORDER, ENTRY_LIMITS, ENTRY_CAPS, WORKFLOW_ARCHIVE_CAP } from './constants.js'
import { listFiles, isFile, clampPercent, slugify, timestamp } from './util.js'
import { safeJoin, puzzleDirOf, atomicWrite, readText } from './docfs.js'
import { formatFrontMatter, parseFrontMatter, normalizeSessions, parseSessionList, parseSourceRoot, parseWorkflowArchive, getSection, withSection, applySection, docVersion, safePlanned, extraSectionsIn } from './frontmatter.js'
import { entryLines, normalizeEntries, checkEntry, entryIssuesIn, citedSourceFiles, MAIN_ENTRY_SPEC, MODULE_ENTRY_SPEC } from './entries.js'
import { HEALTH_KEYS, healthOf, projectHealthOf, dimensionAverages } from './health.js'
import { sectionCounts, auditOf, fixPlanOf } from './audit.js'
import { collectSourceFiles } from './source.js'
import { mainTemplate, moduleTemplate } from './templates.js'


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


/* --------------------------------- 工作流 --------------------------------- */

/**
 * 工作流的**模板占位行**——只有这一种，而且是精确前缀匹配。
 *
 * 为什么不用 `entries.js` 的 `PLACEHOLDER_PATTERNS`：那套正则是为**模块文档**设计的
 * （「待补」「轮汇报」「可被别处复用」…），拿它过滤工作流会把**以括号开头的合法规则**
 * 静默吞掉——例如「（最多 3 条规则同时生效）」这种真条目会读成 0 条，且一声不吭。
 * 工作流的占位行只有模板/迁移写下的这一句，所以只认它，多一个都不认。
 */
const WORKFLOW_PLACEHOLDER = '（约束模型在特定操作下别做别的事'

/**
 * 读主文档 `## 工作流` 小节里的条目（去掉 `- ` 前缀，保留纯文本）。
 *
 * 为什么要有「工作流」这一节（用户原话：工作流可约束模型在特定的操作下不去做别的事
 * 以提高效率）：它是主文档里唯一一节**写给模型看的行为约束**，随提示段一起注入，
 * 模型每一步都读得到。其余四节是「查回来的事实」，用途完全不同，所以独立成节。
 *
 * 只滤掉**本小节自己的模板占位行**（见 `WORKFLOW_PLACEHOLDER`）：否则新建项目就会
 * 凭空多一条约束；而放宽到通用占位规则又会吞掉合法条目（实测过）。
 */
export function readWorkflow(body) {
  const out = []
  for (const raw of String(getSection(body, SECTION_HEADINGS.workflow) ?? '').split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    const bare = trimmed.replace(/^\s*[-*]\s*/, '').replace(/^\[[ xX]\]\s*/, '').trim()
    if (bare === '' || bare.startsWith(WORKFLOW_PLACEHOLDER)) continue
    out.push(bare)
  }
  return out
}

/**
 * 把工作流条目数组写回 `## 工作流` 小节；空数组写成一行说明占位。
 *
 * 写空时**不留空标题**：留一个光秃秃的 `## 工作流` 看着像坏了，
 * 而占位行能被 `WORKFLOW_PLACEHOLDER` 识别，不会被当成一条约束。
 */
export function writeWorkflow(text, items) {
  const list = Array.isArray(items) ? items.filter((item) => typeof item === 'string' && item.trim() !== '') : []
  const content = list.length === 0
    ? '- ' + WORKFLOW_PLACEHOLDER + '；最多 ' + ENTRY_CAPS.workflow + ' 条，超了删最旧，可在面板删除与恢复）'
    : list.map((item) => '- ' + item.trim()).join('\n')
  return withSection(text, SECTION_HEADINGS.workflow, content)
}

/**
 * 工作流的写入侧规整：**只认自己的占位行**，其余一律当条目。
 *
 * 为什么不能复用 `normalizeEntries`（模块文档那套）：它用 `entryLines` 过滤
 * `PLACEHOLDER_PATTERNS`，而那套正则里有「轮汇报」「可被别处复用」「最多 N 条」
 * 等**为模块文档设计**的模式——拿它处理工作流会把以括号开头的合法规则**静默吞掉**
 * （写进去 0 条，一声不吭）。工作流的占位行只有 `WORKFLOW_PLACEHOLDER` 一句。
 */
export function normalizeWorkflowEntries(content) {
  const incoming = []
  for (const raw of String(content ?? '').split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    const bare = trimmed.replace(/^\s*[-*]\s*/, '').replace(/^\[[ xX]\]\s*/, '').trim()
    if (bare === '' || bare.startsWith(WORKFLOW_PLACEHOLDER)) continue
    incoming.push('- ' + bare)
  }
  for (const line of incoming) {
    const checked = checkEntry(line, ENTRY_LIMITS.workflow, false)
    if (checked.ok !== true) return { ok: false, error: checked.error, hint: checked.hint }
  }
  return { ok: true, text: incoming.join('\n'), incoming: incoming.length }
}

/**
 * 只改主文档的**工作流**（正文小节 + front-matter 归档），其余内容一字不动。
 *
 * `nextItems` / `nextArchive` 都由调用方算好，这里只负责落盘与透传：
 * front-matter 必须整份重写（`formatFrontMatter` 的契约），所以项目 / 模式 / 模块清单 /
 * 会话绑定 / 源码根 / 归档**六个字段一个都不能漏**——漏一个就是静默丢数据。
 */
export function writeWorkflowDoc(mainDoc, text, nextItems, nextArchive) {
  const { fields, body } = parseFrontMatter(text)
  const next = [
    formatFrontMatter({
      puzzle: PUZZLE_VERSION,
      project: fields['项目'] ?? '',
      // 用**带版本**的归一：v4 文档里的 `边拼边写` 是旧含义，透传成新名字（写后再拼）。
      // 不带版本直接 includes 判定，旧值会被当成「不是合法模式」而退回默认（只拼不写），
      // 等于用户改一次工作流就被静默降级成只拼不写。
      mode: modeOfFields(fields, docVersion(text)),
      modules: safePlanned(fields),
      sessions: parseSessionList(fields),
      sourceRoot: parseSourceRoot(fields),
      workflowArchive: normalizeArchiveCapped(nextArchive),
      updated: timestamp(),
    }),
    writeWorkflow(body, nextItems).replace(/^\n+/, ''),
  ].join('\n')
  atomicWrite(mainDoc, next)
  return { ok: true, mainDoc, workflow: nextItems, workflowArchive: normalizeArchiveCapped(nextArchive) }
}

/**
 * front-matter 里的模式 → 当前三种之一。
 *
 * **版本必给**（默认当前版）：v4 及更早的 `边拼边写` 表示「一轮做完才问」，
 * 归一成 `写后再拼`。见 `constants.normalizeMode` 与 `MODE_RENAME_VERSION`。
 */
export function modeOfFields(fields, version = PUZZLE_VERSION) {
  const raw = fields !== null && fields !== undefined ? fields['模式'] : undefined
  return normalizeMode(raw, version) ?? DEFAULT_MODE
}

/**
 * 「整份重写 front-matter」时，**模式与版本这两个字段**该怎么写。
 *
 * 凡是要重写 front-matter 的写入路径（写小节 / 写会话 / 改模块清单 / 写工作流）都得走这里，
 * 否则 `模式: 边拼边写` 的旧文档会在某一次无关的写入里被静默改成 `只拼不写`
 * ——因为旧名字不在 `MODES` 里，随手写的 `MODES.includes(x) ? x : DEFAULT_MODE`
 * 就会把它替换掉。归一后名字变了，版本必须跟着到当前版，否则下次读又按旧含义解释。
 */
export function passThroughFields(fields, text) {
  const docVer = docVersion(text)
  const raw = typeof fields['模式'] === 'string' ? fields['模式'].trim() : ''
  const renamed = raw === MODE_PUZZLE_WRITE && docVer < MODE_RENAME_VERSION
  return {
    puzzle: renamed ? PUZZLE_VERSION : (fields.puzzle ?? 1),
    mode: modeOfFields(fields, docVer),
  }
}

/** 归档裁剪：去重保序 + 只保留最近 `WORKFLOW_ARCHIVE_CAP` 条（超了删最旧）。 */
export function normalizeArchiveCapped(list) {
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string') continue
    const value = item.trim()
    if (value === '' || out.includes(value)) continue
    out.push(value)
  }
  return out.length > WORKFLOW_ARCHIVE_CAP ? out.slice(out.length - WORKFLOW_ARCHIVE_CAP) : out
}

/**
 * 删掉 `## 工作流` 的第 `index` 条（**1 起**），该条进归档。
 *
 * 为什么要「进归档」而不是直接删（用户原话：工作流可在面版一键删除（可回滚））：
 * 面板一键删除是唯一会改主文档的 UI 动作，误点的代价必须是可撤销的。
 * 归档与正文分离存放，所以归档**不占用 5 条上限**，删了 10 条也不会把工作流挤空。
 *
 * 序号越界一律**报错而不猜**：面板传的是它渲染出来的序号，错位说明界面已过期，
 * 这时候「尽力而为地删一条」比拒绝更危险——用户会以为删的是他点的那条。
 *
 * `expected` 是**身份校验**（可选但强烈建议调用方给）：面板把它渲染出来的那一行原文传进来，
 * 与当前第 `at` 条不一致就拒绝。为什么需要它：`index` 是**位置**语义，不是身份语义——
 * 同一次渲染里连点两次「删除」（或一次重试）在旧实现下会**多删一条**
 * （第一次删掉第 2 条后，原来的第 3 条补位成了第 2 条）。带上原文就把位置语义升级成身份语义。
 */
export function removeWorkflowItem(projectRoot, projectName, index, expected) {
  const at = Number(index)
  if (!Number.isInteger(at) || at < 1) {
    return { ok: false, error: '序号必须是 1 起的整数', hint: '面板按渲染出来的编号传 index' }
  }
  const located = workflowTarget(projectRoot, projectName)
  if (located.ok !== true) return located
  const { mainDoc, text } = located
  const { fields, body } = parseFrontMatter(text)
  const items = readWorkflow(body)
  if (at > items.length) {
    return { ok: false, error: `工作流只有 ${items.length} 条，删不了第 ${at} 条`, hint: '面板可能已过期，重新打开面板再试' }
  }
  const changed = items[at - 1]
  if (typeof expected === 'string' && expected.trim() !== '' && expected.trim() !== changed) {
    return {
      ok: false,
      error: `第 ${at} 条已经不是你点的那条了（现在是「${changed}」）`,
      hint: '面板显示的列表已过期：重新打开面板再删，避免误删。',
    }
  }
  const nextItems = items.filter((_item, i) => i !== at - 1)
  const nextArchive = [...parseWorkflowArchive(fields), changed]
  try {
    writeWorkflowDoc(mainDoc, text, nextItems, nextArchive)
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, mainDoc, changed, workflow: nextItems, workflowArchive: normalizeArchiveCapped(nextArchive) }
}

/**
 * 把归档里第 `index` 条（**1 起**）恢复回 `## 工作流`。
 *
 * 恢复时若工作流已满 5 条，会挤掉最旧的一条。**被挤掉的那条要重新进归档**——
 * 这是本函数唯一容易写错的地方（v0.14.0 初版就在这里丢过数据）：
 * 被挤掉的是**工作流里的活条目**，它从来不在归档里，所以「它本来就在归档里」是错的，
 * 直接丢弃 = 用户点一下「恢复」就永久少一条规则，而且界面上什么都不会说。
 * 现在的做法：挤掉谁就把谁追加回归档（归档本身有 ≤10 条上限，满了会顶掉最旧的归档项，
 * 这是有界账本应有的行为），并在返回值里如实报 `evicted` 让面板显示出来。
 */
export function restoreWorkflowItem(projectRoot, projectName, index) {
  const at = Number(index)
  if (!Number.isInteger(at) || at < 1) {
    return { ok: false, error: '序号必须是 1 起的整数', hint: '面板按渲染出来的编号传 index' }
  }
  const located = workflowTarget(projectRoot, projectName)
  if (located.ok !== true) return located
  const { mainDoc, text } = located
  const { fields, body } = parseFrontMatter(text)
  const archive = parseWorkflowArchive(fields)
  if (at > archive.length) {
    return { ok: false, error: `归档只有 ${archive.length} 条，恢复不了第 ${at} 条`, hint: '面板可能已过期，重新打开面板再试' }
  }
  const restored = archive[at - 1]
  const items = readWorkflow(body)
  if (items.includes(restored)) {
    return { ok: false, error: '这条已经在工作流里了', hint: '同一条不重复恢复' }
  }
  const merged = [...items, restored]
  const evicted = merged.length > ENTRY_CAPS.workflow ? merged.slice(0, merged.length - ENTRY_CAPS.workflow) : []
  const nextItems = evicted.length > 0 ? merged.slice(merged.length - ENTRY_CAPS.workflow) : merged
  // 先摘掉被恢复的那条，再把被挤掉的追加回去：被挤掉的条目回到「可恢复」状态。
  const nextArchive = [...archive.filter((_item, i) => i !== at - 1), ...evicted]
  try {
    writeWorkflowDoc(mainDoc, text, nextItems, nextArchive)
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return {
    ok: true,
    mainDoc,
    changed: restored,
    evicted,
    // 归档里现在有它 → 面板可以告诉用户「被挤掉的那条已回到归档，还能恢复」。
    evictedRecoverable: evicted.length > 0,
    workflow: nextItems,
    workflowArchive: normalizeArchiveCapped(nextArchive),
  }
}

/** 定位主文档并读出来；项目不存在或读不出来时返回 `{ ok:false }`（不抛错）。 */
function workflowTarget(projectRoot, projectName) {
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readText(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }
  return { ok: true, mainDoc, text }
}

/**
 * 读主文档全文（供面板的「主文档」只读查看）。
 *
 * 面板查看是**只读**的（用户裁定）：主文档的形状由 `puzzle_mode` 统一维护，
 * 面板给一个能编辑的框就等于开了第二条写入通道，条目限长 / 条数上限 / slug 过滤
 * 全部会被绕过——那正是「文档锁」要防的事。所以这里只回原文，不回任何编辑入口。
 */
export function readMainDoc(projectRoot, projectName) {
  const located = workflowTarget(projectRoot, projectName)
  if (located.ok !== true) return located
  const { mainDoc, text } = located
  const { fields, body } = parseFrontMatter(text)
  return {
    ok: true,
    mainDoc,
    text,
    workflow: readWorkflow(body),
    workflowArchive: parseWorkflowArchive(fields),
    version: docVersion(text),
    outdated: docVersion(text) < PUZZLE_VERSION,
  }
}

/* --------------------------------- 状态读取 --------------------------------- */

export function moduleEntries(puzzleDir, modules, projectText) {
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
      // 该模块文档**自己引用到的源码文件**（从 `（源码: lib/x.js:12）` 里抽）。
      // 审查做模块级源码判决时据此过滤：只拿这个模块真的指到的文件去扣分，
      // 否则每个模块都会继承同一份项目级硬伤，8 个模块的分会被拉平成一模一样。
      citedFiles: text === null ? [] : citedSourceFiles(body),
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
  // 模式判定**必须带文档版本**：v4 及更早的 `边拼边写` 是「一轮做完才问」的旧含义，
  // 归一成 `写后再拼`。不带版本会让每个旧项目在插件升级那一刻静默跳进高强度模式。
  const docVer = docVersion(text)
  const rawMode = normalizeMode(fields['模式'], docVer)
  const declaredMode = rawMode === null ? null : rawMode
  // 旧名字被归一过（`模式: 边拼边写` 但文档是 v4）→ 如实标出来，
  // 面板与工具返回都能看见「这个项目其实还没迁移」，而不是悄悄换个名字继续跑。
  const modeRenamed = declaredMode !== null && typeof fields['模式'] === 'string' && fields['模式'].trim() !== declaredMode
  const dimensions = dimensionAverages(modules)

  const state = {
    ...base,
    initialized: true,
    degraded: base.degraded,
    project: typeof fields['项目'] === 'string' && fields['项目'].trim() !== '' ? fields['项目'].trim() : slug,
    mode: declaredMode ?? DEFAULT_MODE,
    modeSource: declaredMode === null ? 'default' : 'front-matter',
    /** true 表示 front-matter 里写的是旧名字，已按旧含义（写后再拼）读。 */
    modeRenamed,
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
    /** 主文档五节里不合规的条目（超长 / 无出处），供审查点名。 */
    mainEntryIssues: entryIssuesIn(body, MAIN_ENTRY_SPEC),
    /**
     * `## 工作流` 的条目（纯文本，已去 `- ` 前缀）与归档。
     *
     * 面板直接拿这两份渲染，模型也靠它知道「这个项目现在有哪些行为约束」——
     * 提示段只讲规则，具体约束是每个项目自己的，必须从文档读。
     *
     * 归档走 `normalizeArchiveCapped` **在读取侧也裁一次**：≤10 是契约，
     * 手改文档（或旧版本写进来的）可能超限，读出来就超限等于契约在读取侧不成立。
     */
    workflow: readWorkflow(body),
    workflowArchive: normalizeArchiveCapped(parseWorkflowArchive(fields)),
    // 规范之外的小节（主文档 + 各模块）：审查据此报 unknown_section。
    // 它们既读不进任何 op、也不会被写入覆盖，只能靠 rebuild 清掉——
    // 所以必须**可见**，否则就是「删不掉又看不见」（实测踩过）。
    extraMainSections: extraSectionsIn(body, SECTION_ORDER.map((key) => SECTION_HEADINGS[key])),
    extraModuleSections: modules.flatMap((module) => (
      extraSectionsIn(readText(module.file) ?? '', MODULE_SECTION_ORDER)
        .map((heading) => ({ name: module.name, heading }))
    )),
    goal: (body.split(/\r?\n/).find((line) => line.startsWith('> 目标：')) ?? '').replace(/^>\s*目标：/, '').trim(),
  }
  // 审查发现要同时看模块证据与主文档小节，所以在状态装配完成后再算。
  state.findings = auditOf(state)
  /**
   * 可执行修复清单：把客观发现翻译成「改哪个文件、怎么改、预期效果」。
   *
   * 审查已从「拆代码 / 看文档真实值」升级成**执行方**（用户裁定）：先出清单、
   * 用 `ask_user_question` 问过用户，再动手改源码。
   *
   * 这里传 `null` 作为体检结果：`readState` 是**每个 op 都会走的热路径**，
   * 而源码体检要递归遍历源码目录。所以状态里只带「文档级」清单（条目不合规、
   * 规范外小节、虚高分），**结构级清单**（大文件、巨函数、目录分层）由 `op:audit`
   * 单独算——那一轮本来就要做体检，顺手把清单算全，不额外付一次遍历。
   */
  state.fixPlan = fixPlanOf(state, null)
  return state
}

/**
 * 读某个模块文档的正文小节（供 UI 点开图块看详情，以及模型按需回读）。
 * 文件不存在时返回 exists:false，不抛错、不建文件。
 */


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
      reuse: null,
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
    reuse: (getSection(body, MODULE_SECTION_HEADINGS.reuse) ?? '').trim(),
    detail: (getSection(body, MODULE_SECTION_HEADINGS.detail) ?? '').trim(),
  }
}

/* --------------------------------- 写入 --------------------------------- */

/** 从 front-matter 里安全读出模块清单（坏 JSON 当空数组）。 */


/** 只改主文档的行为字段（模式 / 模块清单），保留其余内容。 */
export function setMainFields(text, patch) {
  const { fields, body } = parseFrontMatter(text)
  const carried = passThroughFields(fields, text)
  const next = {
    puzzle: carried.puzzle,
    project: patch.project ?? fields['项目'] ?? '',
    mode: patch.mode ?? carried.mode,
    modules: patch.modules ?? safePlanned(fields),
    // 绑定必须透传：这两个函数会整份重写 front-matter，漏一次就把绑定丢了。
    sessions: patch.sessions ?? parseSessionList(fields),
    // 源码根同理必须透传：漏一次，审查就找不到源码（退化成「查不到」）。
    sourceRoot: patch.sourceRoot ?? parseSourceRoot(fields),
    // 归档同理：漏一次，「一键删除可回滚」就在任意一次改模式 / 改源码根之后失效。
    workflowArchive: patch.workflowArchive ?? parseWorkflowArchive(fields),
    updated: timestamp(),
  }
  if (!Array.isArray(next.modules)) next.modules = []
  // patch.mode 是调用方给的**当前名字**（setMode 已按 MODES 校验过），所以按当前版判。
  if (normalizeMode(next.mode) === null) next.mode = DEFAULT_MODE
  return `${formatFrontMatter(next)}\n${body.replace(/^\n+/, '')}`
}

/**
 * 会话绑定的读侧：扫项目根，返回这个会话绑定的项目名；没绑定返回 null。
 *
 * **只认 front-matter，不猜**：找不到就是 null。早先「回退到最新项目」正是文档混成一团的根因。
 */


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


/** 把主文档的会话列表改成给定的一份（其余 front-matter 字段原样保留）。 */
export function writeSessionList(mainDoc, text, sessions) {
  try {
    const { fields, body } = parseFrontMatter(text)
    const carried = passThroughFields(fields, text)
    const next = [
      formatFrontMatter({
        puzzle: carried.puzzle,
        project: fields["项目"] ?? "",
        mode: carried.mode,
        modules: safePlanned(fields),
        sessions: normalizeSessions(sessions),
        sourceRoot: parseSourceRoot(fields),
        workflowArchive: parseWorkflowArchive(fields),
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
 * v4 起五节都有**字数上限**；除 `index`（指向模块文档）与 `workflow`（约束模型行为）外，
 * 每条还必须带源码出处（`ENTRY_LIMITS`）：
 * 校验不过就整次拒绝（不截断——半句话落进文档比报错更糟）。
 * `index` 小节是模块清单，条目格式不同，只做字数校验。
 */


/**
 * 更新主文档的一个小节；index 小节同时刷新 front-matter 的模块清单。
 *
 * v4 起五节都有**字数上限**；除 `index`（指向模块文档）与 `workflow`（约束模型行为）外，
 * 每条还必须带源码出处（`ENTRY_LIMITS`）：
 * 校验不过就整次拒绝（不截断——半句话落进文档比报错更糟）。
 * `index` 小节是模块清单，条目格式不同，只做字数校验。
 */
export function updateMainSection(projectRoot, projectName, section, content, append = true) {
  if (!SECTION_KEYS.has(section)) {
    return { ok: false, error: `未知小节 ${section}`, hint: `可用：${SECTION_ORDER.join(' / ')}（主文档只有这五节）` }
  }
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readText(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }

  // 模块索引指向的是模块文档（`模块/X.md` 就是回查路径），所以只限长、不强制 `（源码: …）`。
  // `workflow` 同理不强制出处，而且**连占位过滤都要用自己的那一套**（见 normalizeWorkflowEntries）：
  // 复用模块文档的 `normalizeEntries` 会把以括号开头的合法规则静默吞掉。
  const requireSource = section !== 'index' && section !== 'workflow'
  const checked = section === 'workflow'
    ? normalizeWorkflowEntries(content)
    : normalizeEntries(content, ENTRY_LIMITS[section], undefined, requireSource)
  if (checked.ok !== true) return { ok: false, error: checked.error, hint: checked.hint }

  const { fields, body } = parseFrontMatter(text)
  let nextBody = applySection(body, SECTION_HEADINGS[section], checked.text, append !== false)
  let dropped = []
  // 工作流的 5 条上限与 `## 悬而未决`（4 条）同属硬规则：超了**删最旧**。
  // 与模块小节不同，这里**不把删掉的条目进归档**——走 `op:main` 写工作流是模型的行为，
  // 模型看得见自己写了几条；「一键删除可回滚」是面板那条路（`op:workflow` / RPC workflow）。
  // 两条路的语义分开，免得「模型追加一条」意外把用户删掉的旧条目捞回归档。
  const cap = ENTRY_CAPS[section]
  if (cap !== undefined) {
    // **数条目必须用「这一节自己的规则」**：工作流用 `readWorkflow`（只认自己的占位行），
    // 其余小节用 `entryLines`。这里曾经对工作流也调 `entryLines`，而它带着**模块文档**的
    // `PLACEHOLDER_PATTERNS`（「待补」「轮汇报」「可被别处复用」「最多 N 条」）——后果有两个，
    // 都很糟：① 以括号开头的合法规则被当成占位行，数出 0 条 → 整节被替换成占位行，
    // 规则**静默消失**，而返回值还报 `ok:true`；② 8 条规则里 3 条被当占位 → 只数到 5 条，
    // 判定「没超上限」→ 5 条硬上限被绕过（实测留下 8 条）。
    const all = section === 'workflow'
      ? readWorkflow(parseFrontMatter(nextBody).body)
      : entryLines(getSection(parseFrontMatter(nextBody).body, SECTION_HEADINGS[section]) ?? '')
    if (all.length > cap) {
      const kept = all.slice(all.length - cap)
      dropped = all.slice(0, all.length - cap).map((line) => (line.startsWith('- ') ? line : '- ' + line))
      // 工作流走 `writeWorkflow`：它保证「写空」与「新建」得到同一种形状（占位行）。
      nextBody = section === 'workflow'
        ? writeWorkflow(nextBody, kept)
        : withSection(nextBody, SECTION_HEADINGS[section], kept.join('\n'))
    } else if (all.length === 0) {
      // 空工作流**不能留一个光秃秃的 `## 工作流`**：那看着像坏了，而且 `op:rebuild`
      // 只在「小节不存在」时补占位——标题已经在，它就永远修不回来。
      // 这里复用 `writeWorkflow` 的占位逻辑，保证「写空」和「新建」得到同一种形状。
      nextBody = section === 'workflow'
        ? writeWorkflow(nextBody, [])
        : nextBody
    }
  }
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
      mode: modeOfFields(fields, docVersion(text)),
      modules: planned ?? safePlanned(fields),
      sessions: parseSessionList(fields),
      sourceRoot: parseSourceRoot(fields),
      workflowArchive: parseWorkflowArchive(fields),
      updated: timestamp(),
    }),
    nextBody.replace(/^\n+/, ''),
  ].join('\n')
  try {
    atomicWrite(mainDoc, next)
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, mainDoc, section, entries: checked.incoming, dropped }
}

/**
 * 更新（必要时创建）模块文档的一个小节。
 *
 * `points` / `pending` / `decided` / `detail` 都是**条目式**小节：
 * 每条限字数、必须带源码出处；`pending` ≤4、`decided` ≤10，超限**删最旧**。
 */


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
 * **项目级健康性不写进文档**（主文档只留规范小节，没有它的容身处）：
 * 项目健康性 = 各模块健康性的均值，由宿主汇总，手写只会与事实矛盾。
 */


/**
 * 写模块文档的「健康性」小节。
 *
 * **项目级健康性不写进文档**（主文档只留规范小节，没有它的容身处）：
 * 项目健康性 = 各模块健康性的均值，由宿主汇总，手写只会与事实矛盾。
 */
export function updateProjectHealth() {
  return {
    ok: false,
    error: '项目级健康性不再写进文档',
    hint: '主文档只有 模块索引 / 源码索引 / 工具索引 / 坑 / 工作流 五节。五维请用 op:health 并给 name 写到对应模块文档，项目健康性由宿主按模块均值汇总。',
  }
}

/** 写模式（主文档 front-matter）。 */


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

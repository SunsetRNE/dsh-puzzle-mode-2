/**
 * 项目级读写：建/绑/解绑、写小节、写健康性、汇总状态。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PUZZLE_DIR, MAIN_FILE, MODULE_DIR, MODES, DEFAULT_MODE, PUZZLE_VERSION, HEALTH_HEADING, SECTION_ORDER, SECTION_HEADINGS, SECTION_KEYS, MODULE_SECTION_KEYS, MODULE_SECTION_HEADINGS, ENTRY_LIMITS, ENTRY_CAPS } from './constants.js'
import { listFiles, isFile, clampPercent, slugify, timestamp } from './util.js'
import { safeJoin, puzzleDirOf, atomicWrite, readText } from './docfs.js'
import { formatFrontMatter, parseFrontMatter, normalizeSessions, parseSessionList, parseSourceRoot, getSection, withSection, applySection, docVersion, safePlanned } from './frontmatter.js'
import { entryLines, normalizeEntries, entryIssuesIn, MAIN_ENTRY_SPEC, MODULE_ENTRY_SPEC } from './entries.js'
import { HEALTH_KEYS, healthOf, projectHealthOf, dimensionAverages } from './health.js'
import { sectionCounts, auditOf } from './audit.js'
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
  const declaredMode = MODES.includes(fields['模式']) ? fields['模式'] : null
  const dimensions = dimensionAverages(modules)

  const state = {
    ...base,
    initialized: true,
    degraded: base.degraded,
    project: typeof fields['项目'] === 'string' && fields['项目'].trim() !== '' ? fields['项目'].trim() : slug,
    mode: declaredMode ?? DEFAULT_MODE,
    modeSource: declaredMode === null ? 'default' : 'front-matter',
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
    /** 主文档四节里不合规的条目（超长 / 无出处），供审查点名。 */
    mainEntryIssues: entryIssuesIn(body, MAIN_ENTRY_SPEC),
    goal: (body.split(/\r?\n/).find((line) => line.startsWith('> 目标：')) ?? '').replace(/^>\s*目标：/, '').trim(),
  }
  // 审查发现要同时看模块证据与主文档小节，所以在状态装配完成后再算。
  state.findings = auditOf(state)
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
    detail: (getSection(body, MODULE_SECTION_HEADINGS.detail) ?? '').trim(),
  }
}

/* --------------------------------- 写入 --------------------------------- */

/** 从 front-matter 里安全读出模块清单（坏 JSON 当空数组）。 */


/** 只改主文档的行为字段（模式 / 模块清单），保留其余内容。 */
export function setMainFields(text, patch) {
  const { fields, body } = parseFrontMatter(text)
  const next = {
    puzzle: fields.puzzle ?? 1,
    project: patch.project ?? fields['项目'] ?? '',
    mode: patch.mode ?? fields['模式'] ?? DEFAULT_MODE,
    modules: patch.modules ?? safePlanned(fields),
    // 绑定必须透传：这两个函数会整份重写 front-matter，漏一次就把绑定丢了。
    sessions: patch.sessions ?? parseSessionList(fields),
    // 源码根同理必须透传：漏一次，审查就找不到源码（退化成「查不到」）。
    sourceRoot: patch.sourceRoot ?? parseSourceRoot(fields),
    updated: timestamp(),
  }
  if (!Array.isArray(next.modules)) next.modules = []
  if (!MODES.includes(next.mode)) next.mode = DEFAULT_MODE
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
    const next = [
      formatFrontMatter({
        puzzle: fields.puzzle ?? 1,
        project: fields["项目"] ?? "",
        mode: MODES.includes(fields["模式"]) ? fields["模式"] : DEFAULT_MODE,
        modules: safePlanned(fields),
        sessions: normalizeSessions(sessions),
        sourceRoot: parseSourceRoot(fields),
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
 * v3 起四节都有**字数上限**且每条必须带源码出处（`ENTRY_LIMITS`）：
 * 校验不过就整次拒绝（不截断——半句话落进文档比报错更糟）。
 * `index` 小节是模块清单，条目格式不同，只做字数校验。
 */


/**
 * 更新主文档的一个小节；index 小节同时刷新 front-matter 的模块清单。
 *
 * v3 起四节都有**字数上限**且每条必须带源码出处（`ENTRY_LIMITS`）：
 * 校验不过就整次拒绝（不截断——半句话落进文档比报错更糟）。
 * `index` 小节是模块清单，条目格式不同，只做字数校验。
 */
export function updateMainSection(projectRoot, projectName, section, content, append = true) {
  if (!SECTION_KEYS.has(section)) {
    return { ok: false, error: `未知小节 ${section}`, hint: `可用：${SECTION_ORDER.join(' / ')}（主文档只有这四节）` }
  }
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readText(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }

  // 模块索引指向的是模块文档（`模块/X.md` 就是回查路径），所以只限长、不强制 `（源码: …）`。
  const checked = normalizeEntries(content, ENTRY_LIMITS[section], undefined, section !== 'index')
  if (checked.ok !== true) return { ok: false, error: checked.error, hint: checked.hint }

  const { fields, body } = parseFrontMatter(text)
  const nextBody = applySection(body, SECTION_HEADINGS[section], checked.text, append !== false)
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
      mode: MODES.includes(fields['模式']) ? fields['模式'] : DEFAULT_MODE,
      modules: planned ?? safePlanned(fields),
      sessions: parseSessionList(fields),
      sourceRoot: parseSourceRoot(fields),
      updated: timestamp(),
    }),
    nextBody.replace(/^\n+/, ''),
  ].join('\n')
  try {
    atomicWrite(mainDoc, next)
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, mainDoc, section, entries: checked.incoming }
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
 * **项目级健康性不写进文档**（v3 起主文档只有四节，没有它的容身处）：
 * 项目健康性 = 各模块健康性的均值，由宿主汇总，手写只会与事实矛盾。
 */


/**
 * 写模块文档的「健康性」小节。
 *
 * **项目级健康性不写进文档**（v3 起主文档只有四节，没有它的容身处）：
 * 项目健康性 = 各模块健康性的均值，由宿主汇总，手写只会与事实矛盾。
 */
export function updateProjectHealth() {
  return {
    ok: false,
    error: '项目级健康性不再写进文档',
    hint: '主文档只有 模块索引 / 源码索引 / 工具索引 / 坑 四节。五维请用 op:health 并给 name 写到对应模块文档，项目健康性由宿主按模块均值汇总。',
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

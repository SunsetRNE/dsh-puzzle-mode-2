/**
 * 源码工程化体检：文件行数/函数长度/文件数/目录分层。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { PUZZLE_DIR, MAIN_FILE } from './constants.js'
import { listFiles, isFile, clampPercent, average } from './util.js'
import { puzzleDirOf, readText } from './docfs.js'
import { parseFrontMatter, parseSourceRoot } from './frontmatter.js'
import { HEALTH_DIMENSIONS, HEALTH_KEYS } from './health.js'


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
export const SOURCE_RULES = {
  /** 单文件行数上限：超过就该考虑拆。800 行是「明显偏大」，2000 行是「必须拆」。 */
  fileLinesWarn: 800,
  fileLinesFail: 2000,
  /** 单函数行数上限：超过就难读、难测、难改。 */
  functionLinesWarn: 60,
  functionLinesFail: 150,
  /** 一个目录里源码文件少于这个数，且总行数很大 → 是「一个文件装下整个项目」。 */
  fewFilesMax: 3,
  /** 源码总行数超过这个值才谈「工程化」（小脚本不必套这套）。 */
  totalLinesMin: 400,
}

/** 这些目录不算「项目源码」：依赖、产物、版本库、文档目录。 */


/** 这些目录不算「项目源码」：依赖、产物、版本库、文档目录。 */
export const SOURCE_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.cache',
  '.next', 'vendor', 'target', 'tmp', '.tmp', PUZZLE_DIR, '拼图',
])

/** 算作源码的后缀。 */


/** 算作源码的后缀。 */
export const SOURCE_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.sh']


export function isSourceFile(name) {
  const lower = String(name).toLowerCase()
  return SOURCE_EXTS.some((ext) => lower.endsWith(ext))
}


export function countLines(text) {
  if (typeof text !== 'string' || text === '') return 0
  return text.split(/\r?\n/).length
}

/**
 * 递归收集源码文件（限深度，避免钻进深层依赖）。
 *
 * 只读不写；任何读不了的目录直接跳过（不抛错）——审查不该因为一个坏软链就整个失败。
 */


/**
 * 递归收集源码文件（限深度，避免钻进深层依赖）。
 *
 * 只读不写；任何读不了的目录直接跳过（不抛错）——审查不该因为一个坏软链就整个失败。
 */
export function collectSourceFiles(root, maxDepth = 6) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    for (const entry of listFiles(dir)) {
      if (entry.startsWith('.') && entry !== '.github') continue
      if (SOURCE_SKIP_DIRS.has(entry)) continue
      const full = join(dir, entry)
      let stat
      try {
        stat = statSync(full)
      } catch (_error) {
        continue
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!stat.isFile() || !isSourceFile(entry)) continue
      const text = readText(full)
      if (text === null) continue
      out.push({ file: full, name: entry, lines: countLines(text), text })
    }
  }
  walk(root, 0)
  return out
}

/**
 * 粗估最长函数：按「行首缩进 + 上一行以 `{`/`=>` 结尾」起算，遇到同级或更浅的 `}` 收尾。
 *
 * 这是**启发式**，不是语法分析（不引依赖）。它对「一坨几百行的大函数」足够敏感，
 * 对回调嵌套会高估——所以只用来报警，不用来卡人。
 */


/**
 * 粗估最长函数：按「行首缩进 + 上一行以 `{`/`=>` 结尾」起算，遇到同级或更浅的 `}` 收尾。
 *
 * 这是**启发式**，不是语法分析（不引依赖）。它对「一坨几百行的大函数」足够敏感，
 * 对回调嵌套会高估——所以只用来报警，不用来卡人。
 */
export function longestFunction(lines) {
  let best = { lines: 0, at: 0 }
  let start = -1
  let startIndent = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()
    // 函数起点：以 `{` 结尾，或箭头函数体，或 `function` 开头。
    const opensBlock = /[{(]\s*$/.test(trimmed) || /=>\s*$/.test(trimmed) || /^\s*(export\s+)?(async\s+)?function\b/.test(line)
    if (start < 0 && opensBlock) {
      start = i
      startIndent = indent
      continue
    }
    // 收尾：回到不深于起点的 `}`（或 `})` 等）。
    if (start >= 0 && indent <= startIndent && /^[}\]);,]+$/.test(trimmed)) {
      const size = i - start + 1
      if (size > best.lines) best = { lines: size, at: start + 1 }
      start = -1
    }
  }
  return best
}

/**
 * 体检一个项目的源码工程化程度。**只读**，返回可量化的客观事实。
 *
 * `sourceRoot` 优先级：显式参数 > 主文档 front-matter 的 `源码根:` > 拼图目录的上一级。
 *
 * 为什么要三级：**文档目录与源码目录常常不是同一处**。本项目实测：文档在
 * `/sdcard/dsha222/拼图模式插件/拼图/`，源码在 `/root/.dsh/plugin-src/dsh-puzzle-mode/`。
 * 找不到源码时**如实说「没查到」**，而不是把 0 个文件当成「代码很干净」。
 */


/**
 * 体检一个项目的源码工程化程度。**只读**，返回可量化的客观事实。
 *
 * `sourceRoot` 优先级：显式参数 > 主文档 front-matter 的 `源码根:` > 拼图目录的上一级。
 *
 * 为什么要三级：**文档目录与源码目录常常不是同一处**。本项目实测：文档在
 * `/sdcard/dsha222/拼图模式插件/拼图/`，源码在 `/root/.dsh/plugin-src/dsh-puzzle-mode/`。
 * 找不到源码时**如实说「没查到」**，而不是把 0 个文件当成「代码很干净」。
 */
export function inspectSource(projectRoot, projectName, sourceRoot = '') {
  const projectDir = puzzleDirOf(projectRoot, projectName)
  if (projectDir === null) return { ok: false, error: '项目名不合法' }
  let recorded = ''
  try {
    const mainDoc = join(projectDir, MAIN_FILE)
    if (isFile(mainDoc)) recorded = parseSourceRoot(parseFrontMatter(readText(mainDoc) ?? '').fields)
  } catch (_error) {
    recorded = ''
  }
  const explicit = typeof sourceRoot === 'string' ? sourceRoot.trim() : ''
  const base = resolve(explicit !== '' ? explicit : (recorded !== '' ? recorded : resolve(projectDir, '..')))
  let baseOk = false
  try {
    baseOk = statSync(base).isDirectory()
  } catch (_error) {
    baseOk = false
  }
  if (!baseOk) {
    return {
      ok: false,
      base,
      error: '源码目录不存在或读不了：' + base,
      hint: '把源码根记进主文档（op:source 带 path），或调用时显式给 sourceRoot。',
    }
  }
  const files = collectSourceFiles(base)
  if (files.length === 0) {
    return {
      ok: true,
      base,
      fileCount: 0,
      totalLines: 0,
      files: [],
      largest: null,
      oversized: [],
      longestFunction: null,
      dirs: [],
      findings: [],
      note: '在 ' + base + ' 下没有找到源码文件。**这不代表代码没问题，只代表没查到**——'
        + '源码若在别处，请用 op:audit 的 sourceRoot 参数指过去。',
    }
  }

  const totalLines = files.reduce((sum, item) => sum + item.lines, 0)
  const sorted = files.slice().sort((left, right) => right.lines - left.lines)
  const oversized = files
    .filter((item) => item.lines >= SOURCE_RULES.fileLinesWarn)
    .map((item) => ({ file: item.file, name: item.name, lines: item.lines }))
    .sort((left, right) => right.lines - left.lines)

  // 目录分层：看源码落在几个不同目录里。
  const dirSet = new Set(files.map((item) => {
    const rel = item.file.slice(base.length + 1)
    const at = rel.lastIndexOf(sep)
    return at < 0 ? '.' : rel.slice(0, at)
  }))
  const dirs = [...dirSet].sort()

  // 最长函数：只对最大的那个文件算（大文件里才最可能藏着巨函数）。
  const biggest = sorted[0]
  const fn = longestFunction(biggest.text.split(/\r?\n/))

  const findings = []
  // 规则一：单文件过大。
  for (const item of oversized) {
    const level = item.lines >= SOURCE_RULES.fileLinesFail ? 'fail' : 'warn'
    findings.push({
      id: 'source_big_file',
      level,
      // `file` 只给「能归到某一个文件」的发现。模块级真实值靠它做过滤：
      // 没有 `file` 的是**项目级**事实（如「只有 3 个文件」），只算在项目头上。
      file: item.name,
      fact: item.name + ' 有 ' + item.lines + ' 行（阈值 ' + SOURCE_RULES.fileLinesWarn + ' 行' + (level === 'fail' ? '，硬上限 ' + SOURCE_RULES.fileLinesFail : '') + '）。',
      fix: '按职责拆成多个文件：一个文件只做一件事。先拆出纯逻辑（无 IO）、再拆出 IO、最后留薄薄一层入口。',
    })
  }
  // 规则二：一个文件装下整个项目。
  if (files.length <= SOURCE_RULES.fewFilesMax && totalLines >= SOURCE_RULES.totalLinesMin) {
    findings.push({
      id: 'source_too_few_files',
      level: 'fail',
      fact: '整个项目只有 ' + files.length + ' 个源码文件，却共 ' + totalLines + ' 行（' + dirs.length + ' 个目录）。',
      fix: '这是「一个文件装下整个项目」的形态：模型改任何一处都要先读完整文件，施工难度与出错率都会陡增。先按职责切成 4-8 个文件。',
    })
  }
  // 规则三：巨函数。
  if (fn.lines >= SOURCE_RULES.functionLinesWarn) {
    findings.push({
      id: 'source_long_function',
      level: fn.lines >= SOURCE_RULES.functionLinesFail ? 'fail' : 'warn',
      file: biggest.name,
      fact: biggest.name + ' 第 ' + fn.at + ' 行起有一个约 ' + fn.lines + ' 行的函数（阈值 ' + SOURCE_RULES.functionLinesWarn + ' 行）。',
      fix: '把函数体按步骤拆成几个小函数，每步一个名字——名字就是文档，也是可测试点。',
    })
  }
  // 规则四：没有目录分层。
  if (files.length >= 6 && dirs.length === 1) {
    findings.push({
      id: 'source_flat',
      level: 'warn',
      fact: files.length + ' 个源码文件全在同一层目录（' + dirs[0] + '）。',
      fix: '按角色分目录（如 lib/ 纯逻辑、bin/ 入口、test/ 测试），让「东西该放哪」有答案。',
    })
  }

  return {
    ok: true,
    base,
    fileCount: files.length,
    totalLines,
    files: sorted.map((item) => ({ name: item.name, lines: item.lines })),
    largest: { name: biggest.name, lines: biggest.lines },
    oversized,
    longestFunction: { file: biggest.name, at: fn.at, lines: fn.lines },
    dirs,
    avgLines: Math.round(totalLines / files.length),
    findings,
  }
}

/* --------------------------------- 五维真实性 --------------------------------- */

/**
 * 五维「真实值」的评估：**由证据算，不由模型声明**。
 *
 * 为什么需要它（用户原话：模型只会在任务完成后提高值，可这是虚假的，
 * 因为他并不清楚自己写出的代码好坏）：
 * `## 健康性` 里手写的分数是**自评**——模型刚写完代码，天然觉得自己写得好，
 * 于是把分数调高。而「可拓展性」「可维护性」这种维度，恰恰是**代码本身**才能回答的。
 *
 * 所以这里做两件事：
 *   1. 用**文档证据 + 源码体检**算出每一维的真实值（`evidenceScore`）；
 *   2. 与手写值比对，差得离谱就报「虚高」（`inflation`），并给出真实值让模型改。
 *
 * 关键设计：**只有能测的才计入**。没有源码就不硬编一个分，而是标注 `unmeasured`——
 * 「没测」和「测出来是 0」是两回事，混在一起又会变成假数字。
 */

/** 每个维度会被哪些源码发现扣分（按 finding id 匹配，**不按文案匹配**）。 */


/* --------------------------------- 五维真实性 --------------------------------- */

/**
 * 五维「真实值」的评估：**由证据算，不由模型声明**。
 *
 * 为什么需要它（用户原话：模型只会在任务完成后提高值，可这是虚假的，
 * 因为他并不清楚自己写出的代码好坏）：
 * `## 健康性` 里手写的分数是**自评**——模型刚写完代码，天然觉得自己写得好，
 * 于是把分数调高。而「可拓展性」「可维护性」这种维度，恰恰是**代码本身**才能回答的。
 *
 * 所以这里做两件事：
 *   1. 用**文档证据 + 源码体检**算出每一维的真实值（`evidenceScore`）；
 *   2. 与手写值比对，差得离谱就报「虚高」（`inflation`），并给出真实值让模型改。
 *
 * 关键设计：**只有能测的才计入**。没有源码就不硬编一个分，而是标注 `unmeasured`——
 * 「没测」和「测出来是 0」是两回事，混在一起又会变成假数字。
 */

/** 每个维度会被哪些源码发现扣分（按 finding id 匹配，**不按文案匹配**）。 */
export const SOURCE_HITS = {
  extensibility: ['source_big_file', 'source_too_few_files', 'source_flat'],
  maintenance: ['source_long_function', 'source_big_file'],
  quality: ['source_big_file', 'source_too_few_files', 'source_long_function', 'source_flat'],
  // 任务复杂度与可复用性不由源码体检扣分：前者是中性事实，后者要看有没有抽公共件，
  // 靠行数判断不了。宁可少扣，也不编一个说不清理由的分。
  complexity: [],
  reusability: [],
}

/** 源码体检结果 → 对五维的修正（文案给人看）。 */


/** 源码体检结果 → 对五维的修正（文案给人看）。 */
export function sourceVerdicts(inspection) {
  const out = {}
  for (const key of HEALTH_KEYS) out[key] = []
  if (inspection === null || inspection === undefined || inspection.ok !== true) return out
  for (const item of (inspection.findings ?? [])) {
    for (const key of HEALTH_KEYS) {
      if (!(SOURCE_HITS[key] ?? []).includes(item.id)) continue
      out[key].push(item.fact)
    }
  }
  return out
}

/**
 * 由「文档证据 + 源码体检」算出五维真实值（0-100）。
 *
 * 与 `HEALTH_DIMENSIONS[].derive` 的区别：`derive` 只看文档条数（要点/详细记录/决策/坑），
 * 回答的是「文档写全了没有」；这里额外把**源码体检**算进来，回答的是
 * 「代码本身撑不撑得住这个分数」。两者都算，取**较低**的那个——
 * 文档写得漂亮但代码是一坨，真实值就该被代码拖下来。
 */


/**
 * 由「文档证据 + 源码体检」算出五维真实值（0-100）。
 *
 * 与 `HEALTH_DIMENSIONS[].derive` 的区别：`derive` 只看文档条数（要点/详细记录/决策/坑），
 * 回答的是「文档写全了没有」；这里额外把**源码体检**算进来，回答的是
 * 「代码本身撑不撑得住这个分数」。两者都算，取**较低**的那个——
 * 文档写得漂亮但代码是一坨，真实值就该被代码拖下来。
 */
export function trueHealthOf({ evidence = {}, inspection = null, declared = {}, hasSource = false, files = null }) {
  const scores = {}
  const reasons = {}
  const verdictsByDim = sourceVerdicts(inspection)
  // 模块级调用会传 `files`（该模块文档自己引用到的文件）。不传 = 项目级，算全部。
  // 没有这个过滤的话，每个模块都会拿到同一份项目级判决——8 个模块的分会一模一样，
  // 还会把「client.js 1303 行」记到「会话绑定」头上，那是编出来的因果。
  //
  // 两类发现分开处理：
  //   - `file` 有值 → 文件级，模块引用了这个文件才吃这条扣分；
  //   - `file` 无值 → 项目级（如「只有 3 个文件」「全在同一层目录」），
  //     **只算在项目头上**。把它摊给每个模块同样是编因果：某个模块文档没指任何代码，
  //     却因为整个项目文件少而被扣分，说不通。
  const scoped = (inspection?.findings ?? []).filter((item) => {
    if (files === null || files === undefined) return true
    if (item.file === undefined) return false
    return files.includes(item.file)
  })
  // 模块文档一条源码出处都没写 → 源码这一侧**没测到**，不能当成「干净」。
  // 「没测」和「测出来没问题」是两回事，混在一起就是又一个假数字。
  const measured = hasSource && (files === null || files === undefined || files.length > 0)
  for (const dimension of HEALTH_DIMENSIONS) {
    const fromDoc = dimension.derive(evidence)
    const hitIds = SOURCE_HITS[dimension.key] ?? []
    // 源码有硬伤就按条扣：每条 fail 扣 25、warn 扣 10，扣到底 0。
    let penalty = 0
    const verdicts = []
    for (const item of scoped) {
      if (!hitIds.includes(item.id)) continue
      penalty += item.level === 'fail' ? 25 : 10
      verdicts.push(item.fact)
    }
    const fromSource = measured ? clampPercent(100 - penalty) : null
    // 取较低值：文档与源码任一说不行，就不给高分。
    const value = fromSource === null ? fromDoc : Math.min(fromDoc, fromSource)
    scores[dimension.key] = value
    reasons[dimension.key] = {
      fromDoc,
      fromSource,
      verdicts,
      note: fromSource === null
        ? (hasSource
          ? '这个模块的文档没有引用到任何源码文件，源码这一侧**没测**——这一维只由文档证据推出，不是实测值。'
          : '没有源码可查，这一维只由文档证据推出——**不是实测值**。')
        : (fromSource < fromDoc ? '源码比文档差，取源码那一侧。' : '文档与源码一致，或文档那一侧更严。'),
    }
    // 手写值明显高于真实值 → 虚高。
    const declaredValue = declared[dimension.key]
    if (typeof declaredValue === 'number' && declaredValue - value >= 15) {
      reasons[dimension.key].inflation = {
        declared: declaredValue,
        trueValue: value,
        gap: declaredValue - value,
      }
    }
  }
  return { scores, reasons, health: average(HEALTH_KEYS.map((key) => scores[key])), verdicts: verdictsByDim }
}

/* --------------------------------- 状态读取 --------------------------------- */

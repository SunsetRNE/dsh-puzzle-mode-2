/**
 * 审查：规则化事实（findings）+ 写提示词。**只给事实，不给分数结论**。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { join } from 'node:path'
import { PUZZLE_VERSION, SECTION_ORDER, SECTION_HEADINGS, MODULE_SECTION_HEADINGS, ENTRY_CAPS } from './constants.js'
import { finding } from './util.js'
import { getSection } from './frontmatter.js'
import { countItems } from './entries.js'
import { HEALTH_DIMENSIONS, HEALTH_KEYS, DIMENSION_FIX, dimensionName, evidenceOf } from './health.js'


/** 给模型照着写点评的指令。**不生成点评本身**——那是模型的事。 */
export const AUDIT_PROMPT = [
  '现在按五维写审查，**并把分数改成真实值**（这是审查的目的，不只是评论）。',
  '',
  '### 一、先说事实（不要空话）',
  '1. 先点名**最弱的一维**、它落在哪个模块，再逐条列问题；每条问题后面必须带数字或文档事实。',
  '2. 允许直说：写「这一维的分数是自己封的」都不过分，只要事实对得上。',
  '3. 每条问题配一条**可执行的下一步**（动哪个 op、写哪一节）。',
  '',
  '### 二、把虚高的分改回真实值（必做）',
  '返回里的 `inflation` 数组就是「你之前自评的分数」与「真实值」的差额，逐条列好了：',
  '`declared` 是手写值，`trueValue` 是**由文档证据 + 源码体检算出来的**，`because` 是差在哪。',
  '- 对每一条，用 `puzzle_mode{op:"health", name:"<模块名>", content:"<维度名>: <trueValue>…", append:false}`',
  '  **把该模块的分改成 `trueValue`**——一次把该模块五维都写上，别只改被点名的那一维。',
  '- 全局值不用手写（项目健康性 = 各模块均值，宿主汇总）；改完模块，全局自然跟着降。',
  '- **不许反过来**：不要为了保住高分去改文档凑证据。分数是结论，不是目标。',
  '',
  '### 三、工程化问题要真的动代码',
  '`source` 里是源码体检事实（文件行数、最长函数、目录分层）。`source_*` 类问题',
  '**改分数解决不了**——那是代码结构的问题，必须真的拆文件 / 拆函数：',
  '- 单文件超 800 行 → 按职责拆；超 2000 行（fail）→ 必须先拆再谈别的。',
  '- 巨函数（>60 行）→ 按步骤拆成几个小函数，名字就是文档。',
  '- 「一个文件装下整个项目」→ 先切成 4-8 个文件。',
  '拆完再跑一次 `op:audit`，真实值应当自己回升——**靠拆代码涨的分才是真的**。',
  '',
  '### 四、两类条目级发现优先清',
  '`entry_issue` / `main_entry_issue` 说明条目本身不合规格（超字数，或缺 `（源码: 文件:行）`）。',
  '修法固定：`op:main` / `op:module` 带 `append:false` 重写那一节。',
  '',
  '### 五、诚实边界',
  '- 某维 `fromSource` 是 `null` 表示**没有源码可查**，那一维不是实测值——要如实说，不要当成测过了。',
  '- 最后一句整体判断：这个项目现在最该补的一件事是什么。',
].join('\n')


/** 主文档各节的证据条数（去掉空行与模板占位）。 */
export function sectionCounts(body) {
  const out = {}
  for (const key of SECTION_ORDER) out[key] = countItems(getSection(body, SECTION_HEADINGS[key]) ?? '')
  return out
}

/** 五维按分数升序排列——审查先说最弱的那一维。 */


/** 五维按分数升序排列——审查先说最弱的那一维。 */
export function dimensionRanking(dimensions) {
  const source = dimensions !== null && typeof dimensions === 'object' ? dimensions : {}
  return HEALTH_KEYS
    .map((key) => ({ key, name: dimensionName(key), value: source[key] ?? 0 }))
    .sort((left, right) => left.value - right.value)
}


/**
 * 把当前状态过一遍，输出**客观发现清单**。只陈述事实，不做评价。
 *
 * 不抛错：状态缺字段一律按 0 处理（未初始化的项目也会走到这里）。
 */
export function auditOf(state) {
  const safe = state !== null && typeof state === 'object' ? state : {}
  const modules = Array.isArray(safe.modules) ? safe.modules : []
  const sections = safe.sections !== null && typeof safe.sections === 'object' ? safe.sections : {}
  const dimensions = safe.dimensions !== null && typeof safe.dimensions === 'object' ? safe.dimensions : {}
  const findings = []

  // 旧格式先报：它是「数字可能偏低」的上游原因，排在其它发现前面。
  if (safe.outdated === true) {
    findings.push(finding('doc_outdated', 'warn', null, 'project',
      '文档格式是 puzzle ' + (safe.version ?? '?') + '，当前是 ' + PUZZLE_VERSION + '：旧格式主文档有六个小节（含已取消的 用户原话 / 撤销），模块文档缺 ## 悬而未决 / ## 已定，五维只能靠推导，分数会偏低。',
      "用 op:rebuild 看预览（默认 dry-run），确认后 apply:true 迁移；它只改形状，正文不动。"))
  }

  if (modules.length === 0) {
    findings.push(finding('no_modules', 'blocker', null, 'project',
      '项目里一个模块都没有，五维无从算起，项目健康性是 0。',
      '用 op:init 带 modules 一次建齐，或用 op:module 建第一个模块。'))
  }

  // 规范之外的小节：主文档只允许四节、模块文档只允许固定几节。
  // 必须**报出来**——它们既读不进任何 op，也不会被写入覆盖，只能靠 rebuild 清掉；
  // 不报就等于默认它们不存在（实测就是这么漏掉的）。
  for (const name of Array.isArray(safe.extraMainSections) ? safe.extraMainSections : []) {
    findings.push(finding('unknown_section:main:' + name, 'warn', null, 'project',
      '主文档有一个规范之外的小节「' + name + '」：它不属于四节，op:main 写不到它，也不会被覆盖。',
      '用 op:rebuild 迁移（它会删掉非规范小节）；内容若有用，先搬进四节之一或对应的模块文档。'))
  }
  for (const item of Array.isArray(safe.extraModuleSections) ? safe.extraModuleSections : []) {
    findings.push(finding('unknown_section:' + item.name + ':' + item.heading, 'warn', null, item.name,
      '模块「' + item.name + '」有一个规范之外的小节「' + item.heading + '」：op:module 写不到它。',
      '用 op:rebuild 迁移（它会删掉非规范小节）；内容若有用，先搬进规范小节。'))
  }

  // 主文档只剩四节，其中「坑」是所有模块共用的项目级证据。
  if ((sections.pit ?? 0) === 0) {
    findings.push(finding('pit_empty', 'warn', 'quality', 'project',
      '主文档「坑」0 条：踩过的坑没有沉淀下来，代码质量这一维只能靠模块的「已定」撑。',
      DIMENSION_FIX.quality))
  }
  if ((sections.source ?? 0) === 0) {
    findings.push(finding('source_empty', 'info', null, 'project',
      '主文档「源码索引」0 条：查找方向是 主文档 → 源码，索引为空就只能靠翻目录。',
      '把关键实现文件用 op:main section:source 记进去（一句话 + 源码: 文件:行）。'))
  }
  if ((sections.tools ?? 0) === 0) {
    findings.push(finding('tools_empty', 'info', null, 'project',
      '主文档「工具索引」0 条：本项目用到的 op / 脚本 / 外部命令没有一处索引。',
      '把常用入口用 op:main section:tools 记进去（一句话 + 源码: 文件:行）。'))
  }

  // 主文档的条目也逐条验：四节里任何一条超长/无出处，都是 v3 规格破了。
  // 只报**条数与样例**，不逐条刷屏。
  for (const issue of Array.isArray(safe.mainEntryIssues) ? safe.mainEntryIssues : []) {
    const parts = []
    if (issue.tooLong > 0) parts.push(issue.tooLong + ' 条超 ' + issue.limit + ' 字')
    if (issue.noSource > 0) parts.push(issue.noSource + ' 条没出处')
    findings.push(finding('main_entry_issue:' + issue.key, 'warn', null, 'project',
      '主文档「' + issue.heading + '」有 ' + parts.join('、') + '（例：' + issue.sample + '…）。',
      '用 op:main section:' + issue.key + ' append:false 重写这一节：每条一句话（≤' + issue.limit + ' 字）+（源码: 文件:行）。'))
  }

  // 「五维全靠公式推」的模块先收集起来：全都如此时只报一条，免得刷屏。
  const unreviewed = []
  for (const module of modules) {
    const name = String(module.name ?? '?')
    const counts = module.counts ?? {}
    const evidence = module.evidence ?? {}
    const progress = module.progress

    if (module.exists !== true) {
      findings.push(finding('module_missing:' + name, 'warn', null, name,
        '模块「' + name + '」只有图块、没有文档，五维全 0。',
        '用 op:module name:' + name + ' section:points 写下第一段事实。'))
      continue
    }

    // 已存在的条目不受写入校验约束（迁移不追溯），所以这里逐条查——
    // 否则「要点 15 条」看着充实，实则 15 条全超长且全无出处。
    for (const issue of Array.isArray(module.entryIssues) ? module.entryIssues : []) {
      const parts = []
      if (issue.tooLong > 0) parts.push(issue.tooLong + ' 条超 ' + issue.limit + ' 字')
      if (issue.noSource > 0) parts.push(issue.noSource + ' 条没出处')
      findings.push(finding('entry_issue:' + name + ':' + issue.key, 'warn', null, name,
        '模块「' + name + '」的「' + issue.heading + '」有 ' + parts.join('、') + '。',
        '用 op:module name:' + name + ' section:' + issue.key + ' append:false 重写这一节：每条一句话（≤'
        + issue.limit + ' 字）+（源码: 文件:行）。'))
    }

    const content = (counts.points ?? 0) + (evidence.detail ?? 0) + (counts.pending ?? 0) + (counts.decided ?? 0)
    if (content === 0) {
      findings.push(finding('module_empty:' + name, 'blocker', null, name,
        '模块「' + name + '」文档里 0 条要点、0 条详细记录、0 条决策：五维全 0。',
        '先补 ## 要点（2-3 条事实），再补 ## 详细记录；空文档没有健康性可谈。'))
    } else if ((counts.pending ?? 0) === 0 && (counts.decided ?? 0) === 0) {
      findings.push(finding('no_open_questions:' + name, 'warn', 'extensibility', name,
        '模块「' + name + '」既没有悬而未决也没有已定：可拓展性拿不到分。',
        DIMENSION_FIX.extensibility))
    }

    // 上限是硬规则（悬而未决 ≤4 / 已定 ≤10），超了就是没按规则删旧的。
    for (const key of ['pending', 'decided']) {
      const cap = ENTRY_CAPS[key]
      const count = counts[key] ?? 0
      if (count <= cap) continue
      findings.push(finding('over_cap:' + name + ':' + key, 'warn', 'extensibility', name,
        '模块「' + name + '」的「' + MODULE_SECTION_HEADINGS[key] + '」有 ' + count + ' 条，超过上限 ' + cap + ' 条。',
        '写入时会自动删最旧的，保留末尾 ' + cap + ' 条；也可以自己先用 op:module section:' + key + ' append:false 重写一份。'))
    }

    if (typeof progress === 'number' && progress >= 80 && (counts.points ?? 0) === 0) {
      findings.push(finding('progress_no_points:' + name, 'blocker', 'maintenance', name,
        '模块「' + name + '」完成度写 ' + progress + '，但要点 0 条。',
        '要么把要点补上（完成度才有依据），要么把完成度改成真实值。'))
    }

    for (const dimension of HEALTH_DIMENSIONS) {
      const source = (module.healthSources ?? {})[dimension.key]
      if (source !== 'module' && source !== 'project') continue
      if (evidenceOf(evidence, dimension.key) > 0) continue
      const score = (module.healthScores ?? {})[dimension.key] ?? 0
      findings.push(finding('declared_without_evidence:' + name + ':' + dimension.key, 'warn', dimension.key, name,
        '模块「' + name + '」的「' + dimension.name + '」手写了 ' + score + ' 分，但对应证据 0 条。',
        DIMENSION_FIX[dimension.key]))
    }

    const allDerived = HEALTH_KEYS.every((key) => (module.healthSources ?? {})[key] === 'derived')
    if (allDerived && module.health > 0) unreviewed.push(name)
  }

  if (unreviewed.length > 0) {
    const scope = unreviewed.length === modules.length && modules.length > 0 ? 'project' : unreviewed.join('、')
    findings.push(finding('never_reviewed', 'info', null, scope,
      unreviewed.length + ' 个模块的五维全是公式推出来的，没有一处人工判断：' + unreviewed.join('、') + '。',
      '对最弱的一维写显式分数并说明理由（## 健康性 里写「维度名: 分数」）。'))
  }

  const ranking = dimensionRanking(dimensions)
  if (modules.length > 0 && ranking[0].value < 100) {
    findings.push(finding('weakest_dimension', 'info', ranking[0].key, 'project',
      '最弱一维是「' + ranking[0].name + '」= ' + ranking[0].value + '%（跨模块均值）。',
      DIMENSION_FIX[ranking[0].key]))
  }

  // 源码工程化的发现**不在这里**：`auditOf` 由 `readState` 调用，而 `op:read` 每轮都跑，
  // 不该每次都去扫源码树。源码体检只在 `op:audit` 里做，发现由调用方并进返回。
  return findings
}

/* ------------------------------- 版本与迁移 ------------------------------- */

/** 读一份文档的 front-matter 版本；缺失或坏值都按 1（最早的那版）。 */

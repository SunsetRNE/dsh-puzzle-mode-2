/**
 * 给工具面与 UI 面的精简摘要。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { PUZZLE_DIR, EXECUTABLE_MODES, PAUSE_QUESTION, PAUSE_OPTIONS, PUZZLE_VERSION } from './constants.js'
import { HEALTH_DIMENSIONS } from './health.js'


/* --------------------------------- 汇总输出 --------------------------------- */

/** 每次返回都带上的固定收尾问（三处口径一致：提示段 / 工具返回 / UI 模板）。 */
export function pauseFields() {
  return { askPause: true, pauseQuestion: PAUSE_QUESTION, pauseOptions: PAUSE_OPTIONS }
}

/** 五维的元信息（名字 + 方向），让模型知道每一维是什么、往哪边算好。 */


/** 五维的元信息（名字 + 方向），让模型知道每一维是什么、往哪边算好。 */
export function dimensionMeta() {
  return HEALTH_DIMENSIONS.map((dimension) => ({ key: dimension.key, name: dimension.name, hint: dimension.hint }))
}

/**
 * 工具返回给模型的最小事实集（不序列化任何宿主对象）。
 *
 * `brief: true` 是**接续会话用的精简档**：去掉每模块的五维明细与来源、去掉五维元信息表，
 * 只留「有哪些模块、各自健康性、健康性总分、下一步该读什么」。
 * 本项目实测：全量 2916 字符 → 精简档约 1000 字符（模块明细占原本的 67%）。
 * 要明细再 `op:show` 看单个模块，不必一次把六个模块的分数全塞进上下文。
 */
export function summarize(state, extra = {}, brief = false) {
  if (state.initialized !== true) {
    return {
      ok: true,
      initialized: false,
      projectRoot: state.projectRoot,
      error: state.error ?? null,
      // `project` 即使为空也要给：面板靠它区分「未绑定」与「绑定的项目名叫空」。
      project: state.project ?? '',
      hint: `本会话还没绑定拼图项目：用 op=init 并显式给 project 一次创建（目录 ${'<工作区>/<项目名>/' + PUZZLE_DIR}/），或用面板的建项目按钮`,
      dimensions: dimensionMeta(),
      findingCount: 0,
      ...pauseFields(),
      ...extra,
    }
  }
  const modules = state.modules.map((module) => (brief
    ? { name: module.name, exists: module.exists, health: module.health, progress: module.progress }
    : {
      name: module.name,
      exists: module.exists,
      health: module.health,
      dimensions: module.healthScores,
      sources: module.healthSources,
      progress: module.progress,
      counts: module.counts,
    }))
  return {
    ok: true,
    initialized: true,
    degraded: state.degraded === true,
    projectRoot: state.projectRoot,
    projectDir: state.puzzleDir,
    mainDoc: state.mainDoc,
    project: state.project,
    /** 文档格式版本与「是否旧格式」：旧格式要 op:rebuild 迁移，别当它是当前形状。 */
    version: state.version ?? PUZZLE_VERSION,
    outdated: state.outdated === true,
    mode: state.mode,
    modeSource: state.modeSource ?? 'default',
    /**
     * front-matter 里写的是**旧名字**（v4 及更早的 `边拼边写` = 一轮做完才问），
     * 已按 `写后再拼` 读。面板与模型都该看见它——否则用户会以为「我选的是边拼边写」。
     */
    modeRenamed: state.modeRenamed === true,
    /** 项目健康性 = 各模块五维健康性的均值。 */
    health: state.health,
    // 精简档用**中文维度名**：说明表（dimensionMeta）在精简档里被去掉了，
    // 再给英文 key 就等于给了数字不给图例。全量档保持英文 key（面板按 key 取数）。
    dimensions: brief
      ? Object.fromEntries(HEALTH_DIMENSIONS.map((dimension) => [dimension.name, (state.dimensions ?? {})[dimension.key] ?? 0]))
      : state.dimensions,
    // 五维元信息表有 372 字符，作用是给第一次接触的模型解释「每维什么意思」；
    // 接续会话的精简档不需要，省下来。
    ...(brief ? {} : { dimensionMeta: dimensionMeta() }),
    /**
     * 审查发现**不塞进这里**：`op:read` 是模型每轮都会调的，要精简。
     * 想看完整发现走 `op:audit`；面板则走 RPC 的 `state`（它自己附上）。
     * 这里只给一个数量，好让模型知道「有东西可审」。
     */
    findingCount: Array.isArray(state.findings) ? state.findings.length : 0,
    sections: state.sections ?? {},
    /**
     * 工作流：主文档 `## 工作流` 的**流水线块**（`[{name, steps}]`）。
     *
     * 必须**每轮都给**（不进 brief 的裁剪）：提示段只讲规则、不讲具体流程，
     * 而工作流是每个项目自己的。模型看不到它，这条功能就等于不存在。
     */
    workflow: Array.isArray(state.workflow) ? state.workflow : [],
    workflowArchiveCount: Array.isArray(state.workflowArchive) ? state.workflowArchive.length : 0,
    modules,
    updated: state.updated ?? null,
    canExecute: isExecutableMode(state.mode),
    // 接续会话的第一步就是「按需读」：把该读什么直接写进返回，省一次摸索。
    ...(brief
      ? {
        readNext: [
          '只读主文档（查找入口，五节：模块索引 / 源码索引 / 工具索引 / 坑 / 工作流）：' + (state.mainDoc ?? ''),
          '再按本轮要动的地方只读一个模块文档；不确定读哪个就问用户，别通读模块目录。',
          '需要看实现时按主文档的「源码索引」直接跳源码。',
        ],
        hint: '这是精简档（brief）。要每模块的五维明细用 op:read 且不带 brief；单个模块的正文用 op:show。',
      }
      : {}),
    ...pauseFields(),
    ...extra,
  }
}

/** `op:'list'` 的返回：所有项目 + 哪个是「不给 project 时的默认」。 */


/** `op:'list'` 的返回：所有项目 + 哪个是「不给 project 时的默认」。 */
export function summarizeList(projectRoot, projects) {
  return {
    ok: true,
    initialized: projects.length > 0,
    projectRoot,
    projectCount: projects.length,
    projects,
    defaultProject: projects.length > 0 ? projects[0].name : null,
    hint: projects.length > 0
      ? '多个项目并存时请在调用里显式给 project，否则默认用最新的那个。'
      : '项目根下还没有拼图项目，用 op=init 新建。',
    ...pauseFields(),
  }
}


/**
 * 这个模式能不能动手。**三模式**（v5 起）：只有 `只拼不写` 不行。
 *
 * 两个可执行模式的差别不在「能不能执行」，而在**什么时候问**：
 * `写后再拼` 一轮做完才问，`边拼边写` 每个写动作前先问。所以这里只答第一层问题，
 * 「问的节奏」由提示段交给模型（宿主不去数它问了没——那是行为约束，不是权限）。
 */
export function isExecutableMode(mode) {
  return EXECUTABLE_MODES.includes(mode)
}

/**
 * 所有对外契约常量：目录布局、小节标题、条目限长、五维定义。改这里等于改契约。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */


/** 文档文件夹固定名。 */
export const PUZZLE_DIR = '拼图'

export const MAIN_FILE = '主文档.md'

export const MODULE_DIR = '模块'

/** 三种执行模式。 */


/**
 * 三种执行模式。
 *
 * v5 起从两种拆成三种（用户裁定）：
 *   - `只拼不写`：只提问 + 更新文档，越权工具被宿主 deny；
 *   - `写后再拼`：**旧的「边拼边写」改名而来**——一轮做完才问；
 *   - `边拼边写`：**新名给高强度版**——每个写动作（write/edit/bash…）之前先问，
 *     用户点头才动手。名字与旧的相反是用户刻意要的：旧名名不副实（做完才问），
 *     真·边拼边写才配这个名字。
 *
 * 改名是**破坏性改动**：文档里 `模式: 边拼边写` 在 v4 及更早表示「写后再拼」，
 * 所以 v4→v5 的迁移必须改写它，`normalizeMode()` 负责这件事。
 */
export const MODE_PUZZLE_ONLY = '只拼不写'

export const MODE_PUZZLE_AFTER = '写后再拼'

export const MODE_PUZZLE_WRITE = '边拼边写'

export const MODES = [MODE_PUZZLE_ONLY, MODE_PUZZLE_AFTER, MODE_PUZZLE_WRITE]

/** v5 起「可执行」的模式：除了只拼不写，两个都是。 */
export const EXECUTABLE_MODES = [MODE_PUZZLE_AFTER, MODE_PUZZLE_WRITE]

export const DEFAULT_MODE = MODE_PUZZLE_ONLY

/**
 * 固定收尾问：**每一次提问都必须带上它**。
 * 选项顺序就是建议顺序——「停下」在前且为推荐项。
 */
export const PAUSE_QUESTION = '要不要先停下？'

export const PAUSE_OPTIONS = ['停下，等我看过再说', '继续，不用停']

/**
 * 一轮提问的**问题条数上限**与**每题选项上限**。
 *
 * 为什么要有这两个数、为什么是 10：原先提示段只写「最多 5 问」而**完全不提选项**，
 * 结果模型倾向每题只给 2–3 个选项，用户能点的面太窄——「提问不够全面」就是这么来的。
 * 用户裁定：问题放开到 10 个、选项也放开到 10 个。
 *
 * 这两条**只是提示给模型的软上限**，不是工具侧校验：`ask_user_question` 在 DSH 核心
 * （`dsh-tool-ask-user` / `dsh-user-questions`）里**没有任何数量校验**，UI 也是
 * `options.map(...)` 全渲染、卡片 `max-height: min(60vh, 520px)` 可滚。
 * 所以这里**不写拦截**——真拦了反而会在宿主升级后变成误报。
 * 唯一从这两个数派生的硬约束是收尾问：见 `PAUSE_LINE`，它固定两项。
 */
export const ASK_MAX_QUESTIONS = 10

export const ASK_MAX_OPTIONS = 10

/** 主文档 front-matter 里的会话绑定字段：一个会话只绑一个项目。 */


/** 主文档 front-matter 里的会话绑定字段：一个会话只绑一个项目。 */
export const SESSION_FIELD = '会话'

/**
 * 主文档 front-matter 里的**源码根**字段。
 *
 * 为什么需要它：文档目录与源码目录常常不是同一处。本项目实测：文档在
 * `/sdcard/dsha222/拼图模式插件/拼图/`，源码却在 `/root/.dsh/plugin-src/dsh-puzzle-mode/`。
 * 审查要做源码体检（文件行数、巨函数、目录分层），必须先知道**去哪看代码**。
 * 没记这个字段就退回「拼图目录的上一级」，找不到就如实说「没查到」，不假装干净。
 */
export const SOURCE_ROOT_FIELD = '源码根'

/**
 * 主文档 front-matter 里的**工作流归档**字段（JSON 字符串数组，≤10 条）。
 *
 * 为什么要有它：工作流删除是「一键删除（可回滚）」——删掉的条目不能就地消失，
 * 否则「可回滚」无处可回。归档与工作流正文分离存放，好处是**归档不占用 5 条上限**，
 * 且重建/迁移只需原样透传，不必理解它的语义。
 */
export const WORKFLOW_ARCHIVE_FIELD = '工作流归档'

/**
 * 当前文档格式版本（front-matter 的 `puzzle:` 字段）。
 *
 * **破坏性改动必须 +1，并在 MIGRATIONS 里补一步**——版本号不 +1 的破坏性改动
 * 就是「旧文档静默降级」：读得出来、不报错，但形状已经对不上。
 *
 * v1：`进度/完成度` 单一维度；模块 front-matter 带 `模式:`/`计划模块:`；无 `## 健康性`。
 * v2：五维健康性；模块 front-matter 只留 `项目:`/`模块:`；主文档加 `会话:` 绑定。
 * v3：主文档收敛为四节（模块索引 / 源码索引 / 工具索引 / 坑）；模块拆出
 *     `## 悬而未决`（≤4 条）与 `## 已定`（≤10 条）、去掉勾选框；`## 撤销` 取消；
 *     每条条目限字数且必须带源码出处。
 */


/**
 * 当前文档格式版本（front-matter 的 `puzzle:` 字段）。
 *
 * **破坏性改动必须 +1，并在 MIGRATIONS 里补一步**——版本号不 +1 的破坏性改动
 * 就是「旧文档静默降级」：读得出来、不报错，但形状已经对不上。
 *
 * v1：`进度/完成度` 单一维度；模块 front-matter 带 `模式:`/`计划模块:`；无 `## 健康性`。
 * v2：五维健康性；模块 front-matter 只留 `项目:`/`模块:`；主文档加 `会话:` 绑定。
 * v3：主文档收敛为四节（模块索引 / 源码索引 / 工具索引 / 坑）；模块拆出
 *     `## 悬而未决`（≤4 条）与 `## 已定`（≤10 条）、去掉勾选框；`## 撤销` 取消；
 *     每条条目限字数且必须带源码出处。
 * v4：主文档加**第五节 `## 工作流`**（≤5 条，超了删最旧）：工作流是**约束模型在特定
 *     操作下不去做别的事**的规则，随提示段注入；被删的条目进 front-matter 的
 *     `工作流归档:`（≤10 条），面板可一键恢复单条。
 * v5：执行模式**两种拆三种**并改名——`边拼边写`（旧·一轮做完才问）改名 `写后再拼`，
 *     新 `边拼边写` 表示「每个写动作前先问」。旧文档的 `模式: 边拼边写` 在 v4 及更早
 *     一律按 `写后再拼` 读（`normalizeMode()`），迁移时改写落盘。
 * v6：`## 工作流` **从「扁平约束清单」重定义为「标准化流水线」**（用户原话：工作流就是
 *     工作流程——为完成特定任务，把重复步骤、工具、规则按顺序串成的标准化流水线）。
 *     一条工作流 = 一个 `### 名字` 块，块内逐行有序步骤；不再是 `- 一句话` 的扁平条目。
 *     每条工作流是**一条独立的路**（不互相依赖），所以「改一条」就改那一块，
 *     而不是新加一条。上限 5 条 / 每块 ≤12 步（见 `WORKFLOW_MAX_STEPS`）。
 */
export const PUZZLE_VERSION = 6

/**
 * `边拼边写` 这个名字**换过含义**的那一版。
 *
 * 低于它的文档里 `模式: 边拼边写` 表示「一轮做完才问」（= 现在的 `写后再拼`）；
 * 达到它之后才是「每个写动作前先问」。所有读 `模式:` 的地方都必须带上版本来判定，
 * 否则旧项目会在升级那一刻**静默变成高强度模式**——每次写文件都停下来问，而用户没同意过。
 */
export const MODE_RENAME_VERSION = 5

/**
 * 旧「完成度」折算成五维时的统一折扣。
 *
 * 完成度只说明**做过**，不足以给高分——它是单维自评，而五维问的是复杂度、可拓展性、
 * 可维护性、质量沉淀、可复用性。统一 ×0.5 是刻意的保守，且**不用伪造逐维精度**：
 * 五个不同的系数看着更"准"，其实是凭空编的比例。折算值只是起点，等真实证据写进来就该被替换。
 */
export const PROGRESS_TO_HEALTH = 0.5

/**
 * 只拼不写模式下仍然允许的工具。
 *
 * 拦截点是 `tools/pre-execute`（可返回 `{kind:'deny'}`）——不是 `agent/pre-step`：
 * 后者的 `decision.messages` 契约是 `UserMessage[]`，里面根本没有 tool-call，
 * 在那上面做「剔除 assistant 消息」的拦截是死代码。
 *
 * 注意：文档写入**只能**走 `puzzle_mode` 工具（它做 slug 过滤与路径守卫）。
 * `write` / `edit` 不在白名单里，是有意的——它们能绕过守卫写到拼图目录之外。
 */
export const PUZZLE_ONLY_ALLOWED_TOOLS = ['puzzle_mode', 'read', 'grep', 'glob', 'ask_user_question', 'todo_write']

/* ------------------------------- 项目健康性 ------------------------------- */

/**
 * 五个健康性维度。**全部越高越好**（含「维护系数」——高分表示维护负担轻）。
 *
 * `derive` 是该维度的证据推导：模型没在文档里显式写分数时，用它从文档内容推。
 * 设计原则：**健康性反映的是「已经写在文档里的证据」，不是模型凭感觉打的印象分**。
 * 所以没有文档就没有健康性——空模块五维全 0，而不是"看起来还行给 60"。
 */


/** 模块文档里的健康性小节（项目级五维汇总也写在这里）。 */
export const HEALTH_HEADING = '## 健康性'

/**
 * 主文档固定小节，顺序即模板顺序。
 *
 * v4 起是**五节**：模块索引 / 源码索引 / 工具索引 / 坑 / **工作流**。
 * 用户裁定「工作流写进主文档」——它是唯一一节**写给模型看的行为约束**，
 * 其余四节是查回来的事实。工作流 ≤5 条（`ENTRY_CAPS.workflow`），超了删最旧。
 * 用户原话、悬而未决、已定、撤销一律不写进主文档（用户原话不再入库，
 * 决策写在模块文档里，撤销项直接删除）；轮汇报写进模块文档的 `## 详细记录`。
 */
export const SECTION_ORDER = ['index', 'source', 'tools', 'pit', 'workflow']

export const SECTION_HEADINGS = {
  index: '## 模块索引',
  source: '## 源码索引',
  tools: '## 工具索引',
  pit: '## 坑',
  workflow: '## 工作流',
}

export const HEADING_BY_KEY = SECTION_ORDER.map((key) => [key, SECTION_HEADINGS[key]])

export const SECTION_KEYS = new Set(SECTION_ORDER)

/** v2 的合并小节：迁移时按勾选框拆成 `## 悬而未决` / `## 已定`。 */


/** v2 的合并小节：迁移时按勾选框拆成 `## 悬而未决` / `## 已定`。 */
export const RELATED_HEADING = '## 与本模块相关的悬而未决 / 已定 / 撤销'

/** 模块文档固定小节，顺序即模板顺序（**不再有勾选框**）。 */


/** 模块文档固定小节，顺序即模板顺序（**不再有勾选框**）。 */
export const MODULE_SECTION_KEYS = ['health', 'progress', 'points', 'pending', 'decided', 'reuse', 'detail']

export const MODULE_SECTION_HEADINGS = {
  health: HEALTH_HEADING,
  progress: '## 进度',
  points: '## 要点',
  pending: '## 悬而未决',
  decided: '## 已定',
  reuse: '## 可复用',
  detail: '## 详细记录',
}

export const MODULE_SECTION_ORDER = MODULE_SECTION_KEYS.map((key) => MODULE_SECTION_HEADINGS[key])

/**
 * 一个「规范标题」后面允许跟的说明分隔符。
 *
 * 为什么需要它：文档里出现过 `## 源码索引（src/，共 110 文件 / 18,218 行）` 这种
 * **规范标题 + 说明后缀**的写法。`getSection` 原本是精确匹配，于是它**读不到**那一节，
 * `op:main` 写 `source` 时会另起一个空的 `## 源码索引`——原来的内容还在文件里，
 * 却永远读不出来。所以匹配要容忍后缀，但**只容忍分隔符开头**的：
 * `## 坑与决策` 不会被当成 `## 坑`（`与` 不是分隔符），避免误合并。
 */
export const HEADING_SUFFIX_SEPARATOR = /^[\s（(：:—\-–·]/

/**
 * 单条条目的字数上限（一个字算 1，标点也算）。
 *
 * 计数只算「一句话」，**源码出处不占额度**：条目格式固定为
 *   `- <一句话>（源码: <文件>[:<行>]）`
 * `（源码…` 之前的部分才计入。超限就**拒绝写入**（不是截断）——
 * 截断会把半句话落进文档，比让模型重写一遍更糟。
 */
export const ENTRY_LIMITS = { index: 50, source: 50, tools: 50, pit: 20, workflow: 50, points: 20, pending: 20, decided: 20, reuse: 20, detail: 50 }

/* ------------------------------- 工作流（流水线） ------------------------------- */

/**
 * 一条工作流的**名字**上限（`### 名字` 的标题部分）。
 *
 * 名字是这条路的**标识**：面板用它列图块、归档用它记「删掉的是哪条」。
 * 20 字够写清「干什么」，又不至于长到标题折行。
 */
export const WORKFLOW_NAME_LIMIT = 20

/**
 * 工作流里**单个步骤**的上限。
 *
 * 比名字宽得多（80 字），因为一步要写清「谁 + 用什么工具 + 做什么 + 产出什么」——
 * 这是流水线与「一句话约束」的本质差别：步骤是可执行的，不是口号。
 */
export const WORKFLOW_STEP_LIMIT = 80

/**
 * 一条工作流最多几步。
 *
 * **超了报错，不删最旧**——与 `## 悬而未决` / `## 已定` 的「超了删最旧」相反。
 * 为什么不同：条目是「证据的堆积」，最旧的被顶掉可以接受；而步骤是**一条有序的流水线**，
 * 中间少一步，整条路就断了——静默删步比拒绝写入危险得多。所以这里必须让模型自己精简。
 */
export const WORKFLOW_MAX_STEPS = 12

/**
 * 每模块的条数上限：超了**删最旧**。
 *
 * 条目是追加写的，列表最前面就是最早的，所以保留末尾 N 条。
 */


/**
 * 条数上限：超了**删最旧**（`workflow` 是**整条**删除进归档，见 `lib/project.js`）。
 *
 * `workflow: 5` 现在指「最多 5 条**工作流**」（每条是一整块流水线），不是 5 个步骤。
 * 与 v5 的区别在**语义**：以前 5 条 = 5 句约束，现在 5 条 = 5 条独立的路。
 * 「超了删最旧」在这里是合理的：两条工作流本来就是**并列的两条路**，互不依赖，
 * 顶掉最旧的那条不会让剩下的路断掉（而块内的步骤绝不能这样删，见 `WORKFLOW_MAX_STEPS`）。
 *
 * 条目是追加写的，列表最前面就是最早的，所以保留末尾 N 条。
 */
export const ENTRY_CAPS = { pending: 4, decided: 10, workflow: 5 }

/**
 * 工作流归档的条数上限（front-matter 的 `工作流归档:`）。
 *
 * 与 `workflow` 的 5 条分开计：归档是「删过什么」的账，不是当前生效的规则。
 * 超了同样删最旧——保留最近删掉的 10 条，够回滚又不至于把 front-matter 撑爆。
 */
export const WORKFLOW_ARCHIVE_CAP = 10

/** 条目里源码出处的起始标记。 */


/** 条目里源码出处的起始标记。 */
export const SOURCE_MARK = '（源码'

/** 每个图块的满分（用于 UI 显示 得分/满分）。 */


/** 每个图块的满分（用于 UI 显示 得分/满分）。 */
export const PIECE_MAX = 100

/**
 * 把 front-matter 里读到的 `模式:` 归一成当前三种之一；认不出来就返回 `null`。
 *
 * **必须带版本来判定**（`version` 缺省按当前版）：v4 及更早的 `边拼边写` 是
 * 「一轮做完才问」的旧含义，等于现在的 `写后再拼`。不带版本直接 `MODES.includes()`
 * 会让每个旧项目在插件升级那一刻**静默跳进高强度模式**——模型每次写文件都停下来问，
 * 而用户从没同意过。这条坑是「名字复用」的必然代价，所以判定集中在这一个函数里。
 */
export function normalizeMode(raw, version = PUZZLE_VERSION) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value === '') return null
  if (value === MODE_PUZZLE_WRITE && version < MODE_RENAME_VERSION) return MODE_PUZZLE_AFTER
  return MODES.includes(value) ? value : null
}

/* ---------------------------------- 小工具 ---------------------------------- */

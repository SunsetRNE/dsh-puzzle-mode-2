/**
 * 新建项目时的文档模板。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { join } from 'node:path'
import { DEFAULT_MODE, HEALTH_HEADING, SECTION_HEADINGS, MODULE_SECTION_HEADINGS, ENTRY_LIMITS, ENTRY_CAPS, WORKFLOW_MAX_STEPS } from './constants.js'
import { timestamp } from './util.js'
import { formatFrontMatter, PREAMBLE_LINES } from './frontmatter.js'
import { healthTemplateLines } from './health.js'


/* --------------------------------- 模板 --------------------------------- */

/**
 * 主文档模板：**五节**（模块索引 / 源码索引 / 工具索引 / 坑 / 工作流）。
 *
 * 条目格式固定为「一句话（源码: 文件[:行]）」——查找方向是 主文档 → 源码，
 * 所以每条都得能回查。字数上限见 `ENTRY_LIMITS`（写入时校验，超了报错）。
 *
 * `## 工作流` 是唯一一节**写给模型看的行为流程**（v4 新增，v6 重定义为流水线）：
 * 一条工作流 = 一个 `### 名字` 块，块内按顺序写步骤；≤`ENTRY_CAPS.workflow` 条、
 * 每条 ≤`WORKFLOW_MAX_STEPS` 步。超步数**报错而不是删最旧**（见 `constants.js`）。
 *
 * `currentSessions`（v7）是「本会话的当前项目是这里」：新建项目顺手绑定时，
 * 那个会话当然也以它为新项目的当前项目。
 */
export function mainTemplate(project, modules, goal, mode = DEFAULT_MODE, sessions = [], currentSessions = []) {
  const lines = [
    formatFrontMatter({ project, mode, modules, sessions, currentSessions, updated: timestamp() }),
    `# ${project} · 主文档`,
    '',
    ...PREAMBLE_LINES,
  ]
  if (typeof goal === 'string' && goal.trim() !== '') lines.push('', `> 目标：${goal.trim().replace(/\n+/g, ' ')}`)
  lines.push('', SECTION_HEADINGS.index)
  if (modules.length === 0) lines.push('- （尚未拆分模块）')
  for (const module of modules) lines.push(`- 模块：${module} —— （一句话职责，${ENTRY_LIMITS.index} 字内） —— 模块/${module}.md`)
  for (const key of ['source', 'tools', 'pit']) lines.push('', SECTION_HEADINGS[key], '- （待补）')
  lines.push(
    '',
    SECTION_HEADINGS.workflow,
    `- （在这里写你的流水线：一条一个 \`### 名字\` 块，块内按顺序写步骤；`
      + `最多 ${ENTRY_CAPS.workflow} 条、每条 ≤${WORKFLOW_MAX_STEPS} 步）`,
  )
  return `${lines.join('\n')}\n`
}

/**
 * 模块文档模板：`## 悬而未决` 与 `## 已定` 是两个独立小节（**不用勾选框**）。
 *
 * 悬而未决 ≤4 条、已定 ≤10 条，超限时写入会自动删最旧的（见 `ENTRY_CAPS`）。
 */
export function moduleTemplate(module) {
  return [
    formatFrontMatter({ project: module, module, updated: timestamp() }),
    `# ${module}`,
    '',
    HEALTH_HEADING,
    healthTemplateLines(),
    '- （五维都是 0-100、**越高越好**；留空则由文档内容推导，想覆盖就填数字）',
    '',
    MODULE_SECTION_HEADINGS.progress,
    '完成度: 0',
    '',
    MODULE_SECTION_HEADINGS.points,
    `- （该模块的关键结论；一句话 ${ENTRY_LIMITS.points} 字内 + 源码: 文件:行）`,
    '',
    MODULE_SECTION_HEADINGS.pending,
    `- （还没定的，最多 ${ENTRY_CAPS.pending} 条，超了删最旧；一句话 + 源码出处）`,
    '',
    MODULE_SECTION_HEADINGS.decided,
    `- （已定的，最多 ${ENTRY_CAPS.decided} 条，超了删最旧；一句话 + 源码出处）`,
    '',
    MODULE_SECTION_HEADINGS.reuse,
    `- （可被别处复用的接口 / 共享模块；一句话 ${ENTRY_LIMITS.reuse} 字内 + 源码: 文件:行）`,
    '',
    MODULE_SECTION_HEADINGS.detail,
    `- （轮汇报：一条一句话 ${ENTRY_LIMITS.detail} 字内 + 源码: 文件:行）`,
    '',
  ].join('\n')
}

/* --------------------------------- 路径与落盘 --------------------------------- */

/** 把相对路径拼到 root 下，并确认结果没有逃出 root。 */

/**
 * dsh-puzzle-mode —— 纯逻辑层（无 Cordis 依赖，可单独 import）。
 *
 * v0.11.0 起本文件是 **barrel**：真正的实现按职责拆在同目录下的
 *   constants / util / docfs / frontmatter / entries / health /
 *   audit / source / migrate / templates / project / summary
 * 里，这里只做 re-export，保证 `./puzzle.js` 这个入口不变。
 *
 * 依赖是单向的（按下面 import 顺序）：constants → util → docfs →
 * frontmatter → entries → health → audit → source → migrate →
 * templates → project → summary。新代码请放进对应文件，别塞回这里。
 */
export { PUZZLE_DIR, MAIN_FILE, MODULE_DIR, MODE_PUZZLE_ONLY, MODE_PUZZLE_WRITE, MODES, DEFAULT_MODE, PAUSE_QUESTION, PAUSE_OPTIONS, SESSION_FIELD, SOURCE_ROOT_FIELD, PUZZLE_VERSION, PROGRESS_TO_HEALTH, PUZZLE_ONLY_ALLOWED_TOOLS, HEALTH_HEADING, SECTION_ORDER, SECTION_HEADINGS, RELATED_HEADING, MODULE_SECTION_KEYS, MODULE_SECTION_HEADINGS, MODULE_SECTION_ORDER, ENTRY_LIMITS, ENTRY_CAPS, SOURCE_MARK, PIECE_MAX } from './constants.js'
export { slugify, defaultProjectName, timestamp } from './util.js'
export { safeJoin, puzzleDirOf, isPuzzleDocPath, DOC_MUTATING_TOOLS, docMutationTarget, atomicWrite } from './docfs.js'
export { formatFrontMatter, parseFrontMatter, parseSessionList, parseSourceRoot, getSection, sectionMap, withSection, applySection, docVersion, headingMatches, extraSectionsIn, PREAMBLE_LINES } from './frontmatter.js'
export { entryBody, charCount, checkEntry, normalizeEntries, entryIssuesIn, citedSourceFiles } from './entries.js'
export { HEALTH_DIMENSIONS, HEALTH_KEYS, healthLines, healthTemplateLines, parseHealthDeclarations, healthOf, projectHealthOf, dimensionAverages, DIMENSION_FIX } from './health.js'
export { AUDIT_PROMPT, sectionCounts, dimensionRanking, auditOf } from './audit.js'
export { SOURCE_RULES, collectSourceFiles, longestFunction, inspectSource, sourceVerdicts, trueHealthOf } from './source.js'
export { pendingMigrations, planRebuild, rebuildProject } from './migrate.js'
export { mainTemplate, moduleTemplate } from './templates.js'
export { listProjects, projectSummaries, readState, readModuleDetail, setMainFields, boundProject, unbindSession, bindSession, createProject, updateMainSection, updateModuleSection, updateProjectHealth, setMode, setSourceRoot } from './project.js'
export { dimensionMeta, summarize, summarizeList, isExecutableMode } from './summary.js'
export { SETTINGS_FILE, settingsDir, settingsPath, readSettings, disableForNewSessions, enableForAllSessions, isDisabledFor } from './settings.js'

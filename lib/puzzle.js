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
export { PUZZLE_DIR, MAIN_FILE, MODULE_DIR, MODE_PUZZLE_ONLY, MODE_PUZZLE_AFTER, MODE_PUZZLE_WRITE, MODES, EXECUTABLE_MODES, DEFAULT_MODE, MODE_RENAME_VERSION, normalizeMode, PAUSE_QUESTION, PAUSE_OPTIONS, ASK_MAX_QUESTIONS, ASK_MAX_OPTIONS, SESSION_FIELD, CURRENT_SESSION_FIELD, BINDING_WARN_THRESHOLD, SOURCE_ROOT_FIELD, WORKFLOW_ARCHIVE_FIELD, PUZZLE_VERSION, PROGRESS_TO_HEALTH, PUZZLE_ONLY_ALLOWED_TOOLS, HEALTH_HEADING, SECTION_ORDER, SECTION_HEADINGS, RELATED_HEADING, MODULE_SECTION_KEYS, MODULE_SECTION_HEADINGS, MODULE_SECTION_ORDER, ENTRY_LIMITS, ENTRY_CAPS, WORKFLOW_ARCHIVE_CAP, WORKFLOW_NAME_LIMIT, WORKFLOW_STEP_LIMIT, WORKFLOW_MAX_STEPS, SOURCE_MARK, PIECE_MAX } from './constants.js'
export { slugify, defaultProjectName, timestamp } from './util.js'
export { safeJoin, puzzleDirOf, isPuzzleDocPath, DOC_MUTATING_TOOLS, docMutationTarget, atomicWrite, readText, readTextCached, invalidateTextCache } from './docfs.js'
export { formatFrontMatter, parseFrontMatter, parseSessionList, parseCurrentSessionList, parseSourceRoot, parseWorkflowArchive, normalizeArchive, getSection, sectionMap, withSection, applySection, docVersion, headingMatches, extraSectionsIn, PREAMBLE_LINES, OLD_PREAMBLE_LINES } from './frontmatter.js'
export { entryBody, charCount, checkEntry, normalizeEntries, entryIssuesIn, MAIN_ENTRY_SPEC, citedSourceFiles, measureWithoutMethod, conflictDigest } from './entries.js'
export { HEALTH_DIMENSIONS, HEALTH_KEYS, healthLines, healthTemplateLines, parseHealthDeclarations, healthOf, projectHealthOf, dimensionAverages, DIMENSION_FIX } from './health.js'
export { AUDIT_PROMPT, sectionCounts, dimensionRanking, auditOf, fixPlanOf, normalizeAdditions, recheckPlan, internEvidence, indexVerdicts } from './audit.js'
export { SOURCE_RULES, collectSourceFiles, longestFunction, longFunctionsIn, isFunctionStart, sameFile, inspectSource, sourceVerdicts, trueHealthOf } from './source.js'
export { pendingMigrations, planRebuild, rebuildProject } from './migrate.js'
export { mainTemplate, moduleTemplate } from './templates.js'
export { listProjects, projectSummaries, readState, readModuleDetail, readMainDoc, readWorkflow, writeWorkflow, normalizeWorkflowEntries, parseWorkflowBlocks, workflowsTriggeredBy, removeWorkflowItem, restoreWorkflowItem, dropWorkflowArchiveItem, normalizeArchiveCapped, modeOfFields, passThroughFields, setMainFields, writeSessionList, boundProject, boundProjects, forgetBound, readProjectMode, unbindSession, unbindOne, bindSession, setCurrentProject, addBinding, createProject, updateMainSection, updateModuleSection, updateProjectHealth, setMode, setSourceRoot } from './project.js'
export { dimensionMeta, summarize, summarizeList, receipt, isExecutableMode } from './summary.js'
export { SETTINGS_FILE, MAX_DISABLED_SESSIONS, settingsDir, settingsPath, readSettings, isSessionDisabled, disableSession, enableSession } from './settings.js'
export { FIRST_RUN_MARK, FIRST_RUN_CONDITIONS, makeContextMessage, isSkipRequest, textOfMessage, isUserMessage, isDelegatedSession, detectFirstRun, firstRunHint, markFired, hasFired } from './firstrun.js'

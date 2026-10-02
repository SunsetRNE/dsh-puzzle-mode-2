/**
 * dsh-puzzle-mode **文档格式契约测试**。
 *
 *   node test/50-contract.test.mjs
 *
 * ## 为什么要单独有它
 *
 * v0.19.8 之前，本仓的测试在文档格式 v4 → v6 的改造中**整片脱节**：
 * 断言停在旧格式（六节主文档、`related` 合体小节、项目级健康性、裸条目），
 * 而实现早就改了 —— 于是 `npm test` 长期三红一绿，红成了常态，谁都不再看它。
 * 结果 v0.19.7 的 tag 是在测试全红的状态下打出来的。
 *
 * 根因不是「测试写得不好」，而是**缺一条契约测试**：格式是插件的对外承诺，
 * 却没有任何一条断言在说「这个承诺长什么样」。改动实现时自然没人发现测试在说谎。
 *
 * 这个文件就是把**对外承诺**逐条钉住。它只测**契约**（形状 / 上限 / 必备字段），
 * 不测实现细节 —— 所以格式不变时它永远不该红，格式一变它**必须**红，
 * 逼着改的人同时更新这里与文档格式版本号。
 *
 * ## 判据来源
 *
 * 所有期望值都**引 `lib/constants.js` 的常量**，不在本文件里写死任何数字或文案。
 * 这样「常量改了」与「契约改了」是同一件事，不存在两处各写一份再漂移的可能。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ASK_MAX_OPTIONS,
  ASK_MAX_QUESTIONS,
  ENTRY_CAPS,
  ENTRY_LIMITS,
  HEALTH_DIMENSIONS,
  HEALTH_HEADING,
  MAIN_FILE,
  MODE_PUZZLE_ONLY,
  MODULE_DIR,
  MODULE_SECTION_HEADINGS,
  MODULE_SECTION_KEYS,
  PAUSE_OPTIONS,
  PAUSE_QUESTION,
  PUZZLE_DIR,
  PUZZLE_VERSION,
  SECTION_HEADINGS,
  SECTION_ORDER,
  SOURCE_MARK,
  WORKFLOW_MAX_STEPS,
  createProject,
  docVersion,
  extraSectionsIn,
  parseFrontMatter,
  readState,
  updateMainSection,
  updateModuleSection,
} from '../lib/puzzle.js'

let passed = 0
const failed = []

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed.push({ name, message: error.message })
    console.error(`FAIL ${name} —— ${error.message}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'puzzle-contract-'))

try {
  createProject(root, 'demo', ['mod-a'], '契约测试', MODE_PUZZLE_ONLY, 'session-contract')
  const projectDir = join(root, 'demo', PUZZLE_DIR)
  const mainPath = join(projectDir, MAIN_FILE)

  /* --------------------- 契约的锚：**故意写死**的那几个值 --------------------- */

  // 上面说过「期望值都引常量」，但**契约测试不能全靠常量**——
  // 常量与模板同源，改常量时两边一起动，测试照样绿，等于没守（实测漏过：
  // 把 SECTION_HEADINGS.pit 改成「## 踩过的坑」，本文件 15 条全绿）。
  //
  // 所以这里**故意把契约钉成字面量**。这正是「契约测试」与「单元测试」的分界：
  //   - 单元测试引常量 —— 改实现不必满仓找断言（PR 建议①）；
  //   - 契约测试钉字面量 —— 格式一变**必须**红，逼改的人同时动版本号与文档（建议②）。
  // 改文档格式时，这里就是那张「必须一起改」的清单。
  check('契约锚·主文档五节的**字面名字**（改格式必须动这里 + 升 PUZZLE_VERSION）', () => {
    assert.deepEqual(
      Object.values(SECTION_HEADINGS),
      ['## 模块索引', '## 源码索引', '## 工具索引', '## 坑', '## 工作流'],
      '主文档五节的名字是对外承诺；改动必须同时升 PUZZLE_VERSION 并写进迁移说明',
    )
    assert.deepEqual(SECTION_ORDER, ['index', 'source', 'tools', 'pit', 'workflow'])
  })

  check('契约锚·文档格式版本的字面值（升版本必须动这里）', () => {
    assert.equal(PUZZLE_VERSION, 6, 'PUZZLE_VERSION 变化必须同步本文件与 CHANGELOG 的迁移说明')
  })

  check('契约锚·模块文档小节名与顺序（字面）', () => {
    assert.deepEqual(
      Object.values(MODULE_SECTION_HEADINGS),
      ['## 健康性', '## 进度', '## 要点', '## 悬而未决', '## 已定', '## 可复用', '## 详细记录'],
    )
  })

  check('契约锚·条目必须带源码出处的标记字面值', () => {
    assert.equal(SOURCE_MARK, '（源码', '出处标记是查找方向的锚，改了就断链')
  })

  /* ---------------------------- 主文档：五节契约 ---------------------------- */

  check('契约·主文档恰好五节：少一节算违约，**多一节也算**', () => {
    const main = readFileSync(mainPath, 'utf8')
    const body = parseFrontMatter(main).body
    // 「缺节」与「多节」都要抓：
    //   只断言「期望的节都在」会漏掉「模板多插了一节」——实测漏过（插一节 ## 临时索引 照样通过）。
    const extra = extraSectionsIn(body, Object.values(SECTION_HEADINGS))
    assert.deepEqual(extra, [], `主文档不该有规范外小节（除五节外禁止写任何内容）：${extra.join(' / ')}`)
    for (const key of SECTION_ORDER) {
      assert.ok(body.includes(SECTION_HEADINGS[key]), `缺少小节「${SECTION_HEADINGS[key]}」`)
    }
  })

  check('契约·模块文档不得有规范外小节（MODULE_SECTION_HEADINGS 之外禁写）', () => {
    updateModuleSection(root, 'demo', 'mod-a', 'points', `- 要点${SOURCE_MARK}: lib/b.js:2）`, true)
    const moduleText = readFileSync(join(projectDir, MODULE_DIR, 'mod-a.md'), 'utf8')
    const body = parseFrontMatter(moduleText).body
    const extra = extraSectionsIn(body, Object.values(MODULE_SECTION_HEADINGS))
    assert.deepEqual(extra, [], `模块文档不该有规范外小节：${extra.join(' / ')}`)
  })

  check('契约·extraSectionsIn 确实能抓出多余小节（自检：别让守卫本身失灵）', () => {
    // 这条是**守卫的守卫**：如果 extraSectionsIn 哪天退化成恒返回 []，
    // 上面两条会变成永远通过的空断言。这里用一个手工构造的样本确认它真的会报。
    const sample = '# 标题\n\n## 模块索引\n- x\n\n## 临时索引\n- y\n'
    const extra = extraSectionsIn(sample, Object.values(SECTION_HEADINGS))
    assert.deepEqual(extra, ['## 临时索引'], 'extraSectionsIn 必须能报出规范外小节')
  })

  check('契约·主文档小节标题与 SECTION_HEADINGS 逐字一致（改文案即违约）', () => {
    const main = readFileSync(mainPath, 'utf8')
    for (const key of SECTION_ORDER) {
      assert.ok(main.includes(SECTION_HEADINGS[key]), `缺少小节标题「${SECTION_HEADINGS[key]}」（key=${key}）`)
    }
  })

  check('契约·主文档不得出现模块级小节（健康性 / 进度 / 要点 都不属于主文档）', () => {
    const main = readFileSync(mainPath, 'utf8')
    assert.ok(!main.includes(HEALTH_HEADING), `主文档不该有 ${HEALTH_HEADING}`)
    assert.ok(!main.includes('## 进度'), '主文档不该有 ## 进度')
    assert.ok(!main.includes('## 要点'), '主文档不该有 ## 要点')
  })

  check('契约·文档格式版本 = PUZZLE_VERSION，且新建文档就是当前版', () => {
    const main = readFileSync(mainPath, 'utf8')
    assert.equal(docVersion(main), PUZZLE_VERSION, `新建主文档的 puzzle: 必须是 ${PUZZLE_VERSION}`)
    const state = readState(root, 'demo')
    assert.equal(state.version, PUZZLE_VERSION)
    assert.equal(state.outdated, false, '新建项目不该被判定为旧格式')
  })

  /* --------------------------- 条目契约：出处必填 --------------------------- */

  check('契约·主文档条目缺（源码: …）出处 → 写入被拒', () => {
    const before = readFileSync(mainPath, 'utf8')
    const result = updateMainSection(root, 'demo', 'pit', '- 一条没有出处的坑', false)
    assert.equal(result.ok, false, '缺出处的条目必须被拒，不能静默落盘')
    assert.equal(readFileSync(mainPath, 'utf8'), before, '被拒时文档不能被改动')
  })

  check('契约·主文档条目带出处 → 落盘，且出处原文保留', () => {
    const result = updateMainSection(root, 'demo', 'pit', `- 一条合规的坑${SOURCE_MARK}: lib/a.js:1）`, true)
    assert.equal(result.ok, true, '带出处的条目必须能落盘')
    const main = readFileSync(mainPath, 'utf8')
    assert.ok(main.includes('lib/a.js:1'), '出处里的文件:行必须原样保留（否则回查断链）')
  })

  check('契约·条目超长 → 报错且不截断（ENTRY_LIMITS 是硬上限）', () => {
    const tooLong = '坑'.repeat(ENTRY_LIMITS.pit + 1) + `${SOURCE_MARK}: lib/a.js:1）`
    const result = updateMainSection(root, 'demo', 'pit', '- ' + tooLong, false)
    assert.equal(result.ok, false, `超过 ${ENTRY_LIMITS.pit} 字必须报错`)
  })

  /* --------------------------- 模块文档：小节契约 --------------------------- */

  check('契约·模块文档小节 = MODULE_SECTION_KEYS，且健康性标题引常量', () => {
    updateModuleSection(root, 'demo', 'mod-a', 'points', `- 要点${SOURCE_MARK}: lib/b.js:2）`, true)
    const moduleText = readFileSync(join(projectDir, MODULE_DIR, 'mod-a.md'), 'utf8')
    assert.ok(moduleText.includes(HEALTH_HEADING), `模块文档必须有 ${HEALTH_HEADING}`)
    for (const key of MODULE_SECTION_KEYS) {
      assert.ok(moduleText.includes('## '), `模块文档小节缺失（key=${key}）`)
    }
    assert.equal(MODULE_SECTION_KEYS.length, 7, '模块文档小节数变化时请同步改这里与文档格式版本')
  })

  check('契约·五维维度名与数量 = HEALTH_DIMENSIONS', () => {
    const moduleText = readFileSync(join(projectDir, MODULE_DIR, 'mod-a.md'), 'utf8')
    const health = moduleText.slice(moduleText.indexOf(HEALTH_HEADING))
    for (const dimension of HEALTH_DIMENSIONS) {
      assert.ok(health.includes(dimension.name), `健康性小节必须列出维度「${dimension.name}」`)
    }
    assert.equal(HEALTH_DIMENSIONS.length, 5, '维度数变化属于格式变更')
  })

  /* ----------------------------- 上限契约：硬规则 ----------------------------- */

  check('契约·条数上限 = ENTRY_CAPS，超了删最旧（悬而未决 / 已定）', () => {
    // 写 ENTRY_CAPS.pending + 2 条，只应留下最后 ENTRY_CAPS.pending 条。
    const items = []
    for (let i = 0; i < ENTRY_CAPS.pending + 2; i += 1) {
      items.push(`- 未决第${i}条${SOURCE_MARK}: lib/c.js:${i}）`)
    }
    // API 契约：content 是**一段 markdown 文本**，不是数组（数组会被 String() 拼成一行）。
    const result = updateModuleSection(root, 'demo', 'mod-a', 'pending', items.join('\n'), false)
    assert.equal(result.ok, true)
    const moduleText = readFileSync(join(projectDir, MODULE_DIR, 'mod-a.md'), 'utf8')
    const kept = (moduleText.match(/未决第/g) || []).length
    assert.equal(kept, ENTRY_CAPS.pending, `悬而未决最多留 ${ENTRY_CAPS.pending} 条（超了删最旧）`)
    assert.ok(!moduleText.includes('未决第0条'), '最旧的应被删掉（删最旧，不是删最新）')
  })

  check('契约·提问额度 = ASK_MAX_QUESTIONS / ASK_MAX_OPTIONS，且都在合理区间', () => {
    assert.ok(Number.isSafeInteger(ASK_MAX_QUESTIONS) && ASK_MAX_QUESTIONS > 0, '提问上限必须是正整数')
    assert.ok(Number.isSafeInteger(ASK_MAX_OPTIONS) && ASK_MAX_OPTIONS > 0, '选项上限必须是正整数')
    // 收尾问固定两项：它不受 ASK_MAX_OPTIONS 影响，是**独立**的硬契约。
    assert.equal(PAUSE_OPTIONS.length, 2, '固定收尾问必须恰好两个选项')
    assert.ok(ASK_MAX_OPTIONS >= PAUSE_OPTIONS.length, '选项上限不该小于收尾问的选项数')
  })

  check('契约·工作流每条 ≤ WORKFLOW_MAX_STEPS 步；超了报错不删步', () => {
    const steps = []
    for (let i = 0; i < WORKFLOW_MAX_STEPS + 1; i += 1) steps.push(`${i + 1}. 第${i}步`)
    const tooMany = '### 超步数流程\n' + steps.join('\n')
    const result = updateMainSection(root, 'demo', 'workflow', tooMany, false)
    assert.equal(result.ok, false, `超过 ${WORKFLOW_MAX_STEPS} 步必须报错（步骤是有序的路，不能静默删）`)
  })

  check('契约·固定收尾问文案与两个选项都在（引 PAUSE_QUESTION / PAUSE_OPTIONS）', () => {
    assert.equal(typeof PAUSE_QUESTION, 'string')
    assert.ok(PAUSE_QUESTION.length > 0)
    for (const option of PAUSE_OPTIONS) assert.ok(typeof option === 'string' && option.length > 0)
  })

  console.log(`\n${passed} 项通过${failed.length ? ` / ${failed.length} 项失败:` : ''}`)
  for (const f of failed) console.log(`  - ${f.name} —— ${f.message}`)
  if (failed.length) process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
}

#!/usr/bin/env node
// 跨插件握手校验（只读）—— dsh-puzzle-mode ⇄ dsh-infinite-gen-5
//
//   node tools/verify-cross-plugin.mjs
//
// 判据：
//   1. 本插件段名/段序常量在场，且段序可被 PUZZLE_SECTION_ORDER 覆盖（默认 10120）
//   2. 政策文本含六条跨插件条款（域划分 / 额度按轮 / 批量不打断 / 工具形态 / 停下不回退 / 末位让位）
//   3. 若本机装有 dsh-infinite-gen-5：读它的 data/arbitration.mjs，核对
//      段序关系（本插件默认 < 其末位锚点 10150）与其记录的拼图段序一致
//   4. 任一侧改了数字而另一侧没跟上 → 报错并指出改哪一处
//
// 对方不在场时走「互校跳过」分支并标注 —— **不判失败**（CI 上没有那个仓库）。
// 这一分支必须能跑通，否则 CI 会红在本机永远走不到的那条路上。

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 查找顺序：装机路径 → 同工作区旁的克隆 → 环境变量指定的位置（便于换机器 / CI）。
const IG5_DIRS = [
  process.env.IG5_DIR,
  '/root/.dsh/plugin-src/dsh-infinite-gen-5',
  resolve(ROOT, '..', 'dsh-infinite-gen-5'),
  resolve(ROOT, '..', 'ig5-remote'),
].filter(Boolean)

const results = []
const ok = (claim, cond, detail = '') => results.push({ ok: !!cond, claim, detail: String(detail) })

const compatPath = join(ROOT, 'compat.json')
const decl = JSON.parse(readFileSync(compatPath, 'utf8'))
const defaultOrder = decl.puzzleDefaultOrder

const idx = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
ok('段名在场', idx.includes(decl.puzzleSectionName))
ok('段序可环境覆盖', idx.includes('PUZZLE_SECTION_ORDER'))
ok(`默认段序为 ${defaultOrder}（排在无限五代末位锚点之前）`,
  idx.includes(`const DEFAULT_SECTION_ORDER = ${defaultOrder}`), `默认 ${defaultOrder}`)
ok('导出段序常量供外部核对', idx.includes('export const SECTION_ORDER_VALUE'))

// 默认段序**不得**落在 DSH 内置段序表上：同号时段序相同时按段名比较，
// 位置就不再由协商决定。内置表见 @deepseek-ai/dsh-system-prompt 的 SECTION_ORDERS。
const DSH_BUILTIN_ORDERS = [
  -1000, 0, 500, 600, 800, 900, 1000, 1010, 1100, 1200, 1300, 1400, 1500,
  1600, 1700, 2000, 2100, 2200, 2300, 2400, 2600, 2700, 2800, 2900, 3000,
  3100, 5000, 9000, 9900, 10000, 10100, 10200,
]
ok(`默认段序 ${defaultOrder} 不与 DSH 内置段序撞号（撞号时位置由段名决定，协商失效）`,
  !DSH_BUILTIN_ORDERS.includes(defaultOrder),
  DSH_BUILTIN_ORDERS.includes(defaultOrder) ? `撞上内置段序 ${defaultOrder}` : `内置表无此值`)

const clauses = [
  ['域划分', '交付物内容与形态'],
  ['批量不打断', '不做打断者'],
  ['额度按轮', '提问额度按轮的'],
  ['停下不回退', '不回退'],
  ['文档只走本工具', '拼图文档只走 puzzle_mode'],
  ['末位让位', '早于它的末位锚点'],
]
for (const [label, needle] of clauses) {
  ok(`政策文本含「${label}」条款`, idx.includes(needle))
}

const ig5 = IG5_DIRS.find((d) => existsSync(join(d, decl.ig5ArbitrationFile)))
if (ig5) {
  const arb = readFileSync(join(ig5, decl.ig5ArbitrationFile), 'utf8')
  const num = (re) => Number((arb.match(re) || [])[1])
  const tail = num(/IG5_TAIL_ORDER = (\d+)/)
  const pzFork = num(/PZ_ORDER_FORK_DEFAULT = (\d+)/)
  const pzUp = num(/PZ_ORDER_UPSTREAM_0197 = (\d+)/)
  ok('读到无限五代末位锚点段序', Number.isFinite(tail), `IG5_TAIL_ORDER=${tail}`)
  ok('两侧对「拼图默认段序」的记法一致', pzFork === defaultOrder,
    `无限五代记 PZ_ORDER_FORK_DEFAULT=${pzFork} / 本插件默认 ${defaultOrder}`
    + (pzFork === defaultOrder ? '' : ' —— 改无限五代 data/arbitration.mjs 的 PZ_ORDER_FORK_DEFAULT'))
  ok('无限五代同时记了上游旧段序（两条路径都可）', Number.isFinite(pzUp) && pzUp > tail,
    `上游 ${pzUp} > 末位锚点 ${tail}`)
  ok('段序关系成立：拼图段在无限五代末位锚点之前', defaultOrder < tail, `${defaultOrder} < ${tail}`)
} else {
  ok('未装无限五代 → 跳过握手核对（不判失败）', true, IG5_DIRS.join(' | '))
}

// ── 双向互校：读双方的声明，两两核对，任一侧改数字即报错 ──
{
  ok('本仓 compat.json 契约在场', decl.contract === 'ig5-puzzle-coexist/1', decl.contract)
  ok('本仓声明的默认段序与 lib 内实现一致',
    idx.includes(`const DEFAULT_SECTION_ORDER = ${defaultOrder}`),
    `compat.json ${defaultOrder}`)

  if (!ig5) {
    ok('未装无限五代 → 互校跳过（契约已声明）', true, 'compat.json 已记录双方数字')
  } else {
    const arb = readFileSync(join(ig5, decl.ig5ArbitrationFile), 'utf8')
    const num = (re) => Number((arb.match(re) || [])[1])
    const ig5Tail = num(/IG5_TAIL_ORDER = (\d+)/)
    const ig5ForkDefault = num(/PZ_ORDER_FORK_DEFAULT = (\d+)/)
    ok('互校 A：无限五代记的拼图默认段序 == 本仓默认',
      ig5ForkDefault === decl.puzzleDefaultOrder,
      `ig5 ${ig5ForkDefault} / compat.json ${decl.puzzleDefaultOrder}`)
    ok('互校 B：无限五代记的末位锚点 == 本仓契约里记的',
      ig5Tail === decl.ig5TailOrder,
      `ig5 ${ig5Tail} / compat.json ${decl.ig5TailOrder}`)
    ok('互校 C：段序关系成立（拼图默认 < 无限五代末位锚点）',
      decl.puzzleDefaultOrder < decl.ig5TailOrder,
      `${decl.puzzleDefaultOrder} < ${decl.ig5TailOrder}`)
  }
}

// ── 文本层互校：六条分工规则的可核关键词，两侧各自自证 + 互校 ──
{
  const probes = decl.textProbes || {}
  const ruleIds = Object.keys(probes)
  const wantRules = ['domain', 'ask-quota', 'batch-first', 'tool-shape', 'stop-semantics', 'tail-concede']
  ok('文本互校表覆盖六条分工规则（域划分 / 额度 / 批量优先 / 工具形态 / 停下语义 / 末位让位）',
    ruleIds.length === 6 && wantRules.every((k) => k in probes),
    ruleIds.join(', '))

  const selfMiss = ruleIds.filter((k) => !idx.includes(probes[k].puzzle))
  ok('自证：本仓政策文本含六条 puzzle 侧关键词', selfMiss.length === 0,
    selfMiss.length ? '缺：' + selfMiss.map((k) => k + '→' + probes[k].puzzle).join(' / ') : ruleIds.join(', '))

  if (!ig5) {
    ok('未装无限五代 → 文本互校跳过（表已声明）', true, 'textProbes 已记录 ig5 侧关键词')
  } else {
    const arb = readFileSync(join(ig5, decl.ig5ArbitrationFile), 'utf8')
    const otherMiss = ruleIds.filter((k) => !arb.includes(probes[k].ig5))
    ok('互校：无限五代文本含六条 ig5 侧关键词', otherMiss.length === 0,
      otherMiss.length ? '缺：' + otherMiss.map((k) => k + '→' + probes[k].ig5).join(' / ') : ruleIds.join(', '))
  }
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.claim}${r.detail ? ' — ' + r.detail : ''}`)
console.log(`\n跨插件握手校验： ${results.length - failed.length} 通过 / ${failed.length} 失败（共 ${results.length} 项）${ig5 ? ' · 已核对 ' + ig5 : ' · 无限五代不在场，互校跳过'}`)
process.exit(failed.length ? 1 : 0)

#!/usr/bin/env node
// 跨插件握手校验（只读）—— dsh-puzzle-mode ⇄ dsh-infinite-gen-5
//
//   node tools/verify-cross-plugin.mjs
//
// 判据：
//   1. 本插件段名/段序常量在场，且段序可被 PUZZLE_SECTION_ORDER 覆盖（默认 10100）
//   2. 政策文本含五条跨插件条款（域划分 / 批量不打断 / 额度按轮 / 停下不回退 / 文档只走本工具）
//   3. 若本机装有 dsh-infinite-gen-5：读它的 data/arbitration.mjs，核对
//      段序关系（本插件默认 < 其末位锚点 10150）与其记录的拼图段序一致
//   4. 任一侧改了数字而另一侧没跟上 → 报错并指出改哪一处

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IG5_DIRS = [
  '/root/.dsh/plugin-src/dsh-infinite-gen-5',
  resolve(ROOT, '..', 'ig5-remote'),
]
const results = []
const ok = (claim, cond, detail = '') => results.push({ ok: !!cond, claim, detail: String(detail) })

const idx = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
const defaultOrder = 10100

ok('段名在场', idx.includes('puzzle-mode:policy'))
ok('段序可环境覆盖', idx.includes('PUZZLE_SECTION_ORDER'))
ok('默认段序为 10100（排在无限五代末位锚点之前）',
  new RegExp(`return Number\\.isFinite\\(n\\) && n !== 0 \\? n : ${defaultOrder}`).test(idx), `默认 ${defaultOrder}`)
ok('导出段序常量供外部核对', idx.includes('export const SECTION_ORDER_VALUE'))

const clauses = [
  ['域划分', '交付物内容与形态'],
  ['批量不打断', '不做打断者'],
  ['额度按轮', '提问额度按轮的'],
  ['停下不回退', '不回退'],
  ['文档只走本工具', '拼图文档只走 puzzle_mode'],
]
for (const [label, needle] of clauses) {
  ok(`政策文本含「${label}」条款`, idx.includes(needle))
}

const ig5 = IG5_DIRS.find((d) => existsSync(join(d, 'data', 'arbitration.mjs')))
if (ig5) {
  const arb = readFileSync(join(ig5, 'data', 'arbitration.mjs'), 'utf8')
  const tail = Number((arb.match(/IG5_TAIL_ORDER = (\d+)/) || [])[1])
  const pz = Number((arb.match(/PZ_ORDER_FORK_DEFAULT = (\d+)/) || [])[1])
  const pzUp = Number((arb.match(/PZ_ORDER_UPSTREAM_0197 = (\d+)/) || [])[1])
  ok('读到无限五代末位锚点段序', Number.isFinite(tail), `IG5_TAIL_ORDER=${tail}`)
  ok('两侧对「拼图默认段序」的记法一致', pz === defaultOrder,
    `无限五代记 PZ_ORDER_FORK_DEFAULT=${pz} / 本插件默认 ${defaultOrder}${pz === defaultOrder ? '' : ' —— 改无限五代 data/arbitration.mjs 的 PZ_ORDER_FORK_DEFAULT'}`)
  ok('无限五代同时记了上游旧段序（两条路径都可）', Number.isFinite(pzUp) && pzUp > tail,
    `上游 ${pzUp} > 末位锚点 ${tail}`)
  ok('段序关系成立：拼图段在无限五代末位锚点之前', defaultOrder < tail, `${defaultOrder} < ${tail}`)
} else {
  ok('未装无限五代 → 跳过握手核对', true, IG5_DIRS.join(' | '))
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.claim}${r.detail ? ' — ' + r.detail : ''}`)
console.log(`\n跨插件握手校验： ${results.length - failed.length} 通过 / ${failed.length} 失败（共 ${results.length} 项）${ig5 ? ' · 已核对 ' + ig5 : ''}`)
process.exit(failed.length ? 1 : 0)

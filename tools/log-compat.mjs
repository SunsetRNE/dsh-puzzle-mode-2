#!/usr/bin/env node
// 互校结果归档（追写一行 JSONL）—— 兼容性复刻仓专用
//
//   node tools/log-compat.mjs              # 跑两侧判据，把一行结果追加到 compat-log.jsonl
//   node tools/log-compat.mjs --show       # 读归档，按时间列出最近 N 行（默认 10）
//   node tools/log-compat.mjs --show --n=50
//
// 为什么要有它：段序契约与五条文本规则的核对是**逐次实测**出来的数字。「哪天开始漂的」
// 这个问题，只能靠一行行带时间戳的记录回答 —— 出问题时翻归档，比翻聊天记录快得多。
//
// 一行 = 一次核对：时间 / 本仓版本 / 对方版本 / 两侧声明的段序 / 文本规则条数 /
// 两侧判据通过数 / 结论（ok | drift | skip）。CI 里只打印这一行（CI 无推送权限），
// 本机跑则落盘。

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER = join(ROOT, 'compat-log.jsonl')
const IG5_DIRS = ['/root/.dsh/plugin-src/dsh-infinite-gen-5', '/root/S/ig5-remote']

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
function lastCounts(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const m = out.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/)
    return m ? { pass: Number(m[1]), fail: Number(m[2]) } : { pass: null, fail: null, raw: out.split('\n').slice(-3).join(' ') }
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    const m = out.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/)
    return m ? { pass: Number(m[1]), fail: Number(m[2]) } : { pass: null, fail: null, raw: out.split('\n').slice(-2).join(' ') }
  }
}

if (process.argv.includes('--show')) {
  const n = Number((process.argv.find((a) => a.startsWith('--n=')) || '--n=10').slice(4)) || 10
  if (!existsSync(LEDGER)) { console.log('（还没有归档：先跑 npm run log:compat）'); process.exit(0) }
  const lines = readFileSync(LEDGER, 'utf8').trim().split('\n').slice(-n)
  console.log('时间'.padEnd(21) + '本仓'.padEnd(10) + '对方'.padEnd(12) + '段序'.padEnd(16) + '文本'.padEnd(6) + '本仓判据'.padEnd(12) + '对方判据'.padEnd(12) + '结论')
  for (const l of lines) {
    let r; try { r = JSON.parse(l) } catch { continue }
    const ord = `${r.puzzleDefaultOrder}<${r.ig5TailOrder}`.padEnd(16)
    console.log(String(r.ts).padEnd(21) + String(r.forkVersion || '?').padEnd(10) + String(r.ig5Version || '（不在场）').padEnd(12) + ord
      + String(r.textProbeCount ?? '?').padEnd(6)
      + `${r.verifyCross?.pass ?? '?'}/${r.verifyCross?.fail ?? '?'}`.padEnd(12)
      + `${r.ig5Arbitration?.pass ?? '-'}/${r.ig5Arbitration?.fail ?? '-'}`.padEnd(12)
      + r.verdict)
  }
  process.exit(0)
}

const compat = readJson(join(ROOT, 'compat.json')) || {}
const pkg = readJson(join(ROOT, 'package.json')) || {}
const ig5Dir = IG5_DIRS.find((d) => existsSync(join(d, 'data', 'arbitration.mjs')))
const ig5Pkg = ig5Dir ? readJson(join(ig5Dir, 'package.json')) : null
const arb = ig5Dir ? readFileSync(join(ig5Dir, 'data', 'arbitration.mjs'), 'utf8') : ''
const num = (re) => Number((arb.match(re) || [])[1]);

const cross = lastCounts('npm', ['run', '--silent', 'verify:cross'])
// 注意：直接 node <脚本>，不要写成 `node --run <路径>` —— 首版就是那么写的，跑成了 npm 脚本，
// 判据读成 null、结论误报 drift；这条注释留档。
const ig5Arb = ig5Dir ? lastCounts('node', [join(ig5Dir, 'scripts', 'verify_arbitration.mjs')]) : null

const entry = {
  ts: new Date().toISOString(),
  side: 'puzzle-fork',
  contract: compat.contract || null,
  forkVersion: pkg.version || null,
  ig5Version: ig5Pkg && ig5Pkg.version ? ig5Pkg.version : null,
  ig5Present: Boolean(ig5Dir),
  puzzleDefaultOrder: compat.puzzleDefaultOrder ?? null,
  ig5TailOrder: compat.ig5TailOrder ?? num(/IG5_TAIL_ORDER = (\d+)/),
  textProbeCount: Object.keys(compat.textProbes || {}).length,
  verifyCross: cross,
  ig5Arbitration: ig5Dir ? ig5Arb : null,
  verdict: cross.fail === 0 && (!ig5Dir || (ig5Arb && ig5Arb.fail === 0)) ? 'ok' : 'drift',
}
appendFileSync(LEDGER, JSON.stringify(entry) + '\n')
console.log(JSON.stringify(entry))
console.log(`\n已追加一行到 ${LEDGER}（看历史：node tools/log-compat.mjs --show）`)

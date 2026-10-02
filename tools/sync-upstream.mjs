#!/usr/bin/env node
// 上游同步器（默认只读）—— dsh-puzzle-mode-2 兼容性复刻仓专用
//
//   node tools/sync-upstream.mjs             # 只读：拉上游 + 列差异 + 冲突预判 + 跑两侧校验
//   node tools/sync-upstream.mjs --apply     # 无冲突时真合并（rebase 保兼容提交在顶）
//
// 它回答三个问题：
//   1. 上游有什么新东西（提交列表）
//   2. 我们的兼容面还剩什么（相对上游的文件差异）
//   3. 合并会不会冲突（git merge-tree 预演）+ 合完能不能过判据（npm test / verify:cross）

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const apply = process.argv.includes('--apply')
const sh = (args, soft = true) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    if (soft) return `（失败：${String(e.stderr || e.message).split('\n')[0]}）`
    throw e
  }
}
const run = (cmd, args, soft = true) => {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    return soft ? `（退出码 ${e.status}）${out.split('\n').slice(-3).join(' / ')}` : out
  }
}

console.log('== 1. 拉上游')
console.log('  ' + sh(['remote', 'get-url', 'upstream']))
console.log('  fetch: ' + sh(['fetch', 'upstream']))

const upstreamHead = sh(['log', '--oneline', '-1', 'upstream/main'])
console.log('  upstream/main = ' + upstreamHead)

const newUpstream = sh(['log', '--oneline', '--no-merges', `HEAD..upstream/main`])
console.log('\n== 2. 上游新提交（HEAD..upstream/main）')
console.log(newUpstream.startsWith('（失败') || !newUpstream ? '  （无）' : newUpstream.split('\n').map((l) => '  ' + l).join('\n'))

console.log('\n== 3. 兼容面（本仓 − 上游）')
const diff = sh(['diff', '--stat', 'upstream/main', 'HEAD'])
console.log(diff.startsWith('（失败') || !diff ? '  （无差异 —— 本仓与上游一致）' : diff.split('\n').map((l) => '  ' + l).join('\n'))

console.log('\n== 4. 冲突预演（merge-tree）')
const base = sh(['merge-base', 'upstream/main', 'HEAD'])
const tree = sh(['merge-tree', base, 'HEAD', 'upstream/main'])
const conflict = tree.includes('<<<<<<<') || /CONFLICT/.test(tree)
console.log(conflict ? '  ⚠ 有冲突 —— 需人工 rebase（兼容提交在最顶）' : '  ✓ 无冲突')

if (!apply) {
  console.log('\n== 5. 判据（只读模式不跑，合并后请跑：npm test && npm run verify:cross）')
  console.log('\n（--apply 且无冲突时才会真合并；本仓原则：兼容提交永远在最顶，合完必须跑两侧判据。）')
  process.exit(0)
}

if (conflict) {
  console.log('\n✗ 有冲突，未执行合并。修法：git fetch upstream && git rebase upstream/main，逐个解决后 npm test && npm run verify:cross')
  process.exit(1)
}

console.log('\n== 5. 合并')
console.log('  rebase 前 HEAD: ' + sh(['log', '--oneline', '-1']))
const rb = run('git', ['rebase', 'upstream/main'])
console.log('  rebase: ' + rb)
console.log('  rebase 后 HEAD: ' + sh(['log', '--oneline', '-1']))
console.log('\n== 6. 判据')
console.log('  npm test: ' + run('npm', ['test']).split('\n').slice(-1)[0])
console.log('  verify:cross: ' + run('npm', ['run', 'verify:cross']).split('\n').slice(-1)[0])
console.log('\n合完建议：npm test 与 verify:cross 都绿再 push。')

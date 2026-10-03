/**
 * 浏览器半的「无浏览器」冒烟测试。
 *
 * bundle 是手写的 `window.__ModuleLoader__.load({ id, factory })`，所以这里造一个
 * 最小 window/document/React 替身，真的把 factory 跑起来、真的调 `apply`，
 * 再真的**渲染**两个组件并模拟点击，验证：
 *   - 两个 Slot 的 id/order/name 符合契约；
 *   - 图块可点开（点模块块 → 发起 `method:'module'` 请求）；
 *   - 提问模板走 `inputActions.setDraft`（并且不自动发送）；
 *   - `inputActions` 从按钮 Slot 传到面板（shell.overlay 的 props 里没有它）。
 *
 *   node test/20-client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASK_MAX_OPTIONS, ASK_MAX_QUESTIONS, HEALTH_DIMENSIONS } from '../lib/puzzle.js'

const here = dirname(fileURLToPath(import.meta.url))
// 维度名**引常量**而不是写死（v0.19.8）：改维度只改 lib/constants.js，断言自动跟上。
const DIMENSION_NAMES = HEALTH_DIMENSIONS.map((d) => d.name)
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let loaded = null
const fakeWindow = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    },
  },
  setInterval() {
    return 1
  },
  clearInterval() {},
  addEventListener() {},
  removeEventListener() {},
}

const fakeReact = {
  createElement(type, props, ...children) {
    return { type: type, props: props === null || props === undefined ? {} : props, children: children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, function () {}]
  },
  useEffect(fn) {
    // 立即执行一次，让 Button 里「把 inputActions 交给面板」的 effect 生效。
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanup()
  },
}

const requests = []
/** 假 RPC：按 method 返回真实形状的结果，让面板走「已初始化」分支。 */
const fakeFetch = (url, options) => {
  const body = JSON.parse(options.body)
  requests.push({ url, body })
  let result
  if (body.method === 'state') {
    result = {
      ok: true,
      initialized: true,
      projectRoot: '/tmp/ws',
      projectDir: '/tmp/ws/demo/拼图',
      project: 'demo',
      mode: '只拼不写',
      modeSource: 'front-matter',
      health: 62,
      dimensions: { complexity: 34, extensibility: 40, maintenance: 44, quality: 88, reusability: 20 },
      cwdSource: 'session',
      projectSource: 'latest',
      modules: [{ name: 'auth-flow', exists: true, health: 62, dimensions: {}, counts: { points: 2, pending: 1, decided: 0 } }],
      findings: [
        { id: 'progress_no_points:auth-flow', level: 'blocker', dimension: 'maintenance', scope: 'auth-flow', fact: '完成度写 100，但要点 0 条。', fix: '把要点补上。' },
        { id: 'weakest_dimension', level: 'info', dimension: 'reusability', scope: 'project', fact: '最弱一维是可复用性。', fix: '写出可复用接口。' },
      ],
    }
  } else if (body.method === 'list') {
    result = { ok: true, projectCount: 2, defaultProject: 'demo', projects: [{ name: 'demo', health: 62 }, { name: 'second', health: 10 }] }
  } else if (body.method === 'module') {
    result = { ok: true, name: body.name, exists: true, health: 62, dimensions: { complexity: 34, extensibility: 40, maintenance: 44, quality: 88, reusability: 20 }, points: '要点一', related: '- [ ] 待定', detail: '详细一' }
  } else {
    result = { ok: true, mode: body.mode }
  }
  // 客户端读的是外层 { ok, result } —— 这里必须按真实 RPC 的形状包一层。
  return Promise.resolve({ json: () => Promise.resolve({ ok: true, result }) })
}

const run = new Function('window', 'document', 'fetch', source)
run(
  fakeWindow,
  { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} }, body: {} },
  fakeFetch,
)

assert.ok(loaded !== null, 'bundle 必须调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-puzzle-mode')
assert.equal(typeof loaded.factory, 'function')

const mod = loaded.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
})
assert.equal(typeof mod.apply, 'function')
// v0.19.8 修：导出名单按现行 lib/client.js 的 module.exports 对齐 ——
// questionTemplate 已不存在（提问相关改由 interviewTemplate 承担），
// 实际导出还有 resumeTemplate / auditTemplate / refactorTemplate / adoptTemplate /
// newDocTemplate / workflowTemplate 等；这里逐个核可测导出。
assert.equal(typeof mod.auditTemplate, 'function', '审查模板必须可测（导出）')
for (const name of ['createTemplate', 'interviewTemplate', 'bindTemplate', 'createByForm',
  'resumeTemplate', 'refactorTemplate', 'adoptTemplate', 'newDocTemplate', 'workflowTemplate']) {
  assert.equal(typeof mod[name], 'function', name + ' 必须可测（导出）')
}

/* ---------------------------- 提问模板内容 ---------------------------- */

{
  const text = mod.interviewTemplate('登录重构')
  assert.ok(text.includes('登录重构'))
  // v0.19.8 修：同上 —— 固定收尾问不在模板里；改核模板的实质内容（岔路 + 取舍 + 上限）。
  assert.ok(text.includes('先采访再建'), '模板要说明先采访再建')
  assert.ok(text.includes('真岔路'), '模板要给真岔路而不是是非题')
  assert.ok(text.includes('能用选项就用选项'), '模板要点名用选项提问')
  assert.ok(text.includes('一轮最多 ' + ASK_MAX_QUESTIONS + ' 问'), '模板要写清提问额度（引 ASK_MAX_QUESTIONS，改上限不用改断言）')
  assert.ok(text.includes('每题最多 ' + ASK_MAX_OPTIONS + ' 个选项'), '模板要写清选项额度（引 ASK_MAX_OPTIONS）')
  assert.ok(/取舍|代价/.test(text), '模板要说明代价/取舍')
  // 提问数上限从 3 提到 5：模板要给出 5 个槽位。
  // v0.19.8 修：提问槽位编号已取消（改由 ASK_MAX_QUESTIONS 约束上限），不再逐槽断言。
  // v0.19.8 修：模板不再点名工具名（工具名由 policy 段给），改核「必须用选项提问」这条实质要求
  assert.ok(text.includes('能用选项就用选项'), '模板必须要求用选项提问（正文列选项不算提问）')
}

{
  const audit = mod.auditTemplate('登录重构')
  assert.ok(audit.includes('登录重构'))
  assert.ok(audit.includes('op:audit'), '审查模板必须点名 op:audit')
  assert.ok(audit.includes('五维'), '审查要按五维')
  // v0.19.8 修：模板**不再内嵌**固定收尾问（「每轮提问末尾必问停下」由 policy 段与 ask 流程统一要求，
  // 不在模板字符串里逐份复制），所以这里不再断言模板含那句。
  assert.ok(audit.includes('op:audit') || audit.includes('fixPlan'), '审查模板要点名审查产出')
}

{
  const create = mod.createTemplate('登录重构')
  assert.ok(create.includes('op:init'), '快速建空壳要点名 op:init')
  assert.ok(create.includes('modules'), '要提示给出模块名')
  const interview = mod.interviewTemplate('登录重构')
  assert.ok(interview.includes('op:init') && /最多 \d+ 问/.test(interview), '采访模板要限提问数（现行 10 问）')
  assert.ok(interview.includes('不要提前调 op:init'), '采访模板要明确先别建')
  const bind = mod.bindTemplate('demo')
  assert.ok(bind.includes('op:bind'), '绑定模板要点名 op:bind')
  assert.ok(bind.includes('demo'), '绑定模板要带上项目名')
}

/* ------------------------------ 注册契约 ------------------------------ */

const registered = []
const slots = {
  inject(name, callback) {
    registered.push(['inject', name])
    callback()
    return () => {}
  },
  register(options, component) {
    registered.push(['register', options, component])
    return () => {}
  },
}

let effects = 0
mod.apply({
  get(name) {
    return name === 'slots' ? slots : undefined
  },
  effect() {
    effects += 1
    return () => {}
  },
})

const registrations = registered.filter((row) => row[0] === 'register')
assert.equal(registrations.length, 2, '应注册两个 Slot')
const button = registrations.find((row) => row[1].name === 'conversation.input.left')
const panel = registrations.find((row) => row[1].name === 'shell.overlay')
assert.ok(button !== undefined, '按钮必须挂在 conversation.input.left（模型选择器左边）')
assert.equal(button[1].id, 'puzzle-mode-button')
assert.equal(button[1].order, 100)
assert.ok(panel !== undefined, '面板必须挂在 shell.overlay')
assert.equal(panel[1].id, 'puzzle-mode-panel')
assert.equal(panel[1].order, 50)
assert.ok(effects >= 1, '样式注入必须挂在 ctx.effect 上（可随 Fiber 卸载）')

/* --------------------------- 首渲染不抛错 --------------------------- */

const draftCalls = []
const inputActions = {
  setDraft(text) {
    draftCalls.push(text)
  },
  submit() {
    draftCalls.push('SUBMIT-SHOULD-NOT-HAPPEN')
  },
}

const buttonTree = button[2]({ sessionId: 'session-x', inputActions })
assert.equal(buttonTree.type, 'button', '按钮首渲染应是一个 button')
const panelClosed = panel[2]({})
assert.equal(panelClosed, null, '未打开时面板不渲染任何东西')

/**
 * 让假 RPC 的 `fetch → json → then` 三层 promise 链跑完。
 * 单次 `setTimeout(0)` 只放行一个宏任务，不够——面板会停在「读取中」。
 */
async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/* --------------------- 打开面板 → 图块可点 + 提问模板 --------------------- */

// 模拟点击按钮打开面板：走真实的 onClick。
buttonTree.props.onClick()
await flush()

// 面板此刻应已打开（store 是模块级的，所以面板组件能看到）。
const panelTree = panel[2]({})
assert.ok(panelTree !== null, '点开后应渲染面板')

// 面板里必须已经能拿到 inputActions（从按钮 Slot 传过来）。
// 通过「点提问模板按钮 → setDraft 被调用」来验证，而不是读内部状态。
/**
 * 深度遍历渲染树。注意：**字符串子节点也要参与匹配**，
 * 否则 `h('span', null, '50%')` 里的文本永远找不到。
 */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  if (typeof node !== 'object') return out
  findAll(node.children, predicate, out)
  return out
}

const buttons = findAll(panelTree, (node) => typeof node === 'object' && node.type === 'button' && node.props !== undefined && typeof node.props.onClick === 'function')
// v0.19.8 修：「提问模板」按钮**已按用户裁定删除**（见 lib/client.js 顶部注释），
// 断言反过来 —— 它不该再出现（这是回归护栏，不是放宽）。
const templateButton = buttons.find((node) => Array.isArray(node.children) && node.children.some((child) => child === '提问模板'))
assert.equal(templateButton, undefined, '「提问模板」按钮已删除，不该再出现')
// v0.19.8 修：审查入口不再固定是「审查」字样的 <button>（面板分状态渲染），
// 改成「面板里存在能触发审查的入口」这一契约。
const auditEntry = findAll(panelTree, (node) => typeof node === 'object' && node.props !== undefined
  && typeof node.props.onClick === 'function'
  && JSON.stringify(node.children || []).includes('审查'))
assert.ok(auditEntry.length >= 1, '面板里要能触发「审查」（任意可点入口）')

// 客观发现必须直接渲染出来（含事实与下一步），不能只躺在 RPC 里。
assert.ok(findAll(panelTree, (node) => typeof node === 'string' && node.includes('完成度写 100')).length >= 1, '面板要显示发现的事实')
assert.ok(findAll(panelTree, (node) => typeof node === 'string' && node.includes('把要点补上')).length >= 1, '面板要显示发现的下一步')
assert.ok(findAll(panelTree, (node) => typeof node === 'string' && node.includes('审查 · 客观发现')).length >= 1, '要有审查区块标题')

/* --------------------------- 图块可点开看详情 --------------------------- */

// 面板打开时已经发过 state / list 请求。
assert.ok(requests.some((item) => item.body.method === 'state'), '打开面板应拉 state')
assert.ok(requests.some((item) => item.body.method === 'list'), '打开面板应拉项目列表')

// 找到模块图块并点它。（原注：点「提问模板」会关闭面板 —— 该按钮已删除，此注保留为历史。）
const tiles = findAll(panelTree, (node) => typeof node === 'object' && node.type === 'button' && node.props !== undefined && node.props['data-static'] === '0')
assert.ok(tiles.length >= 1, '模块图块必须是可点的（data-static=0）')
const before = requests.filter((item) => item.body.method === 'module').length
tiles[0].props.onClick()
await flush()
const after = requests.filter((item) => item.body.method === 'module')
assert.equal(after.length, before + 1, '点模块图块应发起 method:module 请求')
assert.equal(after[after.length - 1].body.name, 'auth-flow')

// 详情渲染出来后应包含文档内容。
const panelTree3 = panel[2]({})
assert.ok(findAll(panelTree3, (node) => Array.isArray(node.children) && node.children.includes('要点一')).length >= 1, '详情应显示模块要点')

// 面板必须渲染五维（跨模块均值），且不再出现旧的「完整度/overall」字样。
const dimNames = findAll(panelTree3, (node) => typeof node === 'string' && DIMENSION_NAMES.includes(node))
// 五维名在「跨模块均值」区块出现一次；模块详情展开时还会再出现一次，
// 所以这里断言「五个维度名都出现过」，而不是「恰好出现 5 次」。
for (const name of DIMENSION_NAMES) assert.ok(dimNames.includes(name), `面板必须渲染「${name}」`)
const dimVals = findAll(panelTree3, (node) => typeof node === 'string' && /^\d+%$/.test(node))
assert.ok(dimVals.length >= 5, '五维都要有百分比')
assert.equal(findAll(panelTree3, (node) => typeof node === 'string' && node.includes('完整度')).length, 0, '不该再出现「完整度」')

/* --------------------- 提问模板（放在最后：它会关面板） --------------------- */

// v0.19.8：按现行 markup 定位审查入口（按钮 title = 「让 AI 按五维审查这个项目，并出可执行修复清单」，
// 子节点文本 = 「审查（交给 AI）」），并断言点击后**真的把审查指令填进输入框**（askAi → setDraft）。
const auditButton = buttons.find((node) => node.props !== undefined
  && typeof node.props.title === 'string' && node.props.title.includes('按五维审查'))
assert.ok(auditButton !== undefined, '面板里必须有「审查（交给 AI）」入口')
const draftsBefore = draftCalls.length
auditButton.props.onClick({ target: {}, preventDefault() {}, stopPropagation() {} })
assert.equal(draftCalls.length, draftsBefore + 1, '点审查应恰好调用一次 setDraft')
assert.ok(draftCalls[draftCalls.length - 1].includes('op:audit'), '审查按钮要填审查模板')
assert.ok(!templateButton, '「提问模板」按钮已删除（不应再有第二个填模板入口）')
assert.ok(!draftCalls.includes('SUBMIT-SHOULD-NOT-HAPPEN'), '绝不能自动提交')

console.log('ok   bundle 格式、两个 Slot 注册、图块详情、客观发现渲染、提问/审查模板（setDraft，不自动发送）均通过')

/* ------------- 多绑定切换条（v7）：绑着几个就必须画几个胶囊 ------------- */

/**
 * 这条断言的由来（**回归护栏，不是形式主义**）：
 * 我第一版把「只绑了一个」优化成一行纯文字（`bindings.length === 1 && unbound.length === 0`
 * 时直接 return 文本），结果**单绑定是绝大多数情况** —— 等于切换条平时根本不存在，
 * 用户当场反馈「我的切换绑定被搞没了」。所以这里把「只要绑着就得画出来」钉死：
 * 单绑定要画，多绑定要画，当前项要高亮，`＋` 要在场。
 */
{
  const multiLoaded = []
  const multiRequests = []
  const multiWindow = {
    __ModuleLoader__: { load(entry) { multiLoaded.push(entry) } },
    setInterval() { return 1 },
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
  }
  const multiFetch = (url, options) => {
    const body = JSON.parse(options.body)
    multiRequests.push(body)
    let result
    if (body.method === 'state') {
      result = {
        ok: true, initialized: true, projectRoot: '/tmp/ws3', projectDir: '/tmp/ws3/demo/拼图',
        project: 'demo', mode: '只拼不写', health: 62, version: 7,
        dimensions: {}, modules: [], findings: [],
        // 两个绑定：当前是 demo。面板必须画出**两个**胶囊、且只有 demo 高亮。
        bindings: [
          { project: 'demo', current: true, mode: '只拼不写', health: 62, moduleCount: 3, initialized: true },
          { project: 'second', current: false, mode: '写后再拼', health: 41, moduleCount: 5, initialized: true },
        ],
        currentProject: 'demo', bindingWarnThreshold: 8,
      }
    } else if (body.method === 'list') {
      // 工作区里还有第三个（未绑定）→ `＋` 的候选。
      result = { ok: true, projects: [{ name: 'demo', health: 62 }, { name: 'second', health: 41 }, { name: 'third', health: 10 }] }
    } else {
      result = { ok: true }
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, result }) })
  }
  new Function('window', 'document', 'fetch', source)(
    multiWindow,
    { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} }, body: {} },
    multiFetch,
  )
  const multiMod = multiLoaded[0].factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
  const multiRegistered = []
  const multiSlots = {
    inject(name, callback) { callback(); return () => {} },
    register(options, component) { multiRegistered.push({ options, component }); return () => {} },
  }
  multiMod.apply({ get: (name) => (name === 'slots' ? multiSlots : undefined), effect: () => () => {} })
  const multiButton = multiRegistered.find((row) => row.options.name === 'conversation.input.left')
  const multiPanel = multiRegistered.find((row) => row.options.name === 'shell.overlay')
  multiButton.component({ sessionId: 'session-multi', inputActions: { setDraft() {}, submit() {} } }).props.onClick()
  await flush()
  const multiTree = multiPanel.component({})

  // 胶囊是 `<button class="dshpz-pill">`。要排除两类：`×`（里面的 span，class 含 pillx）
  // 与 `＋`（class 是 `dshpz-pill dshpz-pill-plus`）——后者也带 pill，用整串精确匹配区分。
  const pillNodes = findAll(multiTree, (node) => typeof node === 'object' && node.type === 'button'
    && node.props !== undefined && node.props.className === 'dshpz-pill')
  assert.equal(pillNodes.length, 2, '绑了两个项目就必须画两个胶囊（不是退化成一行文字）')
  assert.deepEqual(pillNodes.map((node) => node.props['data-on']), ['1', '0'], '只有当前项目那个胶囊高亮')
  assert.equal(pillNodes[0].props.title.includes('当前项目'), true, '当前胶囊要说明自己是当前')
  const plusButton = findAll(multiTree, (node) => typeof node === 'object' && node.type === 'button'
    && node.props !== undefined && typeof node.props.className === 'string'
    && node.props.className.includes('dshpz-pill-plus'))
  assert.equal(plusButton.length, 1, '要有个 ＋ 能再绑一个（工作区里还有未绑定的项目）')
  assert.ok(findAll(multiTree, (node) => typeof node === 'string' && node.includes('当前项目「')).length >= 1,
    '多绑定要说明当前是哪个 + 联动规则')

  // 点另一个胶囊 → 发 method:current（**切当前**，不是改绑）。
  const beforeCurrent = multiRequests.filter((item) => item.method === 'current').length
  pillNodes[1].props.onClick()
  await flush()
  const currentReqs = multiRequests.filter((item) => item.method === 'current')
  assert.equal(currentReqs.length, beforeCurrent + 1, '点胶囊要发 method:current')
  assert.equal(currentReqs[currentReqs.length - 1].project, 'second')
  assert.equal(multiRequests.some((item) => item.method === 'bind'), false, '切当前**不该**发 method:bind（那会改绑定集合）')

  // `×` → 只解绑这一个。
  const beforeUnbind = multiRequests.filter((item) => item.method === 'unbind').length
  const xNode = findAll(multiTree, (node) => typeof node === 'object' && node.props !== undefined
    && typeof node.props.className === 'string' && node.props.className.includes('dshpz-pillx'))
  assert.equal(xNode.length, 2, '每个胶囊都要有个 ×')
  xNode[1].props.onClick({ stopPropagation() {} })
  await flush()
  const unbindReqs = multiRequests.filter((item) => item.method === 'unbind')
  assert.equal(unbindReqs.length, beforeUnbind + 1, '点 × 要发 method:unbind')
  assert.equal(unbindReqs[unbindReqs.length - 1].project, 'second', '× 只解绑它自己那一个')

  console.log('ok   多绑定切换条：绑几个画几个胶囊 / 当前高亮 / 点胶囊切当前 / × 只解一个 / ＋ 在场')

/* ------------- 空态多绑定：勾选 → 点「绑定选中的 N 个」必须发得出去 ------------- */

/**
 * 这条断言的由来（用户报「选中以后点绑定不行会闪出红框」）：
 * 空态「多绑定」模式勾选后点按钮，客户端发的是 `projects: [...]`、**没有 `project` 字段**，
 * 而 RPC 的入参守卫当时写成「没有 project 就 400」——请求永远被挡，面板弹红框。
 * 这里把**界面发出的载荷形状**钉死：只带 `projects` 数组。服务端那一半由 30-rpc 覆盖。
 */
{
  const multiLoaded = []
  const multiRequests = []
  const multiWindow = {
    __ModuleLoader__: { load(entry) { multiLoaded.push(entry) } },
    setInterval() { return 1 },
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
  }
  const multiFetch = (url, options) => {
    const body = JSON.parse(options.body)
    multiRequests.push(body)
    let result
    if (body.method === 'state') {
      result = { ok: true, initialized: false, projectRoot: '/tmp/ws4', projectDir: '', project: '', mode: '只拼不写', modeSource: 'default', health: 0, dimensions: {}, sections: {}, cwdSource: 'session', projectSource: 'none', modules: [] }
    } else if (body.method === 'list') {
      result = { ok: true, projectCount: 2, defaultProject: 'demo', projects: [{ name: 'demo', health: 62 }, { name: 'two', health: 41 }] }
    } else {
      result = { ok: true }
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, result }) })
  }
  new Function('window', 'document', 'fetch', source)(
    multiWindow,
    { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} }, body: {} },
    multiFetch,
  )
  const multiMod = multiLoaded[0].factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
  const regs = []
  const sl = { inject(name, cb) { cb(); return () => {} }, register(o, c) { regs.push({ o, c }); return () => {} } }
  multiMod.apply({ get: (n) => (n === 'slots' ? sl : undefined), effect: () => () => {} })
  const btn = regs.find((r) => r.o.name === 'conversation.input.left')
  const pnl = regs.find((r) => r.o.name === 'shell.overlay')
  btn.c({ sessionId: 'session-ms', inputActions: { setDraft() {}, submit() {} } }).props.onClick()
  await flush()
  let tree = pnl.c({})

  const multiMode = findAll(tree, (node) => typeof node === 'object' && node.type === 'button'
    && Array.isArray(node.children) && node.children.includes('多绑定'))[0]
  assert.ok(multiMode !== undefined, '空态要有「多绑定」模式按钮')
  multiMode.props.onClick()
  tree = pnl.c({})

  const boxes = findAll(tree, (node) => typeof node === 'object' && node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(boxes.length, 2, '多绑定模式要给每个已有项目一个勾选框')
  boxes[0].props.onChange()
  tree = pnl.c({})

  const bindBtn = findAll(tree, (node) => typeof node === 'object' && node.type === 'button'
    && Array.isArray(node.children) && node.children.some((c) => typeof c === 'string' && c.startsWith('绑定选中的')))[0]
  assert.ok(bindBtn !== undefined, '要有一颗「绑定选中的 N 个」按钮')
  assert.equal(bindBtn.props.disabled, false, '勾了一个之后按钮不该还是禁用的')
  bindBtn.props.onClick()
  await flush()

  const binds = multiRequests.filter((item) => item.method === 'bind')
  assert.equal(binds.length, 1, '点一次要恰好发一次 bind')
  assert.deepEqual(binds[0].projects, ['demo'], '载荷要带 projects 数组')
  assert.equal(binds[0].project, undefined, '**不该**带 project 字段——服务端守卫必须认 projects（这是红框的由来）')
  console.log('ok   空态多绑定：勾选 → 点绑定 → 载荷只带 projects 数组（服务端必须认它）')
}
}

/* ------------- 空态：新会话默认空绑定 → 建项目 / 绑定已有项目 ------------- */

// 第二次加载：让 state 返回 initialized:false，才能真正渲染空态分支。
const emptyLoaded = []
const emptyRequests = []
const emptyWindow = {
  __ModuleLoader__: { load(entry) { emptyLoaded.push(entry) } },
  setInterval() { return 1 },
  clearInterval() {},
  addEventListener() {},
  removeEventListener() {},
}
const emptyFetch = (url, options) => {
  const body = JSON.parse(options.body)
  emptyRequests.push(body)
  let result
  if (body.method === 'state') {
    result = {
      ok: true, initialized: false, projectRoot: '/tmp/ws2', projectDir: '', project: '',
      mode: '只拼不写', modeSource: 'default', health: 0, dimensions: {}, sections: {},
      cwdSource: 'session', projectSource: 'none', modules: [],
    }
  } else if (body.method === 'list') {
    result = { ok: true, projectCount: 1, defaultProject: 'demo', projects: [{ name: 'demo', health: 62 }] }
  } else {
    result = { ok: true }
  }
  return Promise.resolve({ json: () => Promise.resolve({ ok: true, result }) })
}
new Function('window', 'document', 'fetch', source)(
  emptyWindow,
  { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} }, body: {} },
  emptyFetch,
)
assert.equal(emptyLoaded.length, 1, '第二次加载也要注册 bundle')
const emptyMod = emptyLoaded[0].factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
})
const emptyRegistered = []
const emptySlots = {
  inject(name, callback) { callback(); return () => {} },
  register(options, component) { emptyRegistered.push({ options, component }); return () => {} },
}
emptyMod.apply({ get: (name) => (name === 'slots' ? emptySlots : undefined), effect: () => () => {} })
const emptyButton = emptyRegistered.find((row) => row.options.name === 'conversation.input.left')
const emptyPanel = emptyRegistered.find((row) => row.options.name === 'shell.overlay')
const emptyDrafts = []
const emptyActions = {
  setDraft(text) { emptyDrafts.push(text) },
  submit() { emptyDrafts.push('SUBMIT-SHOULD-NOT-HAPPEN') },
}
const emptyButtonTree = emptyButton.component({ sessionId: 'session-new', inputActions: emptyActions })
emptyButtonTree.props.onClick()
await flush()
const emptyTree = emptyPanel.component({})
assert.ok(emptyTree !== null, '空态也要渲染面板')
assert.ok(findAll(emptyTree, (node) => typeof node === 'string' && node.includes('不会自动占用')).length >= 1, '空态要说清不会自动占用别人的项目')
const emptyButtons = findAll(emptyTree, (node) => typeof node === 'object' && node.type === 'button' && node.props !== undefined && typeof node.props.onClick === 'function')
const quickButton = emptyButtons.find((node) => Array.isArray(node.children) && node.children.some((child) => child === '快速建空壳'))
const interviewButton = emptyButtons.find((node) => Array.isArray(node.children) && node.children.some((child) => child === '采访后再建'))
assert.ok(quickButton !== undefined, '空态必须有「快速建空壳」')
assert.ok(interviewButton !== undefined, '空态必须有「采访后再建」')
quickButton.props.onClick()
interviewButton.props.onClick()
assert.equal(emptyDrafts.length, 2, '两个按钮各填一次模板')
assert.ok(emptyDrafts[0].includes('op:init'), '快速建空壳填的是 op:init 模板')
// v0.19.8：额度不再写死，改引 ASK_MAX_QUESTIONS —— 以后调上限不必回来改断言。
assert.ok(emptyDrafts[1].includes('最多 ' + ASK_MAX_QUESTIONS + ' 问'), '采访后再建填的是采访模板（额度引常量）')
assert.ok(!emptyDrafts.includes('SUBMIT-SHOULD-NOT-HAPPEN'), '绝不能自动提交')
  // 绑定已有项目：空态要列出现有项目并能一键绑定。
  const bindButton = findAll(emptyTree, (node) => typeof node === 'object' && node.type === 'button' && Array.isArray(node.children) && node.children.some((child) => child === '绑定'))[0]
  assert.ok(bindButton !== undefined, '空态要能绑定已有项目')
  bindButton.props.onClick()
  await flush()
  assert.ok(emptyRequests.some((item) => item.method === 'bind' && item.project === 'demo'), '点绑定要发 method:bind')
  console.log('ok   空态：快速建空壳 / 采访后再建 / 绑定已有项目（都走 setDraft 或 RPC，不自动提交）')

  // 表单直建：三个输入框 + 「立刻建」按钮必须在场（值由 store 驱动，见下）。
  const formInputs = findAll(emptyTree, (node) => typeof node === 'object' && node.type === 'input')
  assert.equal(formInputs.length, 3, '空态表单要有三个输入框（项目名 / 模块名 / 目标）')
  assert.ok(formInputs.every((node) => typeof node.props.onChange === 'function'), '三个输入框都要能改（onChange 在场）')
  const createButton = findAll(emptyTree, (node) => typeof node === 'object' && node.type === 'button' && Array.isArray(node.children) && node.children.some((child) => child === '立刻建'))[0]
  assert.ok(createButton !== undefined, '空态要有「立刻建」（表单直建）')
  assert.equal(typeof emptyMod.createByForm, 'function', '表单直建要可测（导出）')
  // 直接驱动导出的 createByForm：假 React 的 setState 是空函数，改不了 store 里的表单值，
  // 所以这里传一个自定义 view —— 这正是把它导出的理由。
  const beforeCreate = emptyRequests.filter((item) => item.method === 'create').length
  emptyMod.createByForm({ state: { sessionId: 'session-form', formProject: '   ', formModules: 'a', formGoal: '' } })
  await flush()
  assert.equal(emptyRequests.filter((item) => item.method === 'create').length, beforeCreate, '项目名为空时不该发 create')
  emptyMod.createByForm({ state: { sessionId: undefined, formProject: 'x' } })
  await flush()
  assert.equal(emptyRequests.filter((item) => item.method === 'create').length, beforeCreate, '没有会话 ID 时不该发 create')
  emptyMod.createByForm({ state: { sessionId: 'session-form', formProject: ' 表单项目 ', formModules: 'a, b、c d', formGoal: ' 一句话 ' } })
  await flush()
  const created = emptyRequests.filter((item) => item.method === 'create')
  assert.equal(created.length, beforeCreate + 1, '填好后要发 create')
  assert.equal(created[created.length - 1].project, '表单项目', '项目名要去首尾空格')
  assert.deepEqual(created[created.length - 1].modules, ['a', 'b', 'c', 'd'], '模块名按逗号/顿号/空格切')
  assert.equal(created[created.length - 1].goal, '一句话')
  console.log('ok   空态表单直建：三个输入框在场，填名 → 发 method:create（不经过模型，模块名按分隔符切）')


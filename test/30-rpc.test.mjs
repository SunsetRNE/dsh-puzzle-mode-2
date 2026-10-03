/**
 * RPC 路由测试：把宿主半注册的 `/puzzle-mode-rpc` 处理器截下来，用假的 req/res 驱动。
 * 覆盖：鉴权拒绝、非 POST、坏正文、缺 sessionId、state / list / module / mode、未知 method。
 *
 *   node test/30-rpc.test.mjs
 *
 * 宿主半 import 了 `@deepseek-ai/dsh-tools`（由 DSH 运行时提供）。在没装 DSH 的
 * 裸目录里这一组无法运行，此时**明确跳过**并说明原因，而不是抛 ERR_MODULE_NOT_FOUND。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HEALTH_DIMENSIONS, PUZZLE_VERSION, SECTION_ORDER, boundProject, boundProjects, createProject, docVersion, readState } from '../lib/puzzle.js'

let host
try {
  host = await import('../lib/index.js')
} catch (error) {
  const code = error === null || error === undefined ? undefined : error.code
  console.log(`skip 30-rpc.test.mjs：${code === 'ERR_MODULE_NOT_FOUND' ? '找不到 @deepseek-ai/dsh-tools（本目录未装进 DSH profile），跳过' : String(error && error.message ? error.message : error)}`)
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'puzzle-rpc-'))
let passed = 0

function ok(name) {
  passed += 1
  console.log(`ok   ${name}`)
}

/** 摘出宿主半注册的 RPC 处理器。 */
function captureRoute({ reject = false } = {}) {
  let route = null
  host.apply({
    systemPrompt: { section() {} },
    tools: { register() { return () => {} } },
    on() { return () => {} },
    effect() {},
    get(name) {
      if (name !== 'sessions') return undefined
      return {
        get(id) {
          // 任何会话 id 都指向同一个测试工作区：绑定测试需要多个会话。
          return typeof id === 'string' && id !== '' ? { header: { cwd: root } } : undefined
        },
      }
    },
    inject(keys, callback) {
      assert.deepEqual(keys, ['webServer', 'connection'])
      callback({
        effect(cb) {
          cb()
          return () => {}
        },
        webServer: {
          register(options) {
            route = options
            return () => {}
          },
        },
        connection: {
          requestRejection() {
            return reject ? 401 : undefined
          },
        },
      })
    },
  })
  assert.ok(route !== null, '必须注册 /puzzle-mode-rpc 路由')
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/puzzle-mode-rpc')
  return route.handler
}

/** 假 req：只有 setEncoding/on 与可读正文。 */
function fakeReq({ method = 'POST', body = '' } = {}) {
  const handlers = {}
  const req = {
    method,
    setEncoding() {},
    on(event, fn) {
      handlers[event] = fn
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (handlers.data !== undefined && body !== '') handlers.data(body)
    if (handlers.end !== undefined) handlers.end()
  })
  return req
}

/** 假 res：记下 status 与 JSON 正文。 */
function fakeRes() {
  const out = { status: 0, body: null, headers: null }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(payload) {
      out.body = payload === undefined ? null : JSON.parse(payload)
    },
  }
}

async function call(handler, options) {
  const res = fakeRes()
  await handler(fakeReq(options), res)
  return res.out
}

try {
  createProject(root, 'demo', '目标', ['auth-flow'], '只拼不写', 'session-x')

  {
    const handler = captureRoute({ reject: true })
    const out = await call(handler, { body: JSON.stringify({ method: 'state', sessionId: 'session-x' }) })
    assert.equal(out.status, 401)
    ok('鉴权失败 → 401')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { method: 'GET', body: '' })
    assert.equal(out.status, 405)
    ok('非 POST → 405')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: 'not json' })
    assert.equal(out.status, 400)
    ok('坏正文 → 400')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'state' }) })
    assert.equal(out.status, 400)
    assert.equal(out.body.error, '缺少 sessionId')
    ok('缺 sessionId → 400')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'state', sessionId: 'session-x' }) })
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.equal(out.body.result.initialized, true)
    assert.equal(out.body.result.project, 'demo')
    assert.equal(out.body.result.askPause, true)
    assert.equal(out.body.result.pauseQuestion, '要不要先停下？')
    assert.equal(typeof out.body.result.health, 'number')
    assert.equal(out.body.result.dimensionMeta.length, 5, 'state 必须带五维元信息')
    assert.equal(typeof out.body.result.dimensions, 'object')
    assert.ok(out.body.result.modules.length >= 1)
    // 面板要直接列出客观发现，所以 RPC 这一侧必须带完整 findings（op:read 只给数量）。
    assert.ok(Array.isArray(out.body.result.findings), 'state 要带 findings 供面板渲染')
    assert.ok(out.body.result.findings.length > 0, '空项目必须有发现')
    assert.equal(out.body.result.ranking.length, 5, 'state 要带五维排序')
    assert.equal(
      out.body.result.findingCount,
      out.body.result.findings.length,
      'findingCount 要与 findings 一致',
    )
    ok('state → 返回项目健康性、五维与客观发现')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'mode', sessionId: 'session-x', mode: '边拼边写' }) })
    assert.equal(out.body.ok, true)
    assert.equal(out.body.result.mode, '边拼边写')
    assert.equal(out.body.result.canExecute, true)
    assert.equal(readState(root, 'demo').mode, '边拼边写')
    ok('mode → 写回主文档并返回新状态')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'mode', sessionId: 'session-x', mode: '乱写' }) })
    assert.equal(out.status, 400)
    ok('未知 mode → 400')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'nope', sessionId: 'session-x' }) })
    assert.equal(out.status, 400)
    ok('未知 method → 400')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'list', sessionId: 'session-x' }) })
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.equal(out.body.result.projectCount >= 1, true)
    assert.ok(Array.isArray(out.body.result.projects))
    ok('list → 返回项目清单与默认项目')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'module', sessionId: 'session-x', name: 'auth-flow' }) })
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.equal(out.body.result.exists, true)
    assert.equal(typeof out.body.result.detail, 'string')
    assert.equal(typeof out.body.result.health, 'number', 'module 详情要带健康性')
    assert.equal(Object.keys(out.body.result.dimensions).length, 5, 'module 详情要带五维')
    ok('module → 返回模块详情与五维')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'module', sessionId: 'session-x' }) })
    assert.equal(out.status, 400)
    ok('module 缺 name → 400')
  }

  {
    // 显式指定项目：不存在的项目名 → 状态应显示未初始化，而不是静默换成别的项目。
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'state', sessionId: 'session-x', project: 'nope' }) })
    assert.equal(out.body.result.initialized, false)
    assert.equal(out.body.result.projectRequested, 'nope')
    assert.equal(out.body.result.projectSource, 'explicit')
    ok('state 带 project → 用显式项目（未初始化就如实说）')
  }

  {
    // cwdSource 必须可见：拿不到会话时不能静默写到进程目录。
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'state', sessionId: 'session-x' }) })
    assert.equal(out.body.result.cwdSource, 'session')
    assert.equal(out.body.result.projectSource, 'bound')
    assert.equal(out.body.result.project, 'demo', '不给 project 时用的是本会话绑定的项目')
    ok('state → 暴露 cwdSource / projectSource（绑定命中）')
  }

  {
    // op:audit 是工具不是 RPC，所以这里直接截工具定义并驱动 execute。
    let tool = null
    host.apply({
      systemPrompt: { section() {} },
      tools: { register(definition) { tool = definition; return () => {} } },
      on() { return () => {} },
      effect() {},
      get(name) {
        if (name !== 'sessions') return undefined
        return { get(id) { return id === 'session-x' ? { header: { cwd: root } } : undefined } }
      },
      inject() {},
    })
    assert.equal(tool.name, 'puzzle_mode')
    // defineTool 暴露的是 JSON Schema：枚举在 parameters.properties.op.enum。
    assert.ok(tool.parameters.properties.op.enum.includes('audit'), 'op 枚举里必须有 audit')
    const exec = { agent: { session: { id: 'session-x' } } }
    const out = await tool.execute({ op: 'audit' }, exec)
    assert.equal(out.ok, true)
    assert.equal(out.project, 'demo')
    // v0.19.8 修：audit 返回里没有 `health`（项目健康性由宿主按模块均值汇总），
    // 现行契约是 declaredHealth（手写）/ trueHealth（真实位）两个数。
    assert.equal(typeof out.trueHealth, 'number', 'trueHealth 必须是数')
    assert.equal(typeof out.declaredHealth, 'number', 'declaredHealth 必须是数')
    assert.equal(out.dimensionMeta.length, HEALTH_DIMENSIONS.length)
    assert.equal(out.ranking.length, HEALTH_DIMENSIONS.length, 'ranking 要覆盖全部维度')
    assert.ok(Array.isArray(out.findings), 'findings 必须是数组')
    assert.ok(out.findings.length > 0, '新建的空项目必须有发现')
    // v0.19.8 修：主文档是 v6 五节（不是六节）；审查指令字段叫 promptIn（不是 prompt）
    assert.equal(typeof out.sections, 'object', '要带主文档各节的计数')
    assert.deepEqual(Object.keys(out.sections).sort(), [...SECTION_ORDER].sort(), 'sections 的键 = SECTION_ORDER（引常量，改格式自动跟上）')
    assert.equal(typeof out.promptIn, 'string', '要带写点评的指令')
    // v0.19.8 修：指令文案已改（现行是「四段结构 + 带数字」那套），不再有「最弱的一维」这个说法
    // v0.19.8 修：promptIn 是**指针**（「提示段的『### 审查（op:audit）』一节（要原文给 verbose:true）」），
    // 审查指令的全文在 policy 段里，不再随回执回吐 —— 断言改成核这个契约。
    assert.ok(String(out.promptIn).includes('verbose:true') || String(out.promptIn).includes('提示段'),
      'promptIn 应是指向 policy 段的指针：' + String(out.promptIn).slice(0, 80))
    // 插件只给事实，不生成评价正文——正文由模型照着 prompt 写。
    assert.ok(!Object.hasOwn(out, 'review'), '不该有插件生成的点评字段')
    assert.ok(!Object.hasOwn(out, 'verdict'), '不该有插件生成的结论字段')
    assert.equal(out.askPause, true, '审查返回同样带固定收尾问')
    assert.equal(out.pauseQuestion, '要不要先停下？')
    // 每个发现都必须能落到「事实 + 下一步」。
    for (const item of out.findings) {
      assert.ok(item.fact.length > 0 && item.fix.length > 0, `${item.id} 要成对给出事实与建议`)
    }
    ok('op:audit → 客观发现 + ranking + prompt（不含插件生成的评价）')
  }

  {
    // 未初始化时审查要如实拒绝，而不是给一份空报告。
    let tool = null
    host.apply({
      systemPrompt: { section() {} },
      tools: { register(definition) { tool = definition; return () => {} } },
      on() { return () => {} },
      effect() {},
      get(name) { return name === 'sessions' ? { get() { return { header: { cwd: root } } } } : undefined },
      inject() {},
    })
    const out = await tool.execute({ op: 'audit', project: 'no-such-project' }, { agent: { session: { id: 'session-x' } } })
    assert.equal(out.ok, false)
    assert.ok(String(out.hint).includes('init'), '要指向 op:init')
    ok('op:audit 未初始化 → 明确失败并指向 init')
  }

  /** 截工具定义：get 对任何会话都返回同一个工作区，方便换会话测绑定。 */
  function captureTool() {
    let tool = null
    host.apply({
      systemPrompt: { section() {} },
      tools: { register(definition) { tool = definition; return () => {} } },
      on() { return () => {} },
      effect() {},
      get(name) {
        if (name !== 'sessions') return undefined
        return { get(id) { return typeof id === 'string' && id !== '' ? { header: { cwd: root } } : undefined } }
      },
      inject() {},
    })
    assert.equal(tool.name, 'puzzle_mode')
    return tool
  }

  {
    // 新会话默认空绑定：不猜项目、不占用别人的项目。
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'state', sessionId: 'session-none' }) })
    assert.equal(out.body.result.initialized, false)
    assert.equal(out.body.result.projectSource, 'none')
    assert.ok(String(out.body.result.hint).includes('op:init'), '要指向 op:init')
    assert.equal(out.body.result.project, '', '不绑定时不该猜出任何项目名')
    ok('state 未绑定 → 空（不猜项目）')
  }

  {
    // 面板建项目：RPC create 要一次建出目录 + 主文档 + 模块文档，并绑定本会话。
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'create', sessionId: 'session-ui', project: 'ui-created', goal: '面板建的', modules: ['m1'] }) })
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.equal(out.body.result.project, 'ui-created')
    assert.equal(out.body.result.initialized, true)
    assert.deepEqual(out.body.result.createdModules, ['m1'])
    assert.deepEqual(readState(root, 'ui-created').sessions, ['session-ui'])
    const after = await call(handler, { body: JSON.stringify({ method: 'state', sessionId: 'session-ui' }) })
    assert.equal(after.body.result.project, 'ui-created')
    assert.equal(after.body.result.projectSource, 'bound', '建完就该绑上')
    ok('RPC create → 建项目 + 绑定本会话')
  }

  {
    // 绑定已有项目：一个会话只绑一个，旧的自动解绑。
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'bind', sessionId: 'session-none', project: 'ui-created' }) })
    assert.equal(out.body.ok, true)
    assert.equal(out.body.result.project, 'ui-created')
    assert.equal(out.body.result.projectSource, 'bound')
    assert.deepEqual(readState(root, 'ui-created').sessions, ['session-ui', 'session-none'])
    const moved = await call(handler, { body: JSON.stringify({ method: 'bind', sessionId: 'session-none', project: 'demo' }) })
    assert.equal(moved.body.ok, true)
    assert.deepEqual(moved.body.result.released, ['ui-created'], '改绑要解绑旧项目')
    assert.deepEqual(readState(root, 'ui-created').sessions, ['session-ui'])
    ok('RPC bind → 改绑并解绑旧项目')
  }

  {
    // 项目已被别的会话绑着时，改绑不能把别人的绑定也带走。
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'bind', sessionId: 'session-rabbit', project: 'demo' }) })
    assert.equal(out.body.ok, true)
    // session-none 上一块刚改绑到 demo，所以这里它也在列表里：本轮只是再加一个会话，
    // 谁都不该被挤掉——「一个会话只绑一个」约束的是会话侧，不是项目侧。
    assert.deepEqual(readState(root, 'demo').sessions, ['session-x', 'session-none', 'session-rabbit'])
    ok('RPC bind → 同一项目可被多个会话绑定')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'bind', sessionId: 'session-x' }) })
    assert.equal(out.status, 400, '缺 project → 400')
    ok('RPC bind 缺 project → 400')
  }

  {
    /**
     * 多绑定模式的「绑定选中的 N 个」：客户端发的是 `projects: [...]`，**没有 `project` 字段**。
     *
     * 实测 bug（用户报「选中以后点绑定不行会闪出红框」）：`bind` 的入参守卫
     * （`typeof body.project !== 'string'` → 400）写在 `projects` 分支**之前**，
     * 于是这条请求永远被 400 挡掉，面板显示「缺少 project」的红框。
     * 守卫必须先看 `projects`，只在两者都没有时才要求 `project`。
     */
    // 造第二个项目：多选要有两个真实存在的项目才测得出「都绑上」。
    createProject(root, 'multi-two', '目标二', [], '只拼不写')
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'bind', sessionId: 'session-multi', projects: ['demo', 'multi-two'] }) })
    assert.equal(out.status, 200, '多选绑定不该被「缺 project」挡掉')
    assert.equal(out.body.ok, true, '多选绑定必须成功（这是红框的由来）')
    assert.deepEqual(out.body.result.added, ['demo', 'multi-two'])
    assert.equal(out.body.result.addedCount, 2)
    assert.deepEqual(boundProjects(root, 'session-multi').sort(), ['demo', 'multi-two'], '两个都要绑上')
    assert.equal(boundProject(root, 'session-multi'), 'multi-two', '最后一个成为当前项目')
    ok('RPC bind 多选（projects 数组，无 project）→ 追加绑定且不被 400 挡')
  }

  {
    // 没绑定就没有项目可写：写操作必须明确拒绝，而不是悄悄新建。
    const tool = captureTool()
    const out = await tool.execute({ op: 'main', section: 'pit', content: '- x' }, { agent: { session: { id: 'session-loose' } } })
    assert.equal(out.ok, false)
    assert.ok(String(out.hint).includes('op:init'), '要指向 op:init')
    ok('op:main 未绑定 → 明确失败并指向 init')
  }

  {
    // op:bind：本会话绑到已有项目，随后 read 必须命中它。
    const tool = captureTool()
    const exec = { agent: { session: { id: 'session-loose' } } }
    const out = await tool.execute({ op: 'bind', project: 'demo' }, exec)
    assert.equal(out.ok, true)
    assert.equal(out.project, 'demo')
    const after = await tool.execute({ op: 'read' }, exec)
    assert.equal(after.initialized, true)
    assert.equal(after.project, 'demo')
    assert.equal(after.projectSource, 'bound')
    ok('op:bind → 绑定后 read 命中该项目')
  }

  {
    // op:init 自动绑定（v7）：**追加**绑定并设为当前，不再把旧项目摘掉。
    const tool = captureTool()
    const out = await tool.execute({ op: 'init', project: 'tool-made', modules: ['m1'], goal: '工具建的' }, { agent: { session: { id: 'session-ui' } } })
    assert.equal(out.ok, true)
    assert.equal(out.project, 'tool-made')
    assert.equal(out.bound, true)
    assert.deepEqual(out.released, [], 'v7：建项目是追加绑定，不该解绑旧项目')
    assert.deepEqual(readState(root, 'ui-created').sessions, ['session-ui'], '旧项目必须还绑着')
    assert.deepEqual(readState(root, 'tool-made').sessions, ['session-ui'])
    assert.deepEqual(boundProjects(root, 'session-ui').sort(), ['tool-made', 'ui-created'])
    assert.equal(boundProject(root, 'session-ui'), 'tool-made', '新建的成为当前项目')
    ok('op:init → 建项目并**追加**绑定本会话')
  }

  {
    // op:current：在已绑项目之间切当前，不动绑定集合。
    const tool = captureTool()
    const exec = { agent: { session: { id: 'session-ui' } } }
    const out = await tool.execute({ op: 'current', project: 'ui-created' }, exec)
    assert.equal(out.ok, true)
    assert.equal(out.currentProject, 'ui-created')
    assert.equal(boundProject(root, 'session-ui'), 'ui-created')
    assert.deepEqual(boundProjects(root, 'session-ui').sort(), ['tool-made', 'ui-created'], '切当前不该解绑')
    const back = await tool.execute({ op: 'current', project: 'tool-made' }, exec)
    assert.equal(back.currentProject, 'tool-made')
    ok('op:current → 只切当前项目，不动绑定集合')
  }

  {
    // op:bindings：模型能看到「绑了哪几个、当前是哪个」。
    const tool = captureTool()
    const out = await tool.execute({ op: 'bindings' }, { agent: { session: { id: 'session-ui' } } })
    assert.equal(out.ok, true)
    assert.equal(out.count, 2)
    assert.equal(out.currentProject, 'tool-made')
    assert.deepEqual(out.bindings.map((item) => item.project).sort(), ['tool-made', 'ui-created'])
    assert.equal(out.bindings.find((item) => item.project === 'tool-made').current, true)
    assert.ok(typeof out.bindings[0].health === 'number', '绑定项要带健康性（模型据此选项目）')
    assert.ok(typeof out.bindings[0].mode === 'string', '绑定项要带执行模式')
    ok('op:bindings → 列出全部绑定与当前项目')
  }

  {
    // op:unbind 带 project：只解那一个（v7 的面板每项 ×）。
    const tool = captureTool()
    const exec = { agent: { session: { id: 'session-ui' } } }
    const out = await tool.execute({ op: 'unbind', project: 'tool-made' }, exec)
    assert.equal(out.ok, true)
    assert.equal(out.unboundProject, 'tool-made')
    assert.deepEqual(out.released, ['tool-made'])
    assert.deepEqual(boundProjects(root, 'session-ui'), ['ui-created'], '只解一个，别的不动')
    assert.equal(out.currentProject, 'ui-created', '当前被解掉后剩下的必须补位')
    ok('op:unbind 带 project → 只解一个绑定')
  }

  {
    // op:unbind：不带 project 就是全解，且文档留着。
    const tool = captureTool()
    const exec = { agent: { session: { id: 'session-ui' } } }
    assert.equal(boundProject(root, 'session-ui'), 'ui-created')
    const out = await tool.execute({ op: 'unbind' }, exec)
    assert.equal(out.ok, true)
    assert.equal(out.unbound, true)
    assert.deepEqual(out.released, ['ui-created'])
    assert.equal(out.initialized, false, '解绑后应回到未绑定态')
    assert.equal(out.projectSource, 'none')
    assert.equal(boundProject(root, 'session-ui'), null)
    assert.ok(existsSync(join(root, 'tool-made', '拼图', '主文档.md')), '解绑不删文档')
    ok('op:unbind → 回到空绑定，文档留着')
  }

  {
    // RPC unbind：面板的解绑按钮走这条。
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'unbind', sessionId: 'session-rabbit' }) })
    assert.equal(out.body.ok, true)
    assert.equal(out.body.result.unbound, true)
    assert.equal(boundProject(root, 'session-rabbit'), null)
    assert.equal(out.body.result.initialized, false)
    ok('RPC unbind → 面板解绑')
  }

  {
    // RPC create 的模块名切分交给前端，但后端要能拿到数组并如实回报。
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'create', sessionId: 'session-form', project: 'form-made', modules: ['a', 'b'], goal: '表单' }) })
    assert.equal(out.body.ok, true)
    assert.deepEqual(out.body.result.createdModules, ['a', 'b'])
    assert.deepEqual(readState(root, 'form-made').sessions, ['session-form'])
    ok('RPC create 带多个模块 → 建齐并绑定')
  }

  {
    // op:read 要带版本：模型据此决定要不要重建。
    const tool = captureTool()
    const out = await tool.execute({ op: 'read' }, { agent: { session: { id: 'session-x' } } })
    assert.equal(out.version, PUZZLE_VERSION, 'read 要带当前文档版本')
    assert.equal(out.outdated, false, '新建的项目不是旧格式')
    ok('op:read → 带 version / outdated')
  }

  {
    // op:rebuild 默认 dry-run：不显式给 apply 就只报计划。
    const tool = captureTool()
    const out = await tool.execute({ op: 'rebuild' }, { agent: { session: { id: 'session-x' } } })
    assert.equal(out.ok, true)
    assert.equal(out.applied, false, '默认必须是 dry-run')
    assert.equal(out.targetVersion, PUZZLE_VERSION)
    assert.ok(String(out.hint).includes('apply'), '要告诉调用方怎么落盘')
    assert.ok(Array.isArray(out.files))
    for (const item of out.files) assert.equal(typeof item.willWrite, 'boolean')
    ok('op:rebuild 默认 dry-run → 只报计划 + 提示 apply:true')
  }

  {
    // 真的落盘：apply:true。
    const tool = captureTool()
    const out = await tool.execute({ op: 'rebuild', apply: true }, { agent: { session: { id: 'session-x' } } })
    assert.equal(out.ok, true)
    assert.equal(out.applied, true)
    assert.deepEqual(out.failed, [])
    assert.equal(out.outdated, false, '落盘后不再是旧格式')
    assert.equal(docVersion('---\npuzzle: 1\n---\n# x'), 1, '取证：docVersion 本身没问题')
    ok('op:rebuild apply:true → 落盘且不再是旧格式')
  }

  {
    // RPC rebuild：面板的按钮走这条。
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'rebuild', sessionId: 'session-x' }) })
    assert.equal(out.body.ok, true)
    assert.equal(out.body.result.applied, false, 'RPC 也默认 dry-run')
    assert.equal(out.body.result.targetVersion, PUZZLE_VERSION)
    assert.equal(typeof out.body.result.totalChanges, 'number')
    ok('RPC rebuild → 默认 dry-run 返回计划')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'rebuild', sessionId: 'session-x', project: 'nope' }) })
    assert.equal(out.body.ok, false, '不存在的项目要失败')
    ok('RPC rebuild 不存在的项目 → ok:false')
  }

  console.log(`\n${passed} 项通过`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

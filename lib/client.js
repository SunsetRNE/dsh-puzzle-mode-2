/**
 * dsh-puzzle-mode —— 浏览器半。
 *
 * 两个 Slot，共用一个模块级 store：
 *   1) conversation.input.left  —— 模型选择器左边的小按钮（拼图图标 + 健康性角标）
 *   2) shell.overlay           —— 点按钮弹出的拼图面板
 *
 * 面板里有四件事：
 *   - 项目路径 / 项目健康性进度条 / 五维块 / 模块图块；
 *   - **图块可点开**：读该模块文档的要点、相关决策、详细记录（宿主 `method:'module'`）；
 *   - **提问模板**：一键把「带固定收尾问」的提问填进输入框（`inputActions.setDraft`），
 *     不自动发送——把「每次提问必带固定收尾问」从"靠模型自觉"变成"UI 直接给模板"；
 *   - 模式切换（只拼不写 / 边拼边写）与多项目切换。
 *
 * 数据来自宿主半的 `/puzzle-mode-rpc`（同源相对路径）：bundle 客户端没有动态插件的
 * `host.call`，所以走 webServer 路由——与 dsh-session-health 的 `/session-health-rpc` 同一模式。
 *
 * 本文件是**手写的 module-loader 包**（不经过任何打包器）：
 * `window.__ModuleLoader__.load({ id, factory })`，factory 内用 `require('react')`。
 */
window.__ModuleLoader__.load({
  id: 'dsh-puzzle-mode',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var h = React.createElement
    var RPC = '/puzzle-mode-rpc'
    var POLL_MS = 8000
    var PAUSE_QUESTION = '要不要先停下？'
    var PAUSE_OPTIONS = ['停下，等我看过再说', '继续，不用停']

    /**
     * 三种执行模式的一句话说明（面板按钮悬停与下方说明共用）。
     *
     * 为什么要在 UI 里写清楚：`边拼边写` 这个名字在 v5 **换了含义**——
     * 旧含义（一轮做完才问）现在叫 `写后再拼`。只说「AI 可以执行」等于什么都没说，
     * 用户会按旧印象选错模式。
     */
    var MODE_HINTS = {
      '只拼不写': 'AI 只提问 + 更新文档，越权工具会被宿主拦下。',
      '写后再拼': 'AI 先把这一轮改完，再一起汇报与提问（旧名「边拼边写」）。',
      '边拼边写': 'AI 每个写动作之前先问：说清改哪个文件、改成什么，你点头才动手。',
    }

    /**
     * 接续会话模板：**新会话不必通读全部文档**。
     *
     * 为什么需要它：项目文档是「主文档 + N 个模块文档」，全量读一遍是几千字
     * （本项目实测 8888 字符），而其中本轮真正用得到的通常只有一两个模块。
     * 主文档本来就是**查找入口**（模块索引 / 源码索引 / 工具索引 / 坑），
     * 所以正确顺序是「先读入口 → 按需读一个模块 → 按源码索引跳源码」，
     * 而不是把模块目录整个读一遍。
     */
    function resumeTemplate(projectName, projectDir) {
      return [
        '【' + (projectName || '拼图') + ' · 接续会话】',
        '接续这个项目，**不要通读全部文档**——按下面的顺序按需读：',
        '1. puzzle_mode{op:"read", brief:true}：精简档，只有项目名、模式、五维总分、模块清单',
        '   与「下一步该读什么」的指路（本项目实测 2916 → 1105 字符，省 62%）。',
        '2. 只读主文档' + (projectDir ? '：' + projectDir + '/主文档.md' : '（projectDir 下的 主文档.md）'),
        '   —— 它只有五节：模块索引 / 源码索引 / 工具索引 / 坑 / 工作流，是**查找入口**。',
        '3. 按本轮要动的地方，**只读相关的那一个模块文档**（模块/<模块名>.md）；',
        '   不确定该读哪个就先问我，不要靠猜，也不要把模块目录整个读一遍。',
        '4. 需要看实现时，按主文档的「源码索引」直接跳到源码，不要全仓搜。',
        '',
        '读完用三句话回报：这个项目在干什么、当前最弱的一维是哪一维、你打算从哪继续。',
      ].join('\n')
    }

    /**
     * 审查模板：让模型拿 `op:audit` 的**真实值**，再改分数。
     *
     * 关键点：审查不只是评论——它要**把虚高的分改成真实值**，并真的去拆代码。
     * 真实值由插件算（文档证据 + 源码体检），模型不许自己拍。
     */
    function auditTemplate(projectName, projectDir) {
      return [
        '【' + (projectName || '拼图') + ' · 审查（含真实值）】',
        '调 puzzle_mode 的 op:audit 拿客观事实（含五维真实值），然后：',
        '',
        '1. 先看 `inflation` 数组——那是「你之前自评的分」与「真实值」的差额：',
        '   - 逐条用 op:health 带 name 与 append:false，把该模块五维改成 trueValue；',
        '   - 不许反过来改文档凑证据。分数是结论，不是目标。',
        '2. 再看 `source`（源码体检）：文件行数、最长函数、目录分层。',
        '   - 单文件 >800 行要拆，>2000 行必须先拆；巨函数（>60 行）按步骤拆；',
        '   - 「一个文件装下整个项目」先切成 4-8 个文件；',
        '   - 这些**改分数解决不了**，必须真的动代码。拆完再跑一次 op:audit 复核。',
        '3. 最后按五维写点评：最弱一维落在哪个模块、缺哪条证据、下一步动什么。',
        '   - 每条带数字或文档事实；不要「整体不错、建议持续完善」这类空话。',
        '',
        '注意：`fromSource` 是 null 的维度表示**没有源码可查**，那一维不是实测值，要如实说。',
      ].join('\n')
    }

    /**
     * 迁移/重构模板：**全量清理**，不留手。
     *
     * 与 `op:rebuild` 的分工：rebuild 只改**形状**（front-matter、小节存在性），
     * 不动正文；这里要求模型按 v3 规格把**正文也重写一遍**——旧条目超长、没出处、
     * 条数超限，rebuild 一律不管（它刻意不追溯老条目）。两件事都得做。
     */
    function refactorTemplate(projectName) {
      return [
        '【' + (projectName || '拼图') + ' · 迁移/重构】',
        '把当前项目的拼图文档**全量清理并重构到最新规格**，不得留手，绝对服从规格：',
        '1. 先 op:rebuild 看预览 → apply:true 落盘（这一步只改形状：收敛成五节、补小节、拆 悬而未决/已定、删已取消的小节）。',
        '2. 再 op:audit，把返回的 findings **逐条清零**——尤其是 entry_issue / main_entry_issue 这两类。',
        '3. 逐节重写正文，旧内容不保留原样：',
        '   - 主文档五节：模块索引 / 源码索引 / 工具索引 / 坑 / 工作流；**除这五节外不许有任何内容**。',
        '   - 每条一句话，超长就砍到上限内：坑 20 字、其余主文档条目 50 字。',
        '   - 每条必须带（源码: 文件:行）——去源码里核实，**不许编行号**。',
        '   - 模块 ## 悬而未决 ≤4 条、## 已定 ≤10 条：超了删最旧，不论有没有澄清。',
        '   - 模块 ## 要点 ≤20 字、## 详细记录 ≤50 字（详细记录 = 轮汇报）。',
        '4. 旧要点里的长句要**压成一句事实**，不是原样搬过去；搬不动的就删。',
        '5. 重写完再跑一次 op:audit，确认 findings 里不再有 entry_issue / main_entry_issue。',
        '规则冲突时以规格为准；拿不准的删掉而不是留着。',
      ].join('\n')
    }

    /** 快速建空壳：不采访，直接让模型 op:init（项目名会成为工作区里的文件夹名）。 */
    function createTemplate(projectName) {
      return [
        '【' + (projectName || '拼图') + ' · 建项目】',
        '直接调 puzzle_mode 的 op:init 把项目建出来，不要先采访：',
        '- project：<工作区里的文件夹名，请替换成真实项目名>',
        '- modules：<模块名，逗号分隔；每个模块一份文档>',
        '- goal：<一句话目标>',
        '建完把主文档与每个模块文档的路径回报给我；目录固定为 <工作区>/<项目名>/拼图/。',
      ].join('\n')
    }

    /** 采访后再建：先问 ≤5 问把目标与模块划分问清，再一次 op:init。 */
    function interviewTemplate(projectName) {
      return [
        '【' + (projectName || '拼图') + ' · 建项目（先采访）】',
        '先采访再建，不要提前调 op:init：',
        '- 一轮最多 5 问，能用选项就用选项，问的是真正卡住决定的点（目标、模块怎么划、边界在哪）',
        '- 拿到回答后用 op:init **一次同时创建主文档与每个模块一份文档**（显式给 project 与 modules）',
        '- 项目名会成为工作区里的文件夹名；目录固定为 <工作区>/<项目名>/拼图/',
      ].join('\n')
    }

    /**
     * 新建文档：**在「本会话已绑定的项目」里加一份模块文档**。
     *
     * 与「建项目」的分工（这是两个按钮容易混淆的地方，所以在这里写清楚）：
     *   - 空态那三个按钮（直接建 / 快速建空壳 / 采访后再建）走的是 `op:init`，
     *     会**新建一个项目**（新文件夹 + 主文档 + 全部模块文档）；
     *   - 本模板走 `op:module`，**不新建项目**，只在当前项目里加一份文档。
     *
     * 为什么必须连主文档「模块索引」一起写：主文档是**查找入口**，
     * 而 `op:module` 只会把模块名补进 front-matter 的 `计划模块:`（面板图块认它），
     * **不会**自动往 `## 模块索引` 里加一行。少写那一行 = 这份新文档在主文档里查不到，
     * 等于「建了但找不到」。所以模板把这一步显式写进去。
     *
     * 槽位留空（用户裁定）：具体文档名与职责由用户自己填完再发。
     */
    function newDocTemplate(projectName) {
      return [
        '【' + (projectName || '拼图') + ' · 新建文档】',
        '在**当前项目**（不要新建项目、不要用 op:init）里加一份模块文档：',
        '',
        '1. 文档名：<模块名，会成为 模块/<名字>.md>',
        '2. 一句话职责：<这份文档管什么>',
        '3. 初始要点：<已知的结论，一行一条；没有就留空>',
        '',
        '建法：',
        '- 用 puzzle_mode{op:"module", name:"<文档名>", section:"points", content:"- <要点>（源码: 文件:行）"}',
        '  第一次写会自动建出 模块/<文档名>.md（返回 created:true）并补进 front-matter 模块清单；',
        '- 再用 puzzle_mode{op:"main", section:"index", content:"- 模块：<文档名> —— <一句话职责>（源码: 模块/<文档名>.md）"}',
        '  **把这一行写进主文档的「模块索引」**——主文档是查找入口，不写就等于这份文档查不到。',
        '',
        '注意：条目有字数上限（要点 20 字 / 详细记录 50 字 / 坑 20 字），且每条必须带（源码: 文件:行）；',
        '超限会被拒绝写入，不会截断。',
      ].join('\n')
    }

    /** 绑定到已有项目：本会话只绑一个，绑过去之后别的项目上会自动解绑。 */
    function bindTemplate(projectName) {
      return [
        '【绑图 · 绑定项目】',
        '把本会话绑定到项目「' + (projectName || '<项目名>') + '」：',
        '- 调 puzzle_mode 的 op:bind 并给 project（项目已存在，不要用 op:init 重建）',
        '- 绑定后先 op:read 确认 projectSource 变成 bound，再把本轮结论写进该项目的文档',
      ].join('\n')
    }

    /**
     * 工作流模板：**先问目标，再写规则**。
     *
     * 工作流不是待办清单——它是「在某个操作下别做别的事」的约束（例如「改完必须跑构建」）。
     * 所以模板要求模型**先提问确认**，再用 `op:main section:'workflow'` 落盘，
     * 而不是自己拍一条。槽位留空，具体业务由问答定。
     */
    function workflowTemplate(projectName) {
      return [
        '【' + (projectName || '拼图') + ' · 工作流】',
        '先别写文档——用 ask_user_question 把下面这些问清（一轮最多 5 问，能用选项就用选项）：',
        '1. ',
        '2. ',
        '3. ',
        '',
        '拿到回答后，把确定下来的条目用 puzzle_mode{op:"main", section:"workflow"} 写进主文档。',
        '工作流是**约束模型在特定操作下别做别的事**的规则，不是待办清单：一条一句话。',
        '最多 5 条，超了写入时自动删最旧的一条；删掉的进归档，可在面板里逐条删除与恢复。',
      ].join('\n')
    }

    /* ------------------------------- 共享 store ------------------------------- */

    var state = {
      open: false,
      data: null,
      projects: null,
      detail: null,
      detailName: null,
      /**
       * 主文档只读视图：`null` = 没拉过；`{loading:true}` = 正在拉；
       * 否则是 `method:'main'` 的返回（`text` 是完整原文）；失败时是 `{error}`。
       *
       * 面板里**只读**——拼图文档只能由 AI 通过 puzzle_mode 改，做成可编辑就等于开了后门。
       */
      main: null,
      /** 「主文档」区块是否展开（点按钮切换；展开时才去拉 `method:'main'`）。 */
      showMain: false,
      /** 审查结果（五维真实值 + 虚高清单 + 源码体检）；点「审查真实值」时才拉。 */
      audit: null,
      /**
       * 全局开关状态（此后新建的会话带不带拼图模式）。
       *
       * 与项目无关，所以**空态也要能读写**——恰恰是「新会话还没绑项目、
       * 但不想被拼图规则牵着走」这个场景最需要它。
       */
      settings: null,
      loading: false,
      error: null,
      sessionId: undefined,
      /**
       * 输入框动作，来自按钮那一侧。
       *
       * `shell.overlay` 的标准 props **不含 `inputActions`**（只有 `conversation.*`
       * 作用域的 Slot 才有），所以面板拿不到它——必须由 `conversation.input.left` 里的
       * 按钮把 props.inputActions 存进这个共享 store，面板才能填提问模板。
       */
      inputActions: undefined,
      /**
       * 空态表单（表单直建用）。
       *
       * 存在的意义：让「建项目」不必经过模型——模型要走一轮对话，而建一个空壳是纯机械动作。
       * 走 RPC 的 `create` 是同步的，点完立刻就绑好了，省掉一整轮往返。
       */
      formProject: "",
      formModules: "",
      formGoal: "",
      /**
       * 一次性提示（成功但需要说明的事，例如「项目已存在，本次没动绑定」）。
       *
       * 与 `error` 分开：它不是失败，红字会让人以为出错了。每次 load 时清掉。
       */
      notice: null,
      /**
       * 样式自检结果（`apply` 挂样式表后读一次真实计算值）。
       * `applied:false` 表示**面板没有样式**——那才是「缩在左上角、文字重叠」的原因，
       * 与项目数据无关。`null` 表示还没测到。
       */
      styleDiag: null,
    }
    var listeners = new Set()

    function emit() {
      for (var fn of Array.from(listeners)) {
        try {
          fn()
        } catch (_error) {
          /* 单个渲染错误不能影响其它订阅者 */
        }
      }
    }

    function setState(patch) {
      state = Object.assign({}, state, patch)
      emit()
    }

    function subscribe(fn) {
      listeners.add(fn)
      return function () {
        listeners.delete(fn)
      }
    }

    function useStore(inputActions) {
      var pair = React.useState(0)
      var tick = pair[0]
      var bump = pair[1]
      React.useEffect(function () {
        return subscribe(function () {
          bump(function (value) {
            return value + 1
          })
        })
      }, [])
      return { tick: tick, state: state, setState: setState }
    }

    /* --------------------------------- 取数 --------------------------------- */

    function post(payload) {
      return fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (res) {
        return res.json()
      })
    }

    function load(sessionId, project) {
      if (sessionId === undefined || sessionId === null) {
        setState({ error: '当前会话没有会话 ID，无法读取拼图状态', loading: false })
        return
      }
      setState({ loading: true })
      var body = { method: 'state', sessionId: String(sessionId) }
      if (project !== undefined && project !== null && project !== '') body.project = String(project)
      post(body)
        .then(function (json) {
          // `notice` 不清：它是给用户看的一次性说明（如「项目已存在，没动绑定」），
          // 而轮询每 8 秒跑一次 `load`，在这里清掉就等于用户根本来不及看到。
          if (json && json.ok === true) setState({ data: json.result, error: null, loading: false })
          else setState({ error: (json && json.error) || '未知错误', loading: false })
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    function loadProjects(sessionId) {
      if (sessionId === undefined || sessionId === null) return
      post({ method: 'list', sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) setState({ projects: json.result })
        })
        .catch(function () {
          /* 列表失败不覆盖主状态 */
        })
    }

    /**
     * 取审查结果（含**五维真实值**与源码体检）。
     *
     * 为什么要单独拉：面板默认只显示**声明值**（模型自己写的分），而审查的价值在于
     * 「真实值是多少、虚高在哪」。这份数据由插件算（文档证据 + 源码体检），不占对话。
     */
    function loadAudit(sessionId, project) {
      if (sessionId === undefined || sessionId === null) return
      var body = { method: 'audit', sessionId: String(sessionId) }
      if (project !== undefined && project !== null && project !== '') body.project = String(project)
      post(body)
        .then(function (json) {
          if (json && json.ok === true) setState({ audit: json.result })
          else setState({ audit: { error: (json && json.error) || '审查读取失败' } })
        })
        .catch(function () {
          setState({ audit: { error: '无法连接 ' + RPC } })
        })
    }

    /**
     * **按会话**开关：只影响当前这个会话。
     *
     * 判定只认会话 ID，所以必须把**真实的 sessionId** 传给宿主——
     * 早先用占位串 `'panel'` 只因为那时是全局时刻、与谁在调无关；
     * 现在这个占位串会被当成一个不存在的会话，开关就失灵了。
     */
    function loadSettings(sessionId) {
      if (sessionId === undefined || sessionId === null || sessionId === '') {
        setState({ settings: { error: '当前会话没有会话 ID，无法读写开关' } })
        return
      }
      post({ method: 'settings', sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) setState({ settings: json.result })
          else setState({ settings: { error: (json && json.error) || '开关读取失败' } })
        })
        .catch(function () {
          setState({ settings: { error: '无法连接 ' + RPC } })
        })
    }

    function writeSettings(sessionId, disabled) {
      if (sessionId === undefined || sessionId === null || sessionId === '') {
        setState({ error: '当前会话没有会话 ID，无法切换开关' })
        return
      }
      post({ method: 'settings', sessionId: String(sessionId), disabled: disabled === true })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({
              settings: json.result,
              notice: json.result.disabled === true
                ? '已关掉**本会话**的拼图模式；其他会话不受影响。'
                : '已恢复**本会话**的拼图模式。',
            })
          } else {
            setState({ error: (json && json.error) || '开关写入失败' })
          }
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC })
        })
    }

    function loadDetail(sessionId, name, project) {
      if (sessionId === undefined || sessionId === null) return
      var body = { method: 'module', sessionId: String(sessionId), name: String(name) }
      if (project !== undefined && project !== null && project !== '') body.project = String(project)
      post(body)
        .then(function (json) {
          if (json && json.ok === true) setState({ detail: json.result, detailName: name })
          else setState({ detail: { error: (json && json.error) || '读取失败' }, detailName: name })
        })
        .catch(function () {
          setState({ detail: { error: '无法连接 ' + RPC }, detailName: name })
        })
    }

    /**
     * 取主文档原文（含 front-matter）与工作流条目 / 归档。
     *
     * 面板里**只读**：拼图文档只能由 AI 通过 puzzle_mode 改，做成可编辑就等于开了后门。
     * 工作流区块的数据也来自这一次调用——`state` 摘要里不含工作流，所以面板打开时
     * 顺手拉一次，删/恢复之后再拉一次（`text` 跟着变了，不能只改本地数组）。
     */
    function loadMain(sessionId, project) {
      if (sessionId === undefined || sessionId === null) {
        setState({ main: { error: '当前会话没有会话 ID，无法读取主文档' } })
        return
      }
      // 合并而不是覆盖：重新拉取时先留着上一次的原文与工作流（否则删一条之后整块会闪一下空白）。
      // `error` 要清掉：否则上一次失败的红字会跟着新一次请求活到成功之后。
      setState({ main: Object.assign({}, state.main, { loading: true, error: undefined }) })
      var body = { method: 'main', sessionId: String(sessionId) }
      if (project !== undefined && project !== null && project !== '') body.project = String(project)
      post(body)
        .then(function (json) {
          if (json && json.ok === true) setState({ main: json.result })
          else setState({ main: { error: (json && json.error) || '主文档读取失败' } })
        })
        .catch(function () {
          setState({ main: { error: '无法连接 ' + RPC } })
        })
    }

    /**
     * 工作流条目的删除 / 恢复。
     *
     * 这是**面板里唯一会改主文档的动作**，所以删除走二次确认（`window.confirm`），
     * 恢复也走二次确认：工作流满 5 条时，恢复会**挤掉最旧的一条**（那条会被推回归档，
     * 不是丢掉，但对用户来说是「我的规则列表变了」），所以必须让他知道再点。
     * `index` 是 1 起的序号，与宿主契约一致；成功后宿主回的是**整份状态摘要**，
     * 所以这里按 `writeMode` 那套直接整体换 `data`。
     *
     * 删除时会带 `expected`（那一行的原文）：宿主用它做**身份校验**。
     * 为什么需要：`index` 是位置语义——同一次渲染里连点两次「删除」，第二次会删掉
     * 补位上来的另一条。带上原文，过期就拒绝，不会误删。
     */
    function workflowAction(view, action, index, changed) {
      var sessionId = view.state.sessionId
      if (sessionId === undefined || sessionId === null) {
        setState({ error: '当前会话没有会话 ID，无法改动工作流' })
        return
      }
      var data = view.state.data
      setState({ loading: true })
      var body = { method: 'workflow', sessionId: String(sessionId), action: action, index: index }
      if (data !== null && data !== undefined && data.initialized === true && data.project) body.project = String(data.project)
      // 只对删除做身份校验：恢复是按归档序号取，归档只在删除时追加，语义已经稳定。
      if (action === 'remove' && typeof changed === 'string' && changed !== '') body.expected = changed
      post(body)
        .then(function (json) {
          if (json && json.ok === true) {
            var result = json.result || {}
            var evicted = Array.isArray(result.evicted) ? result.evicted : []
            var notice
            if (action === 'remove') {
              notice = '已删除工作流第 ' + index + ' 条：' + String(result.changed || changed || '') + '（在下面「归档」里可以恢复）'
            } else if (evicted.length > 0) {
              // 挤掉的那条**回到了归档**，所以这里说清「不是丢了」，并指路怎么再恢复。
              notice = '已恢复：' + String(result.changed || '') + '；工作流原本已满，最旧的一条被挤回「归档」：' + evicted.join('；') + '（想找回它就在归档里点恢复）'
            } else {
              notice = '已恢复：' + String(result.changed || '')
            }
            setState({ data: result, error: null, loading: false, notice: notice })
            // 主文档原文跟着变了：重新拉一次，别只改本地数组（下次刷新就会露馅）。
            loadMain(sessionId, result.project)
          } else {
            // 宿主给了 hint（例如「面板已过期，重新打开再删」）就一起显示，别只丢一句 error。
            var message = (json && json.error) || '工作流写入失败'
            if (json && typeof json.hint === 'string' && json.hint !== '') message += '（' + json.hint + '）'
            setState({ error: message, loading: false })
          }
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    /** 删除一条工作流：**二次确认**后才真的调 RPC。 */
    function removeWorkflow(view, index, text) {
      var ok = window.confirm('删掉工作流第 ' + index + ' 条？\n\n' + String(text || '') + '\n\n（会进归档，可在面板里恢复）')
      if (ok !== true) return
      workflowAction(view, 'remove', index, text)
    }

    /**
     * 恢复一条归档条目：同样**二次确认**。
     *
     * 与删除的唯一区别：工作流已满 5 条时，恢复会挤掉最旧的那一条（它会被推回归档）。
     * 所以确认文案要预告这件事，而不是让用户在结果里才发现列表变了。
     */
    function restoreWorkflow(view, index, text) {
      var list = []
      var main = view.state.main
      if (main !== null && main !== undefined && Array.isArray(main.workflow)) list = main.workflow
      var full = list.length >= 5
      var ok = window.confirm('把这一条恢复回工作流？\n\n' + String(text || '')
        + (full
          ? '\n\n⚠️ 工作流已满 5 条：恢复会把最旧的一条「' + String(list[0] || '') + '」挤回归档（不是丢掉，归档里还能恢复）。'
          : ''))
      if (ok !== true) return
      workflowAction(view, 'restore', index, text)
    }

    /**
     * 表单直建：把项目名 / 模块名 / 目标填好，直接调 RPC `create` —— **不经过模型**。
     *
     * 与两个模板按钮的分工：模板按钮是「让 AI 来建」（会问、会拆模块），
     * 这里是「我自己填好了，立刻建」（机械动作，不该占一轮对话）。
     * 模块名按逗号/顿号/空格切，空名与重复名交给宿主 `slugify` 去重。
     */
    function createByForm(view) {
      var sessionId = view.state.sessionId
      var project = String(view.state.formProject || "").trim()
      if (sessionId === undefined || sessionId === null) {
        setState({ error: '当前会话没有会话 ID，无法建项目' })
        return
      }
      if (project === "") {
        setState({ error: '请先填项目名（它会成为工作区里的文件夹名）' })
        return
      }
      var modules = String(view.state.formModules || "")
        .split(/[,，、;；\s]+/)
        .map(function (item) { return item.trim() })
        .filter(function (item) { return item !== "" })
      setState({ loading: true })
      post({
        method: 'create',
        sessionId: String(sessionId),
        project: project,
        modules: modules,
        goal: String(view.state.formGoal || "").trim(),
      })
        .then(function (json) {
          if (json && json.ok === true) {
            var result = json.result || {}
            // 项目已存在 → 宿主**没有**改绑定。必须把这件事说出来：
            // 否则用户填了个已有项目名、点「立刻建」，会以为自己绑过去了。
            setState({
              error: null,
              loading: false,
              formProject: '',
              formModules: '',
              formGoal: '',
              notice: result.mainCreated === true
                ? '已建好并绑定本会话。'
                : '项目已存在，**没有改动绑定**（要改绑请用项目下拉）。',
            })
          } else {
            setState({ error: (json && json.error) || '建项目失败', loading: false })
          }
          load(sessionId)
          loadProjects(sessionId)
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    /**
     * 重建文档格式。
     *
     * 两步走：先 dry-run 把「将要改什么」摆出来（**不落盘**），再让用户点第二次才 apply。
     * 为什么不一步到位：重建是破坏性的，而本项目不自动备份——预览就是唯一的刹车。
     */
    function rebuildNow(view, apply) {
      var sessionId = view.state.sessionId
      var data = view.state.data
      if (sessionId === undefined || sessionId === null) {
        setState({ error: '当前会话没有会话 ID，无法重建' })
        return
      }
      if (data === null || data === undefined || data.initialized !== true) {
        setState({ error: '还没有项目可重建' })
        return
      }
      setState({ loading: true, rebuild: null })
      post({ method: 'rebuild', sessionId: String(sessionId), project: String(data.project), apply: apply === true })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({ error: null, loading: false, rebuild: json.result })
            if (apply === true) {
              load(sessionId)
              loadProjects(sessionId)
            }
          } else {
            setState({ error: (json && json.error) || '重建失败', loading: false })
          }
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    /** 重建预览：逐文件列出将要改什么，并给「落盘」按钮。 */
    function rebuildBlock(view) {
      var r = view.state.rebuild
      if (r === null || r === undefined) return null
      var files = Array.isArray(r.files) ? r.files : []
      var rows = []
      for (var i = 0; i < files.length; i += 1) {
        var item = files[i]
        if (!Array.isArray(item.changes) || item.changes.length === 0) continue
        rows.push(h(
          'div',
          { className: 'dshpz-finding', key: item.kind + ':' + item.name, 'data-level': item.willWrite ? 'warn' : 'info' },
          h('span', { className: 'dshpz-flevel' }, item.kind === 'main' ? '主' : '模'),
          h(
            'div',
            null,
            h('div', { className: 'dshpz-ffact' }, item.name + ' · v' + item.version),
            h('div', { className: 'dshpz-ffix' }, item.changes.join('；')),
          ),
        ))
      }
      return h(
        'div',
        { className: 'dshpz-sect' },
        h(
          'div',
          { className: 'dshpz-secttitle' },
          '重建预览 · 文档格式 v' + r.version + ' → v' + r.targetVersion + '（' + r.totalChanges + ' 处改动）',
        ),
        rows.length === 0
          ? h('div', { className: 'dshpz-muted' }, '已经是当前格式，无需重建。')
          : h('div', { className: 'dshpz-findings' }, rows),
        r.applied === true
          ? h('div', { className: 'dshpz-muted' }, '已落盘：' + (r.written || []).join('、'))
          : h(
            'div',
            { className: 'dshpz-row', style: { marginTop: '6px' } },
            h(
              'button',
              {
                className: 'dshpz-act',
                title: '把上面这些改动写进文档（正文不动，只改 front-matter 形状与缺失的小节）',
                onClick: function () { rebuildNow(view, true) },
              },
              '落盘',
            ),
            h('span', { className: 'dshpz-muted' }, '本项目不自动备份，落盘前请确认'),
          ),
      )
    }

    /** 解绑本会话（回到没绑定）。解绑后重新 load，面板会回到空态。 */
    function unbind(view) {
      var sessionId = view.state.sessionId
      if (sessionId === undefined || sessionId === null) {
        setState({ error: '当前会话没有会话 ID，无法解绑' })
        return
      }
      setState({ loading: true })
      post({ method: 'unbind', sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) {
            // 解绑后没有项目了：主文档/工作流视图必须清掉，否则还显示着上一个项目的原文。
            setState({ error: null, loading: false, detail: null, detailName: null, main: null, showMain: false })
          } else {
            setState({ error: (json && json.error) || '解绑失败', loading: false })
          }
          load(sessionId)
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    /**
     * 把本会话绑到某个项目。
     *
     * 绑定是**会话级**的，所以成功后必须重新 load 一次（不带 project）——
     * 让宿主按绑定重新解析，面板显示的才是真实归属。
     */
    function bindTo(view, project) {
      var sessionId = view.state.sessionId
      if (sessionId === undefined || sessionId === null || project === undefined || project === null || project === "") {
        setState({ error: '要绑定需要会话 ID 与项目名' })
        return
      }
      setState({ loading: true })
      post({ method: 'bind', sessionId: String(sessionId), project: String(project) })
        .then(function (json) {
          if (json && json.ok === true) setState({ error: null, loading: false, detail: null, detailName: null })
          else setState({ error: (json && json.error) || '绑定失败', loading: false })
          load(sessionId)
          // 换了项目 → 主文档与工作流也换了，必须重拉（否则「主文档」页签还停在上一个项目的原文）。
          loadMain(sessionId, project)
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    function writeMode(sessionId, mode, project) {
      if (sessionId === undefined || sessionId === null) return
      setState({ loading: true })
      var body = { method: 'mode', sessionId: String(sessionId), mode: mode }
      if (project !== undefined && project !== null && project !== '') body.project = String(project)
      post(body)
        .then(function (json) {
          if (json && json.ok === true) setState({ data: json.result, error: null, loading: false })
          else setState({ error: (json && json.error) || '模式写入失败', loading: false })
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    /* --------------------------------- 样式 --------------------------------- */

    /**
     * 主题令牌：**换肤唯一入口**。
     *
     * 为什么内联在这里、不拆成 `lib/theme.js`：浏览器半是**手写的 module-loader 包**，
     * 它的 `require` 只认平台种子与「已注册的包工厂」——裸相对路径 `./theme.js`
     * 会直接抛 `missed the module table`（实测宿主 `dsh-client-modules` 的实现如此）。
     * 拆出去就是一个永远加载不了的文件，所以主题必须留在本文件内。
     *
     * 为什么仍然值得单独成块：用户裁定「先做 A 科幻 HUD，真机验过不好再退 D 极简」。
     * 换风格的代价必须是**改这一块**，而不是满文件找颜色值——所以下面所有 CSS
     * 都只引用 `--dshpz-*`，不写死任何颜色/圆角/阴影。
     *
     * 与宿主的关系：宿主（`dsh-client-ui-theme`）只有 99 个 `--dsw-alias-*` **语义**
     * 令牌，**没有**字体/圆角/阴影/间距令牌。所以这里分两层：
     *   1) 基底（bg/label/border/state）**收口宿主令牌** → 宿主切浅色/深色主题时面板自动跟随；
     *   2) HUD 部分（主色、发光、玻璃、尺度、字体栈）宿主没有，自建。
     *
     * 硬约束（用户裁定）：零新依赖、零外部资源。所有特效纯 CSS，图标内联 SVG。
     */
    var THEME_HUD = {
      // 基底：值仍是宿主令牌，所以主题跟随宿主
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      bg3: 'var(--dsw-alias-bg-layer-3)',
      bgOverlay: 'var(--dsw-alias-bg-overlay)',
      label1: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      label3: 'var(--dsw-alias-label-tertiary)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      // HUD 自建：青蓝主色。发光**只给当前状态**用——满屏发光是页游，不是 3A。
      accent: '#22d3ee',
      accentHi: '#5eead4',
      accentLo: '#0e7490',
      /**
       * 主色之上的**前景色**：实心主色按钮/徽标里的文字。
       *
       * 为什么必须是深色而不是 `#fff`：主色是亮青（#22d3ee），白字在上面几乎读不出来。
       * 这类「主色的对比色」在宿主令牌里没有对应项，所以只能自建，但**必须收进令牌**——
       * 否则换 D 极简主题（主色变成宿主品牌色，可能是深色）时，这里就会变成白底白字。
       */
      onAccent: '#04121a',
      /**
       * 面板底色。
       *
       * `color-mix()` 需要 Chrome 111+ / Safari 16.2+。它在这里若用来做**半透明底色**，
       * 老浏览器上的退化结果是「整个面板变透明」——连下面的对话都盖不住，那是坏掉而不是降级。
       * 所以基底一律用宿主的**不透明**令牌，半透明/光晕只作为叠加层（`glassSheen`）。
       */
      glass: 'var(--dsw-alias-bg-overlay)',
      /** 叠加在底色上的极淡主色光晕：纯装饰，不支持 color-mix 时整层消失也无妨。 */
      glassSheen: 'linear-gradient(135deg,color-mix(in srgb,#22d3ee 9%,transparent),transparent 62%)',
      /** 网格/扫描线：纯装饰，不支持时整层消失（`transparent` 兜底）。 */
      grid: 'color-mix(in srgb, #22d3ee 10%, transparent)',
      /**
       * 发光：只给「当前状态」（选中页签、达标进度、聚焦输入框）用。
       * 退化值是一道**实心描边**而不是无：老浏览器上仍然看得见「哪个是选中的」，
       * 只是少了光晕。发光本身是效果，选中态是信息——信息不能因兼容性丢掉。
       */
      glow: '0 0 0 1px #22d3ee',
      shadow: '0 1px 2px rgba(0,0,0,.4), 0 24px 64px -12px rgba(0,0,0,.65)',
      radiusSm: '6px',
      radiusMd: '10px',
      radiusLg: '16px',
      fontUi: 'system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif',
      fontMono: 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace',
      durIn: '260ms',
      durFast: '120ms',
      easeOut: 'cubic-bezier(.16,1,.3,1)',
      easeStd: 'cubic-bezier(.4,0,.2,1)',
    }

    /**
     * D 案：现代极简（备选）。
     *
     * 用户原话「先做 A，我真机验过不好再 D」——所以这份先写好放着。
     * 它与 A **共用全部布局与结构**，差别只在颜色/发光/圆角：
     * 真机不满意时把 `THEME` 指向它即可，不必改任何 CSS。
     */
    var THEME_MINIMAL = {
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      bg3: 'var(--dsw-alias-bg-layer-3)',
      bgOverlay: 'var(--dsw-alias-bg-overlay)',
      label1: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      label3: 'var(--dsw-alias-label-tertiary)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      // 极简：主色跟随宿主品牌色、不透明底、无网格、无发光、单层轻投影。
      accent: 'var(--dsw-alias-brand-primary)',
      accentHi: 'var(--dsw-alias-brand-primary)',
      accentLo: 'var(--dsw-alias-brand-primary)',
      // 极简主题的主色是宿主品牌色（深浅不定），所以前景直接取宿主的反色令牌——
      // 这是「为什么对比色必须收进令牌」的实证：A 案写死深色，D 案就必须换成反色。
      onAccent: 'var(--dsw-alias-label-primary-inverted)',
      glass: 'var(--dsw-alias-bg-overlay)',
      // 极简不要光晕层：`none` 是合法 background-image 值，规则层不必为此写分支。
      glassSheen: 'none',
      grid: 'transparent',
      glow: '0 0 0 1px var(--dsw-alias-border-l2)',
      shadow: '0 12px 40px rgba(0,0,0,.28)',
      radiusSm: '8px',
      radiusMd: '14px',
      radiusLg: '20px',
      fontUi: 'system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif',
      fontMono: 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace',
      durIn: '200ms',
      durFast: '100ms',
      easeOut: 'cubic-bezier(.16,1,.3,1)',
      easeStd: 'cubic-bezier(.4,0,.2,1)',
    }

    /** 当前生效主题。**换肤只改这一行**：THEME_HUD ↔ THEME_MINIMAL。 */
    var THEME = THEME_HUD

    /**
     * 主题对象 → `--dshpz-*: 值` 声明串。
     *
     * 命名转换必须**同时**处理两种边界，否则变量名对不上、属性静默失效：
     *   - 大写字母：`accentHi` → `accent-hi`（驼峰）
     *   - 字母接数字：`label1` → `label-1`（**这一条曾经漏掉**：`label1` 被转成
     *     `--dshpz-label1`，而 CSS 里写的是 `var(--dshpz-label-1)`，于是 bg/label/border
     *     这 8 个基底变量**全部取不到值**——面板会退回继承色，肉眼看着「还行」，
     *     但主题令牌整套是废的。这类 bug 不会报错，只能靠「逐个变量核对」抓出来。）
     */
    function themeVars(theme) {
      var out = []
      for (var key in theme) {
        if (!Object.prototype.hasOwnProperty.call(theme, key)) continue
        var cssKey = key
          .replace(/([a-z])([0-9])/g, '$1-$2')
          .replace(/[A-Z]/g, function (ch) { return '-' + ch.toLowerCase() })
        out.push('--dshpz-' + cssKey + ':' + theme[key])
      }
      return out.join(';')
    }

    /**
     * 面板样式。
     *
     * 布局：**宽屏三栏工作台**（左＝项目与操作，中＝健康性与模块，右＝文档与审查），
     * 窄屏（<900px）自动堆叠回单栏——手机端一行不改也能用。
     * 断点只有一个（900px）：多断点会让「手机/电脑」两套意图变得难以维护。
     */
    var CSS = [
      // 令牌挂在面板根上：作用域限定在面板内，不污染宿主其它 UI。
      '.dshpz-panel{' + themeVars(THEME) + '}',

      /* ------------------------------- 外壳与入场 ------------------------------- */
      // `inset:0` 是 Chrome 87+（2020-11）才有的简写。老 WebView 会**整条丢弃**它，
      // 于是 fixed 元素没有偏移量 → 塌成内容大小、停在静态位置（左上角）、盖不住屏幕，
      // 而 `.dshpz-panel` 的 `width:min(...)`（Chrome 79+）若一起失效，
      // 三栏网格（264 + 1fr + 424）就被塞进一个内容宽的窄框里 → **列与列重叠**。
      // 实测症状正是「面板缩在左上角、文字互相压着、宿主 UI 透出来」。
      // 所以这里一律用**长手写 top/right/bottom/left**，不用 inset 简写。
      '.dshpz-backdrop{position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,.45);pointer-events:auto;display:flex;align-items:center;justify-content:center;padding:24px;z-index:40;animation:dshpz-fade var(--dshpz-dur-in) var(--dshpz-ease-out)}',
      '@keyframes dshpz-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes dshpz-rise{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}',
      '@keyframes dshpz-grow{from{transform:scaleX(0)}}',
      '@keyframes dshpz-sheen{from{background-position:-160% 0}to{background-position:260% 0}}',
      // 面板：玻璃底 + 网格纹理 + 顶部一道主色高光。网格用 repeating-linear-gradient 纯 CSS 画，不引图片。
      // **宽度与高度先给纯 CSS 2.1 的写法，再用 min() 覆盖**：`min()` 不认时前面的声明仍然生效，
      // 面板至少是「一屏宽、不超视口高」，而不是退化成内容宽度把三栏挤成一团。
      '.dshpz-panel{position:relative;width:100%;max-width:1240px;max-height:88vh;width:min(1240px,100%);max-height:min(88vh,940px);display:flex;flex-direction:column;overflow:hidden;background-color:var(--dshpz-glass);background-image:var(--dshpz-glass-sheen);color:var(--dshpz-label-1);border:1px solid var(--dshpz-border-2);border-radius:var(--dshpz-radius-lg);box-shadow:var(--dshpz-shadow);font-family:var(--dshpz-font-ui);font-size:13px;animation:dshpz-rise var(--dshpz-dur-in) var(--dshpz-ease-out)}',
      // 背景模糊单独一条：老浏览器不认就整条丢弃，底色与内容都不受影响。
      //
      // **`color-mix` 必须再套一层 `@supports`**（v0.16.2 修的）：
      // 外层只问 `backdrop-filter`，而 `color-mix` 是另一项独立特性
      // （Chrome 111+ / Safari 16.2+）。浏览器完全可能「认 backdrop-filter 但不认 color-mix」
      // ——比如 Chrome 76~110：`@supports` 判定通过、进了这个块，
      // 但 `background-color:color-mix(...)` 是**无效值**，会被整条丢弃。
      // 后果不是「没模糊」，而是 `background-color` 在这个块里**被覆盖成无效**，
      // 基底那条 `background-color:var(--dshpz-glass)` 也一起失效 → **面板变成全透明**，
      // 宿主 UI 从面板底下透出来。这正是「面板透明、文字与宿主内容重叠」的成因。
      // 现在只有**两项都支持**时才覆盖底色，否则老老实实用不透明基底。
      '@supports ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.dshpz-panel{backdrop-filter:blur(18px) saturate(1.2);-webkit-backdrop-filter:blur(18px) saturate(1.2)}}',
      '@supports (color:color-mix(in srgb,red 50%,blue)){.dshpz-panel{background-color:color-mix(in srgb,var(--dshpz-glass) 88%,transparent)}}',
      '.dshpz-panel::before{content:"";position:absolute;top:0;right:0;bottom:0;left:0;pointer-events:none;background-image:linear-gradient(var(--dshpz-grid) 1px,transparent 1px),linear-gradient(90deg,var(--dshpz-grid) 1px,transparent 1px);background-size:34px 34px;mask-image:radial-gradient(120% 90% at 50% 0,#000 30%,transparent 78%);-webkit-mask-image:radial-gradient(120% 90% at 50% 0,#000 30%,transparent 78%)}',
      '.dshpz-panel::after{content:"";position:absolute;left:0;right:0;top:0;height:1px;pointer-events:none;background:linear-gradient(90deg,transparent,var(--dshpz-accent),transparent);opacity:.75}',
      // 面板内所有滚动条统一成细的，避免宿主默认粗条打断视觉。
      '.dshpz-panel *{scrollbar-width:thin;scrollbar-color:var(--dshpz-border-2) transparent}',
      '.dshpz-panel ::-webkit-scrollbar{width:8px;height:8px}',
      '.dshpz-panel ::-webkit-scrollbar-thumb{background:var(--dshpz-border-2);border-radius:99px}',

      /* --------------------------------- 页头 --------------------------------- */
      '.dshpz-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--dshpz-border-1);background:linear-gradient(180deg,color-mix(in srgb,var(--dshpz-accent) 7%,transparent),transparent)}',
      '.dshpz-logo{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;color:var(--dshpz-on-accent);background:linear-gradient(135deg,var(--dshpz-accent-hi),var(--dshpz-accent));box-shadow:0 0 16px -3px var(--dshpz-accent)}',
      '.dshpz-headtext{flex:1 1 auto;min-width:0}',
      '.dshpz-title{margin:0;font-size:15px;font-weight:650;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshpz-sub{font-size:11px;color:var(--dshpz-label-2);margin-top:1px;font-family:var(--dshpz-font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshpz-close{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);background:transparent;color:var(--dshpz-label-2);cursor:pointer;transition:color var(--dshpz-dur-fast) var(--dshpz-ease-std),border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),transform var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-close:hover{color:var(--dshpz-label-1);border-color:var(--dshpz-border-2);transform:translateY(-1px)}',
      '.dshpz-close:active{transform:translateY(0)}',

      /* ------------------------------ 三栏工作台 ------------------------------ */
      // 宽屏三栏：左（项目与操作）固定 260，中（数据）自适应，右（文档）420。
      //
      // **先给纯 CSS 2.1 的固定三列，再用 minmax 覆盖**（v0.16.2）：
      // `minmax()` 是 Chrome 57+，虽不算新，但一旦哪条声明整条被丢弃，
      // 三栏就会退化成「一列挤三份内容」——列与列**重叠**，正是截图里那个样子。
      // 固定列宽在窄屏本来就会被 `@media` 换成块级，所以这层兜底没有副作用。
      '.dshpz-body{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:264px auto 424px;grid-template-columns:264px minmax(0,1fr) 424px;gap:0}',
      '.dshpz-col{min-width:0;overflow:auto;padding:14px 16px}',
      '.dshpz-col + .dshpz-col{border-left:1px solid var(--dshpz-border-1)}',
      // 单栏堆叠时（手机/窄窗）取消分栏与左边框，回到纵向流。
      // 同时**收起页头的健康性徽标**：窄屏上它会和副标题挤成两行，
      // 而中栏的环形总览本来就把这个数字放得更大——重复且更差。
      //
      // 手机端滑不动的原因（实测）：窄屏把 `.dshpz-col` 改成 `overflow:visible` 后，
      // 三栏内容整体高度**超出** `.dshpz-body`（`flex:1 1 auto;min-height:0`），
      // 而面板是 `overflow:hidden` + `max-height:92vh` —— 多出来的部分被裁掉，
      // 里面又没有可滚动容器，于是手指往上推什么也不动。
      // 修法：窄屏把 `.dshpz-body` 从 grid 换成块级并**自己滚动**（`overflow-y:auto`），
      // 页头仍然 `flex:0 0 auto` 钉在顶部；`overscroll-behavior:contain` 防止
      // 滑到底后把滚动链传给宿主页面（那会让面板被拖走）。
      '@media (max-width:900px){.dshpz-body{display:block;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}.dshpz-col{overflow:visible}.dshpz-col + .dshpz-col{border-left:0;border-top:1px solid var(--dshpz-border-1)}.dshpz-panel{max-height:92vh;width:100%}.dshpz-backdrop{padding:10px}.dshpz-head .dshpz-heroval{display:none}}',

      /* -------------------------------- 区块 -------------------------------- */
      '.dshpz-sect{margin-top:14px}',
      '.dshpz-sect:first-child{margin-top:0}',
      // 小节标题：左侧一道主色竖条 + 等宽大写，是 HUD 的「分区标牌」。
      '.dshpz-secttitle{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:var(--dshpz-label-2);margin-bottom:8px}',
      '.dshpz-secttitle::before{content:"";flex:0 0 auto;width:2px;height:11px;border-radius:2px;background:linear-gradient(180deg,var(--dshpz-accent-hi),var(--dshpz-accent-lo))}',
      '.dshpz-secttitle .dshpz-count{margin-left:auto;font-family:var(--dshpz-font-mono);font-size:10px;color:var(--dshpz-label-3);letter-spacing:0;text-transform:none}',

      /* -------------------------------- 控件 -------------------------------- */
      '.dshpz-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);background:transparent;color:var(--dshpz-label-2);cursor:pointer;font-size:12px;line-height:1;font-family:inherit;transition:color var(--dshpz-dur-fast) var(--dshpz-ease-std),border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),background var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-btn:hover{color:var(--dshpz-label-1);border-color:var(--dshpz-border-2);background:var(--dshpz-bg-2)}',
      '.dshpz-btn[data-on="1"]{color:var(--dshpz-accent);border-color:var(--dshpz-accent);box-shadow:var(--dshpz-glow)}',
      // 主按钮：唯一使用实心主色的控件，用来标记「这一步是主动作」。
      '.dshpz-act{display:inline-flex;align-items:center;gap:5px;background:transparent;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);color:var(--dshpz-label-2);padding:5px 10px;font-size:12px;cursor:pointer;font-family:inherit;line-height:1.2;text-align:left;transition:color var(--dshpz-dur-fast) var(--dshpz-ease-std),border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),background var(--dshpz-dur-fast) var(--dshpz-ease-std),transform var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-act:hover{color:var(--dshpz-label-1);border-color:var(--dshpz-border-2);background:var(--dshpz-bg-2);transform:translateY(-1px)}',
      '.dshpz-act:active{transform:translateY(0)}',
      '.dshpz-act[data-on="1"]{color:var(--dshpz-accent);border-color:var(--dshpz-accent);background:color-mix(in srgb,var(--dshpz-accent) 12%,transparent);box-shadow:var(--dshpz-glow)}',
      '.dshpz-act[data-tone="danger"]:hover{color:var(--dshpz-err);border-color:var(--dshpz-err)}',
      '.dshpz-acts{display:flex;flex-wrap:wrap;gap:6px}',
      '.dshpz-acts-vert{display:flex;flex-direction:column;gap:6px}',
      '.dshpz-acts-vert .dshpz-act{justify-content:flex-start;width:100%}',
      '.dshpz-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshpz-muted{color:var(--dshpz-label-2);font-size:12px}',
      '.dshpz-mono{font-family:var(--dshpz-font-mono);font-size:11px}',

      /* ------------------------------- 健康性总览 ------------------------------- */
      // 大数字 + 环形进度：整块面板的「主读数」，一眼看到项目状态。
      '.dshpz-hero{display:flex;align-items:center;gap:14px;padding:12px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-md);background:linear-gradient(135deg,color-mix(in srgb,var(--dshpz-accent) 8%,transparent),transparent 60%)}',
      '.dshpz-ring{flex:0 0 auto;position:relative;width:74px;height:74px}',
      '.dshpz-ring svg{display:block;transform:rotate(-90deg)}',
      '.dshpz-ringcircle{fill:none;stroke:var(--dshpz-bg-3);stroke-width:7}',
      '.dshpz-ringfill{fill:none;stroke:url(#dshpz-ringgrad);stroke-width:7;stroke-linecap:round;transition:stroke-dashoffset 700ms var(--dshpz-ease-out)}',
      '.dshpz-ringnum{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;align-items:center;justify-content:center;font-family:var(--dshpz-font-mono);font-size:19px;font-weight:650;color:var(--dshpz-label-1)}',
      '.dshpz-herotext{min-width:0}',
      '.dshpz-herolabel{font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:var(--dshpz-label-2)}',
      '.dshpz-heroval{font-size:13px;color:var(--dshpz-label-1);margin-top:2px}',

      /* --------------------------------- 五维 --------------------------------- */
      '.dshpz-dims{display:flex;flex-direction:column;gap:7px}',
      '.dshpz-dim{display:grid;grid-template-columns:82px minmax(0,1fr) 62px;align-items:center;gap:9px;font-size:12px}',
      '.dshpz-dimname{color:var(--dshpz-label-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshpz-dimbar{position:relative;height:6px;border-radius:99px;background:var(--dshpz-bg-3);overflow:hidden}',
      '.dshpz-dimfill{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--dshpz-accent-lo),var(--dshpz-accent-hi));transform-origin:left;animation:dshpz-grow 700ms var(--dshpz-ease-out)}',
      // 真实值对照行：名字 / 声明→实测 / 差额标签。**与 .dshpz-dim 分开**——
      // 两者子元素个数不同（这里是 3 列对照，上面是「名字+条+值」），
      // 硬塞进同一个 grid 模板会让其中一边错位。
      '.dshpz-dimcmp{display:grid;grid-template-columns:82px minmax(0,1fr) auto;align-items:center;gap:9px;font-size:12px}',
      '.dshpz-dimcmp .dshpz-dimbar{grid-column:2 / -1}',
      '.dshpz-dimpair{display:inline-flex;align-items:baseline;gap:6px;font-family:var(--dshpz-font-mono);font-size:11px;color:var(--dshpz-label-2)}',
      // 真实值用一层半透明的「第二段」压在声明值上，直接看出虚高多少。
      '.dshpz-dimtrue{position:absolute;left:0;top:0;height:100%;border-radius:99px;background:color-mix(in srgb,var(--dshpz-warn) 70%,transparent)}',
      '.dshpz-dimval{text-align:right;font-family:var(--dshpz-font-mono);font-size:11px;color:var(--dshpz-label-2);white-space:nowrap}',
      '.dshpz-dimval[data-true="1"]{color:var(--dshpz-accent);font-weight:650}',
      '.dshpz-dimcmp[data-bad="1"] .dshpz-dimval[data-true="1"]{color:var(--dshpz-err)}',
      '.dshpz-arrow{color:var(--dshpz-label-3);font-size:10px}',
      '.dshpz-dimnote{grid-column:1 / -1;color:var(--dshpz-label-3);font-size:10px;line-height:1.35;margin-top:-2px}',

      /* -------------------------------- 模块卡 -------------------------------- */
      '.dshpz-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(126px,1fr));gap:8px}',
      '.dshpz-tile{position:relative;display:flex;flex-direction:column;gap:6px;min-height:84px;padding:9px;text-align:left;color:inherit;font:inherit;cursor:pointer;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-md);background:var(--dshpz-bg-1);overflow:hidden;transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),transform var(--dshpz-dur-fast) var(--dshpz-ease-std),box-shadow var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      // 悬停时卡片抬 1px + 出现主色边——比整块变色克制，也更像「可点」。
      '.dshpz-tile:hover{border-color:var(--dshpz-accent);transform:translateY(-1px);box-shadow:0 6px 18px -10px var(--dshpz-accent)}',
      '.dshpz-tile[data-on="1"]{border-color:var(--dshpz-accent);box-shadow:var(--dshpz-glow)}',
      '.dshpz-tile[data-empty="1"]{opacity:.45}',
      '.dshpz-tile[data-static="1"]{cursor:default}',
      '.dshpz-tile b{font-size:12px;font-weight:600;line-height:1.25;word-break:break-word}',
      '.dshpz-tilebar{height:4px;border-radius:99px;background:var(--dshpz-bg-3);overflow:hidden}',
      '.dshpz-tilefill{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--dshpz-ok),var(--dshpz-accent-hi));transform-origin:left;animation:dshpz-grow 600ms var(--dshpz-ease-out)}',
      '.dshpz-pct{font-family:var(--dshpz-font-mono);font-size:10px;color:var(--dshpz-label-2)}',

      /* ------------------------------- 分段控件 ------------------------------- */
      '.dshpz-seg{display:inline-flex;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);overflow:hidden;background:var(--dshpz-bg-1)}',
      '.dshpz-seg button{background:transparent;border:0;color:var(--dshpz-label-2);padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit;transition:background var(--dshpz-dur-fast) var(--dshpz-ease-std),color var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-seg button:hover{color:var(--dshpz-label-1);background:var(--dshpz-bg-2)}',
      '.dshpz-seg button[data-on="1"]{background:linear-gradient(135deg,var(--dshpz-accent),var(--dshpz-accent-lo));color:var(--dshpz-on-accent);font-weight:600}',

      /* -------------------------------- 提示条 -------------------------------- */
      '.dshpz-notice{display:flex;gap:7px;align-items:flex-start;margin:10px 0 0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--dshpz-accent) 45%,transparent);border-radius:var(--dshpz-radius-sm);background:color-mix(in srgb,var(--dshpz-accent) 10%,transparent);color:var(--dshpz-label-1);font-size:12px;line-height:1.45}',
      '.dshpz-err{display:flex;gap:7px;align-items:flex-start;margin:10px 0 0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--dshpz-err) 50%,transparent);border-radius:var(--dshpz-radius-sm);background:color-mix(in srgb,var(--dshpz-err) 10%,transparent);color:var(--dshpz-err);font-size:12px;line-height:1.45}',
      '.dshpz-warn{display:flex;gap:7px;align-items:flex-start;margin:10px 0 0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--dshpz-warn) 50%,transparent);border-radius:var(--dshpz-radius-sm);background:color-mix(in srgb,var(--dshpz-warn) 10%,transparent);color:var(--dshpz-warn);font-size:12px;line-height:1.45}',
      '.dshpz-hint{margin-top:12px;padding-top:10px;border-top:1px solid var(--dshpz-border-1);color:var(--dshpz-label-2);font-size:11.5px;line-height:1.6}',

      /* --------------------------------- 详情 --------------------------------- */
      '.dshpz-detail{margin-top:12px;padding:11px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-md);background:var(--dshpz-bg-1)}',
      '.dshpz-detail h4{margin:0 0 7px;font-size:13px;display:flex;align-items:center;gap:7px}',

      /* ------------------------------ 条目（书签） ------------------------------ */
      '.dshpz-entries{display:flex;flex-direction:column;gap:4px;margin:0 0 10px}',
      // 每条左侧一道细条：合规=中性、不合规=警告色。比整条描边更省视觉噪音。
      '.dshpz-entry{display:flex;align-items:flex-start;gap:7px;font-size:12px;line-height:1.5;background:var(--dshpz-bg-1);border:1px solid var(--dshpz-border-1);border-left-width:3px;border-radius:var(--dshpz-radius-sm);padding:6px 9px;transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),background var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-entry:hover{background:var(--dshpz-bg-2)}',
      '.dshpz-entry[data-bad="1"]{border-left-color:var(--dshpz-warn)}',
      '.dshpz-entry:not([data-bad="1"]){border-left-color:var(--dshpz-border-2)}',
      '.dshpz-entrynum{flex:0 0 auto;min-width:18px;font-family:var(--dshpz-font-mono);font-size:10px;color:var(--dshpz-label-3);padding-top:2px}',
      '.dshpz-entrybody{flex:1 1 auto;color:var(--dshpz-label-1);word-break:break-word}',
      '.dshpz-entrysrc{font-family:var(--dshpz-font-mono);color:var(--dshpz-label-3);font-size:10.5px}',
      '.dshpz-entryflag{flex:0 0 auto;color:var(--dshpz-warn);font-size:10px;white-space:nowrap;border:1px solid color-mix(in srgb,var(--dshpz-warn) 45%,transparent);border-radius:99px;padding:1px 6px}',

      /* --------------------------------- 表单 --------------------------------- */
      '.dshpz-in{display:block;width:100%;box-sizing:border-box;margin-bottom:6px;background:var(--dshpz-bg-1);color:var(--dshpz-label-1);border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);padding:7px 9px;font-size:12px;font-family:inherit;transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),box-shadow var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-in:focus{outline:none;border-color:var(--dshpz-accent);box-shadow:var(--dshpz-glow)}',
      '.dshpz-in::placeholder{color:var(--dshpz-label-3)}',
      '.dshpz-sel{background:var(--dshpz-bg-1);color:var(--dshpz-label-1);border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);padding:6px 8px;font-size:12px;font-family:inherit;max-width:100%}',
      '.dshpz-sel:focus{outline:none;border-color:var(--dshpz-accent)}',


      /* ------------------------------- 发现（审查） ------------------------------- */
      '.dshpz-findings{display:flex;flex-direction:column;gap:7px}',
      '.dshpz-finding{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--dshpz-border-1);border-left-width:3px;border-radius:var(--dshpz-radius-sm);padding:8px 10px;background:var(--dshpz-bg-1)}',
      '.dshpz-finding[data-level="blocker"]{border-left-color:var(--dshpz-err)}',
      '.dshpz-finding[data-level="warn"]{border-left-color:var(--dshpz-warn)}',
      '.dshpz-finding[data-level="info"]{border-left-color:var(--dshpz-border-2)}',
      '.dshpz-flevel{flex:0 0 auto;font-family:var(--dshpz-font-mono);font-size:10px;color:var(--dshpz-label-3);padding-top:1px;text-transform:uppercase}',
      '.dshpz-ffact{font-size:12px;line-height:1.5}',
      '.dshpz-ffix{font-size:11.5px;line-height:1.5;color:var(--dshpz-label-2);margin-top:3px}',

      /* ------------------------------- 主文档视图 ------------------------------- */
      '.dshpz-doc{margin:0;max-height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--dshpz-font-mono);font-size:11.5px;line-height:1.6;color:var(--dshpz-label-1);background:var(--dshpz-bg-1);border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);padding:10px}',
      '.dshpz-docpath{font-family:var(--dshpz-font-mono);font-size:10.5px;color:var(--dshpz-label-3);word-break:break-all;margin-bottom:6px}',

      /* ------------------------------- 工作流条目 ------------------------------- */
      '.dshpz-wf{display:flex;align-items:flex-start;gap:7px;font-size:12px;line-height:1.5;background:var(--dshpz-bg-1);border:1px solid var(--dshpz-border-1);border-left:3px solid var(--dshpz-accent);border-radius:var(--dshpz-radius-sm);padding:6px 9px;transition:background var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-wf:hover{background:var(--dshpz-bg-2)}',
      '.dshpz-wf[data-arch="1"]{opacity:.62;border-left-color:var(--dshpz-border-2)}',
      '.dshpz-wfbody{flex:1 1 auto;color:var(--dshpz-label-1);word-break:break-word}',

      /* -------------------------------- 空态 -------------------------------- */
      '.dshpz-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:26px 16px;text-align:center;color:var(--dshpz-label-2);border:1px dashed var(--dshpz-border-2);border-radius:var(--dshpz-radius-md);background:color-mix(in srgb,var(--dshpz-bg-1) 60%,transparent)}',
      '.dshpz-emptyicon{color:var(--dshpz-label-3)}',
      '.dshpz-emptytitle{font-size:13px;color:var(--dshpz-label-1);font-weight:600}',

      /* ------------------------------- 加载骨架 ------------------------------- */
      '.dshpz-skel{position:relative;overflow:hidden;height:12px;border-radius:6px;background:var(--dshpz-bg-2);margin-bottom:8px}',
      '.dshpz-skel::after{content:"";position:absolute;top:0;right:0;bottom:0;left:0;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--dshpz-label-1) 12%,transparent),transparent);background-size:160% 100%;animation:dshpz-sheen 1.3s linear infinite}',

      /* --------------------------- 减少动效（无障碍） --------------------------- */
      // 尊重系统设置：用户开了「减少动态效果」就全部关掉，只保留状态切换本身。
      '@media (prefers-reduced-motion:reduce){.dshpz-backdrop,.dshpz-panel,.dshpz-dimfill,.dshpz-tilefill,.dshpz-skel::after{animation:none!important;transition:none!important}}',
    ].join('\n')

    /* --------------------------------- 图块 --------------------------------- */

    /** 五维的名字与顺序（与宿主 `HEALTH_DIMENSIONS` 对齐；UI 只读不改）。 */
    var DIMENSION_LABELS = {
      complexity: '任务复杂度',
      extensibility: '可拓展性',
      maintenance: '维护系数',
      quality: '代码质量',
      reusability: '可复用性',
    }
    var DIMENSION_KEYS = ['complexity', 'extensibility', 'maintenance', 'quality', 'reusability']

    /* ------------------------------- 图标（内联 SVG） ------------------------------- */

    /**
     * 图标一律内联 SVG：**零外部资源、零字体依赖**（用户裁定）。
     *
     * 用 `currentColor` 取色，所以图标自动跟随所在控件的文字颜色（悬停/选中态都跟着变），
     * 不需要为每个状态各写一份样式。
     */
    var ICON_PATHS = {
      // 拼图块：品牌标识与面板标题。
      puzzle: 'M6.2 1.5a1.7 1.7 0 0 1 1.7 1.7v.6h2.6v2.6h.6a1.7 1.7 0 0 1 0 3.4h-.6v2.6H7.9v-.6a1.7 1.7 0 0 0-3.4 0v.6H1.9V9.8h.6a1.7 1.7 0 0 1 0-3.4h-.6V3.8h2.6v-.6a1.7 1.7 0 0 1 1.7-1.7Z',
      // 刷新：环形箭头。
      refresh: 'M8 2.6a5.4 5.4 0 1 0 5.2 6.9h-1.6A3.9 3.9 0 1 1 8 4.1v1.7l2.6-2.3L8 1.2v1.4Z',
      // 关闭：叉。
      close: 'M4 4l8 8M12 4l-8 8',
      // 文档：纸页。
      doc: 'M4 1.8h5l3 3v9.4H4V1.8Zm5 0v3h3',
      // 规则/工作流：列表带勾。
      rules: 'M2.4 4.2l1.4 1.4 2.4-2.4M2.4 11l1.4 1.4 2.4-2.4M8.6 5h5.4M8.6 11.8h5.4',
      // 审查：放大镜。
      scan: 'M7.2 2.6a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2Zm3.4 7.9l3 3',
      // 模块：方块阵。
      grid: 'M2.4 2.4h4.4v4.4H2.4V2.4Zm6.8 0h4.4v4.4H9.2V2.4ZM2.4 9.2h4.4v4.4H2.4V9.2Zm6.8 0h4.4v4.4H9.2V9.2Z',
      // 警示：三角。
      alert: 'M8 2.2l6 10.6H2L8 2.2Zm0 4v3.4M8 11.6v.1',
      // 归档：盒。
      archive: 'M2.2 3h11.6v3H2.2V3Zm1 3v7h9.6V6M6.4 8.6h3.2',
      // 空态：圆里一道横。
      inbox: 'M8 2.6a5.4 5.4 0 1 1 0 10.8A5.4 5.4 0 0 1 8 2.6Zm-2.6 5.4h5.2',
    }

    /**
     * 画一个图标。`size` 默认 14（与 12px 正文的视觉重量匹配）。
     * `stroke` 型图标（close/rules/scan/doc/alert/archive/inbox）走描边，
     * `fill` 型（puzzle/refresh/grid）走填充——两类混用时靠视觉重量对齐，不靠同一套线宽。
     */
    function icon(name, size, opts) {
      var path = ICON_PATHS[name]
      if (path === undefined) return null
      var s = size === undefined ? 14 : size
      var filled = name === 'puzzle' || name === 'refresh' || name === 'grid'
      var extra = opts || {}
      var props = {
        width: s,
        height: s,
        viewBox: '0 0 16 16',
        'aria-hidden': true,
        style: { flex: '0 0 auto', display: 'block' },
      }
      if (filled) props.fill = 'currentColor'
      else {
        props.fill = 'none'
        props.stroke = 'currentColor'
        props.strokeWidth = extra.weight === 'bold' ? 2 : 1.5
        props.strokeLinecap = 'round'
        props.strokeLinejoin = 'round'
      }
      return h('svg', props, h('path', { d: path }))
    }

    /* ------------------------------- 健康性总览 ------------------------------- */

    /**
     * 大读数：环形进度 + 百分比 + 一句状态。
     *
     * 为什么值得单独做一块：面板里其它数字都是细节，只有「项目健康性」是**一句话结论**。
     * 环形（而不是横条）是因为它在三栏布局里占地更方，且环心天然适合放那个大数字。
     *
     * 环用 SVG `stroke-dasharray` + `stroke-dashoffset` 画：纯 CSS/SVG，不引图表库。
     * 半径 30、周长 2πr≈188.5——`offset = 周长 × (1 - 分数/100)`。
     */
    function heroRing(score) {
      var value = Math.max(0, Math.min(100, Number(score) || 0))
      var R = 30
      var C = 2 * Math.PI * R
      var offset = C * (1 - value / 100)
      return h(
        'div',
        { className: 'dshpz-ring' },
        h(
          'svg',
          { width: 74, height: 74, viewBox: '0 0 74 74', 'aria-hidden': true },
          // 渐变描边：需要 defs + 唯一 id；面板同时只开一个，所以固定 id 不会冲突。
          h(
            'defs',
            null,
            h(
              'linearGradient',
              { id: 'dshpz-ringgrad', x1: '0', y1: '0', x2: '1', y2: '1' },
              h('stop', { offset: '0', stopColor: 'var(--dshpz-accent-hi)' }),
              h('stop', { offset: '1', stopColor: 'var(--dshpz-accent-lo)' }),
            ),
          ),
          h('circle', { className: 'dshpz-ringcircle', cx: 37, cy: 37, r: R }),
          h('circle', {
            className: 'dshpz-ringfill',
            cx: 37,
            cy: 37,
            r: R,
            strokeDasharray: String(C),
            strokeDashoffset: String(offset),
          }),
        ),
        h('div', { className: 'dshpz-ringnum' }, String(value)),
      )
    }

    /**
     * 一句状态：把分数翻成中文档位。
     *
     * 分档是刻意的**粗**（四档）：健康性本身是证据的粗略度量，给出「82 分很健康」这种
     * 精确措辞会假装它比实际更准。四档只回答「现在该不该慌」。
     */
    function healthVerdict(score) {
      var v = Number(score) || 0
      if (v >= 85) return '文档证据充分，可以直接动手'
      if (v >= 70) return '基本可用，有若干维度缺证据'
      if (v >= 50) return '证据偏薄，改动前先补文档'
      return '证据很少，建议先补要点与决策'
    }

    /** 一维一条小进度条；分数来自宿主汇总，UI 不自己算。 */
    function dimensionRow(key, value) {
      return h(
        'div',
        { className: 'dshpz-dim', key: key },
        h('span', { className: 'dshpz-dimname' }, DIMENSION_LABELS[key] || key),
        h('span', { className: 'dshpz-dimbar' }, h('span', { className: 'dshpz-dimfill', style: { width: value + '%' } })),
        h('span', { className: 'dshpz-dimval' }, value + '%'),
      )
    }

    /**
     * 真实值区块：声明值 vs 真实值，逐维对照 + 虚高清单 + 源码体检。
     *
     * 这是面板里最该被看见的一块——因为「模型自评的分」几乎总是偏高，
     * 而真实值由插件算（文档证据 + 源码体检），模型改不了它。
     */
    function truthBlock(view) {
      var audit = view.state.audit
      if (audit === null || audit === undefined) return null
      if (audit.error !== undefined) {
        return h('div', { className: 'dshpz-sect' }, h('div', { className: 'dshpz-err' }, String(audit.error)))
      }
      var declared = audit.declaredDimensions || {}
      var trueVals = audit.trueDimensions || {}
      var rows = DIMENSION_KEYS.map(function (key) {
        var d = declared[key] || 0
        var t = trueVals[key] === undefined ? null : trueVals[key]
        var gap = t === null ? 0 : d - t
        var reason = (audit.reasons || {})[key] || {}
        var tag = []
        if (t === null) tag.push('未实测')
        else if (gap >= 15) tag.push('虚高 ' + gap)
        else if (gap > 0) tag.push('偏高 ' + gap)
        return h(
          'div',
          { className: 'dshpz-dimcmp', key: key, 'data-bad': gap >= 15 ? '1' : '0' },
          h('span', { className: 'dshpz-dimname' }, DIMENSION_LABELS[key] || key),
          // 声明 → 实测：两个数字等宽对齐，差额用颜色标签，扫一眼就知道哪一维在虚高。
          h(
            'span',
            { className: 'dshpz-dimpair' },
            h('span', { className: 'dshpz-dimval' }, String(d) + '%'),
            h('span', { className: 'dshpz-arrow' }, '→'),
            h('span', { className: 'dshpz-dimval', 'data-true': '1' }, t === null ? '—' : (t + '%')),
          ),
          tag.length === 0 ? null : h('span', { className: 'dshpz-entryflag' }, tag.join('')),
          // 双条：底层是声明值，上层叠真实值——虚高的那段会露出底层的颜色。
          h(
            'span',
            { className: 'dshpz-dimbar' },
            h('span', { className: 'dshpz-dimfill', style: { width: d + '%' } }),
            t === null ? null : h('span', { className: 'dshpz-dimtrue', style: { width: t + '%' } }),
          ),
          reason.fromSource === null || reason.fromSource === undefined
            ? null
            : h('span', { className: 'dshpz-dimnote' }, '文档 ' + reason.fromDoc + ' / 源码 ' + reason.fromSource),
        )
      })
      var src = audit.source || {}
      var srcLines = []
      if (src.skipped === true) {
        srcLines.push(h('div', { className: 'dshpz-warn', key: 'skip' }, '⚠ 没查到源码，真实值只由文档证据推出（不是实测值）：' + String(src.note || '')))
      } else {
        srcLines.push(h('div', { className: 'dshpz-muted', key: 'base' }, '源码根：' + (src.base || '?')))
        srcLines.push(h('div', { className: 'dshpz-muted', key: 'size' }, src.fileCount + ' 个文件 / ' + src.totalLines + ' 行' + (src.largest ? ' · 最大 ' + src.largest.name + ' ' + src.largest.lines + ' 行' : '')))
        for (var i = 0; i < (src.findings || []).length; i += 1) {
          var f = src.findings[i]
          srcLines.push(h('div', { className: f.level === 'fail' ? 'dshpz-err' : 'dshpz-warn', key: 'f' + i }, (f.level === 'fail' ? '✗ ' : '⚠ ') + f.fact))
        }
      }
      return h(
        'div',
        { className: 'dshpz-sect' },
        h('div', { className: 'dshpz-secttitle' }, '真实值（声明 → 实测）· 项目 ' + (audit.declaredHealth || 0) + '% → ' + (audit.trueHealth || 0) + '%'),
        h('div', { className: 'dshpz-dims' }, rows),
        h('div', { className: 'dshpz-secttitle', style: { marginTop: '8px' } }, '源码体检'),
        h('div', null, srcLines),
      )
    }

    /** 图块：模块块可点开详情；五维块与模块块共用一套渲染。 */
    function tile(piece, view) {
      var empty = piece.kind === 'module' && piece.exists === false
      var counts = piece.counts || {}
      var detail = []
      if (counts.points) detail.push('点 ' + counts.points)
      if (counts.pending) detail.push('悬 ' + counts.pending)
      if (counts.decided) detail.push('定 ' + counts.decided)
      var clickable = piece.kind === 'module'
      var on = view.state.detailName === piece.name ? '1' : '0'
      var props = {
        className: 'dshpz-tile',
        'data-empty': empty ? '1' : '0',
        'data-on': on,
        'data-static': clickable ? '0' : '1',
        key: piece.id,
        title: clickable ? '点开看模块详情' : piece.id,
      }
      if (clickable) {
        props.onClick = function () {
          if (view.state.detailName === piece.name) setState({ detail: null, detailName: null })
          else loadDetail(view.state.sessionId, piece.name, view.state.data && view.state.data.project)
        }
      }
      return h(
        'button',
        props,
        h('b', null, piece.name),
        h(
          'div',
          { className: 'dshpz-tilebar' },
          h('div', { className: 'dshpz-tilefill', style: { width: piece.score + '%' } }),
        ),
        h('div', { className: 'dshpz-pct' }, empty ? '未建' : piece.score + '%'),
        detail.length > 0 ? h('div', { className: 'dshpz-pct' }, detail.join(' · ')) : null,
      )
    }

    /* ------------------------------- 模块详情 ------------------------------- */

    /**
     * 把一段正文按**条**拆开渲染：一条一个卡片（书签感），不再是一整块 `<pre>`。
     *
     * 为什么：一整个 `<pre>` 读起来像读源码，条目之间没有边界；拆成一条一张卡片后
     * 每条独立可扫，也才能一眼看出哪条超长、哪条没带出处。
     *
     * 每条都做合规检查：超长标 `超N字`、没出处标 `缺出处`——审查发现问题时，
     * 面板里能直接看到**是哪一条**。
     */
    function entryCards(text, limit, requireSource) {
      var lines = String(text || '').split(/\r?\n/).filter(function (line) {
        return line.trim() !== ''
      })
      return lines.map(function (line, index) {
        var bare = line.replace(/^\s*[-*]\s*/, '').trim()
        var mark = bare.indexOf('（源码')
        var body = mark < 0 ? bare : bare.slice(0, mark).trim()
        var source = mark < 0 ? '' : bare.slice(mark).replace(/^（源码\s*[:：]?\s*/, '').replace(/）\s*$/, '')
        // 按码点数数：一个汉字算 1，与宿主的 ENTRY_LIMITS 口径一致。
        var count = Array.from(body).length
        var flags = []
        if (count > limit) flags.push('超' + (count - limit) + '字')
        if (requireSource !== false && source === '') flags.push('缺出处')
        return h(
          'div',
          { className: 'dshpz-entry', key: 'e' + index, 'data-bad': flags.length > 0 ? '1' : '0' },
          h('span', { className: 'dshpz-entrynum' }, String(index + 1)),
          h(
            'span',
            { className: 'dshpz-entrybody' },
            body,
            source === ''
              ? null
              : h('span', { className: 'dshpz-entrysrc' }, ' ' + source),
          ),
          flags.length === 0
            ? null
            : h('span', { className: 'dshpz-entryflag' }, flags.join(' · ')),
        )
      })
    }

    /** 一个「条目小节」：标题 + 计数 + 逐条卡片。 */
    function entrySection(heading, text, limit, requireSource) {
      var cards = entryCards(text, limit, requireSource)
      if (cards.length === 0) return null
      return h(
        'div',
        { key: heading },
        h('div', { className: 'dshpz-muted' }, heading + '（' + cards.length + ' 条，每条 ≤' + limit + ' 字 + 出处）'),
        h('div', { className: 'dshpz-entries' }, cards),
      )
    }

    function detailBlock(view) {
      var detail = view.state.detail
      if (detail === null || detail === undefined) return null
      if (detail.error !== undefined) {
        return h('div', { className: 'dshpz-detail' }, h('div', { className: 'dshpz-err' }, String(detail.error)))
      }
      var parts = []
      if (detail.exists !== true) {
        parts.push(h('div', { className: 'dshpz-muted', key: 'none' }, '这个模块还没建文档。'))
      } else {
        if (detail.dimensions !== undefined && detail.dimensions !== null) {
          parts.push(h(
            'div',
            { key: 'h' },
            h('div', { className: 'dshpz-muted' }, '五维健康性'),
            h('div', { className: 'dshpz-dims' }, DIMENSION_KEYS.map(function (key) {
              return dimensionRow(key, detail.dimensions[key] || 0)
            })),
          ))
        }
        // 逐条渲染（书签式）：模块索引指向模块文档，所以不强制源码出处。
        var sections = [
          entrySection('要点', detail.points, 20, true),
          entrySection('悬而未决', detail.pending, 20, true),
          entrySection('已定', detail.decided, 20, true),
          entrySection('可复用', detail.reuse, 20, true),
          entrySection('详细记录 · 轮汇报', detail.detail, 50, true),
        ].filter(Boolean)
        if (sections.length === 0) {
          parts.push(h('div', { className: 'dshpz-muted', key: 'empty' }, '文档还是空的。'))
        } else {
          parts = parts.concat(sections)
        }
      }
      return h(
        'div',
        { className: 'dshpz-detail' },
        h('h4', null, '模块 · ' + detail.name + (detail.health === undefined ? '' : ' · 健康性 ' + detail.health + '%')),
        parts,
      )
    }

    /* ------------------------------ 客观发现 ------------------------------ */

    /**
     * 审查的「事实」半边：规则数出来的发现，直接给人看。
     *
     * 另一半（一针见血的点评）由模型写——面板只提供入口（「审查」按钮填提问模板）。
     */
    function findingsBlock(view) {
      var data = view.state.data
      var list = data !== null && data !== undefined && Array.isArray(data.findings) ? data.findings : []
      if (list.length === 0) {
        return h(
          'div',
          { className: 'dshpz-sect' },
          h('div', { className: 'dshpz-secttitle' }, '审查 · 客观发现（0）'),
          h('div', { className: 'dshpz-muted' }, '没有发现「文档与数字对不上」的地方。'),
        )
      }
      var order = { blocker: 0, warn: 1, info: 2 }
      var sorted = list.slice().sort(function (a, b) {
        var left = order[a.level] === undefined ? 3 : order[a.level]
        var right = order[b.level] === undefined ? 3 : order[b.level]
        return left - right
      })
      return h(
        'div',
        { className: 'dshpz-sect' },
        h('div', { className: 'dshpz-secttitle' }, '审查 · 客观发现（' + list.length + '）'),
        h('div', { className: 'dshpz-findings' }, sorted.map(function (item) {
          return h(
            'div',
            { className: 'dshpz-finding', key: item.id, 'data-level': item.level },
            h('span', { className: 'dshpz-flevel' }, item.level === 'blocker' ? '堵' : (item.level === 'warn' ? '补' : '提')),
            h(
              'div',
              null,
              h('div', { className: 'dshpz-ffact' }, (item.scope === 'project' ? '项目' : item.scope) + '：' + item.fact),
              h('div', { className: 'dshpz-ffix' }, '→ ' + item.fix),
            ),
          )
        })),
        h('div', { className: 'dshpz-muted' }, '以上是规则数出来的事实；点评由 AI 写——点「审查」把请求填进输入框。'),
      )
    }

    /* ------------------------- 工作流（可删可恢复） ------------------------- */

    /**
     * 工作流区块：当前条目（1 起编号，右侧「✕ 删除」）+ 归档（右侧「恢复」）。
     *
     * 数据来自 `method:'main'`——`state` 摘要里没有工作流，所以这一段和主文档共用一次取数。
     * 删除是**唯一会改主文档的面板动作**，所以它要二次确认；恢复是往回加，不用确认。
     */
    function workflowBlock(view) {
      var main = view.state.main
      if (main === null || main === undefined) return null
      // 正在重新拉取、且手上还没有数据 → 先不渲染（避免闪一下「还没有工作流条目」）。
      if (main.loading === true && main.workflow === undefined) return null
      if (main.error !== undefined && main.workflow === undefined) {
        return h(
          'div',
          { className: 'dshpz-sect' },
          h('div', { className: 'dshpz-secttitle' }, '工作流'),
          h('div', { className: 'dshpz-err' }, String(main.error)),
        )
      }
      var list = Array.isArray(main.workflow) ? main.workflow : []
      var archive = Array.isArray(main.workflowArchive) ? main.workflowArchive : []
      var rows = list.map(function (text, index) {
        var no = index + 1
        return h(
          'div',
          { className: 'dshpz-wf', key: 'w' + no },
          h('span', { className: 'dshpz-entrynum' }, String(no)),
          h('span', { className: 'dshpz-wfbody' }, String(text)),
          h(
            'button',
            {
              className: 'dshpz-act',
              title: '删掉这一条工作流（会进归档，可恢复）',
              onClick: function () { removeWorkflow(view, no, text) },
            },
            '✕ 删除',
          ),
        )
      })
      var archRows = archive.map(function (text, index) {
        var no = index + 1
        return h(
          'div',
          { className: 'dshpz-wf', key: 'a' + no, 'data-arch': '1' },
          h('span', { className: 'dshpz-entrynum' }, String(no)),
          h('span', { className: 'dshpz-wfbody' }, String(text)),
          h(
            'button',
            {
              className: 'dshpz-act',
              title: '把这一条恢复回工作流（工作流满 5 条时会挤掉最旧的一条，那条会进归档）',
              onClick: function () { restoreWorkflow(view, no, text) },
            },
            '恢复',
          ),
        )
      })
      return h(
        'div',
        { className: 'dshpz-sect' },
        h('div', { className: 'dshpz-secttitle' }, '工作流（' + list.length + '/5 · 超了删最旧）'),
        list.length === 0
          ? h('div', { className: 'dshpz-muted' }, '还没有工作流条目。点「工作流模板」让 AI 先问目标，再写进主文档。')
          : h('div', { className: 'dshpz-entries' }, rows),
        h('div', { className: 'dshpz-secttitle', style: { marginTop: '8px' } }, '归档（' + archive.length + ' · 可恢复）'),
        archive.length === 0
          ? h('div', { className: 'dshpz-muted' }, '暂无删除记录')
          : h('div', { className: 'dshpz-entries' }, archRows),
      )
    }

    /* --------------------------- 主文档（只读） --------------------------- */

    /**
     * 主文档只读视图。
     *
     * 为什么是只读：拼图文档只能由 AI 通过 `puzzle_mode` 改（write / edit 会被文档锁拒绝），
     * 面板上开一个可编辑框等于绕过规格。这里只把 `result.text` 原样摆出来给人看。
     * 用 `<pre>` 而不是 `<textarea>`：保留换行、可滚动，且天然不可编辑。
     */
    function mainBlock(view) {
      if (view.state.showMain !== true) return null
      var main = view.state.main
      if (main === null || main === undefined) {
        return h(
          'div',
          { className: 'dshpz-sect' },
          h('div', { className: 'dshpz-secttitle' }, '主文档'),
          h('div', { className: 'dshpz-muted' }, '读取中…'),
        )
      }
      // 重新拉取时留着上一次的原文（`text` 已有就不闪空白）；首次拉取才是「读取中…」。
      if (main.loading === true && main.text === undefined) {
        return h(
          'div',
          { className: 'dshpz-sect' },
          h('div', { className: 'dshpz-secttitle' }, '主文档'),
          h('div', { className: 'dshpz-muted' }, '读取中…'),
        )
      }
      if (main.error !== undefined && main.text === undefined) {
        return h(
          'div',
          { className: 'dshpz-sect' },
          h('div', { className: 'dshpz-secttitle' }, '主文档'),
          h('div', { className: 'dshpz-err' }, String(main.error)),
        )
      }
      return h(
        'div',
        { className: 'dshpz-sect' },
        h(
          'div',
          { className: 'dshpz-secttitle' },
          // `version` 与页头一样给兜底：当前 RPC 契约下它恒有值（不可达），
          // 但裸拼会在契约变化时渲染出「格式 vundefined」——与页头的 `|| '?'` 对齐。
          '主文档（只读 · 格式 v' + (main.version || '?') + (main.outdated === true ? ' · 旧格式' : '') + (main.loading === true ? ' · 读取中…' : '') + '）',
        ),
        main.error !== undefined ? h('div', { className: 'dshpz-err' }, String(main.error)) : null,
        h('div', { className: 'dshpz-docpath' }, String(main.mainDoc || '')),
        String(main.text || '') === ''
          ? h('div', { className: 'dshpz-muted' }, '主文档是空的。')
          : h('pre', { className: 'dshpz-doc' }, String(main.text)),
        h('div', { className: 'dshpz-muted' }, '只读：拼图文档只能由 AI 通过 puzzle_mode 改，面板不提供编辑。'),
      )
    }

    /* -------------------------------- 面板 -------------------------------- */

    /**
     * 开关那一行：**关掉本会话**的拼图模式。
     *
     * 放在面板顶部、**两个分支都渲染**（有项目 / 空态）：它只认会话 ID，与项目无关，
     * 而空态（还没绑项目）恰恰是最想关掉它的场景。
     *
     * 文案必须写明「只影响本会话」——早先那版写的是「只对新会话生效」，
     * 用户按下去发现当前会话毫无变化，直接反馈「怎么禁用没有效果」。
     */
    function settingsRow(view) {
      var settings = view.state.settings
      if (settings === null || settings === undefined) return null
      if (settings.error !== undefined) {
        return h('div', { className: 'dshpz-muted' }, '开关读取失败：' + String(settings.error))
      }
      var off = settings.disabled === true
      var sessionId = view.state.sessionId
      return h(
        'div',
        { className: 'dshpz-row', style: { marginTop: '6px' } },
        h(
          'button',
          {
            className: 'dshpz-act',
            'data-on': off ? '1' : '0',
            title: off
              ? '恢复**本会话**的拼图模式（其他会话的禁用状态不受影响）'
              : '关掉**本会话**的拼图模式：下一轮起不再注入拼图规则、也不再拦工具；其他会话不受影响',
            onClick: function () { writeSettings(sessionId, !off) },
          },
          off ? '本会话：已关拼图 · 点此恢复' : '关掉本会话的拼图模式',
        ),
        off
          ? h(
            'span',
            { className: 'dshpz-muted' },
            '只影响**本会话**，其他会话照旧；点一下即可恢复。',
          )
          : null,
      )
    }

    function panelBody(view) {
      var data = view.state.data
      var inited = data !== null && data !== undefined && data.initialized === true
      var header = h(
        'div',
        { className: 'dshpz-head' },
        h('span', { className: 'dshpz-logo' }, icon('puzzle', 18)),
        h(
          'div',
          { className: 'dshpz-headtext' },
          h('h3', { className: 'dshpz-title' }, '拼图' + (inited ? ' · ' + (data.project || '未命名') : '')),
          h(
            'div',
            { className: 'dshpz-sub' },
            inited
              ? (data.mode || '') + ' · 格式 v' + (data.version || '?') + (data.outdated === true ? '（旧格式，建议迁移）' : '') + ' · ' + (data.projectDir || '')
              : '本会话未绑定项目',
          ),
        ),
        inited ? h('span', { className: 'dshpz-heroval dshpz-mono' }, '健康性 ' + data.health + '%') : null,
        h(
          'button',
          {
            className: 'dshpz-close',
            title: '刷新',
            onClick: function () {
              // 同样不带显式 project：刷新要看到**当前真实归属**（宿主按绑定解析），
              // 带上面板此刻显示的项目名等于把旧状态钉死，解绑后刷新也会「复活」。
              load(view.state.sessionId)
              loadProjects(view.state.sessionId)
              // 主文档/工作流也一起刷新：它们不在 `state` 摘要里，只刷 state 会让这一块停在旧原文。
              loadMain(view.state.sessionId)
            },
          },
          icon('refresh', 15),
        ),
        h(
          'button',
          {
            className: 'dshpz-close',
            title: '关闭（Esc）',
            onClick: function () { setState({ open: false, detail: null, detailName: null }) },
          },
          icon('close', 15, { weight: 'bold' }),
        ),
      )

      // 一次性说明（不是错误，所以不跟 error 抢同一行）：例如「项目已存在，没动绑定」。
      var notice = view.state.notice === null || view.state.notice === undefined
        ? null
        : h('div', { className: 'dshpz-notice' }, icon('alert', 14), h('span', null, String(view.state.notice)))

      /**
       * 样式没生效时**在面板里直说**，并给出可复制的一行环境指纹。
       *
       * 只在真的失败时渲染（`applied === false`）：样式正常时用户不该看到任何技术噪音。
       * 这一块是给「远程排障」用的——用户把这一行截图/复制出来，就知道是
       * `inset` 不支持、还是 `color-mix` 不支持、还是 UA 太老，不必再猜。
       */
      var diag = view.state.styleDiag
      var styleWarning = diag !== null && diag !== undefined && diag.applied === false
        ? h(
          'div',
          { className: 'dshpz-err', style: { display: 'block' } },
          h('span', null, '⚠ 面板样式没有生效（当前是「无样式」兜底显示，功能仍可用）。请把下面这行发给插件作者：'),
          h('div', { className: 'dshpz-mono', style: { marginTop: '6px', wordBreak: 'break-all' } },
            'puzzle-style-diag applied=false inset=' + String(diag.inset)
            + ' color-mix=' + String(diag.colorMix)
            + ' backdrop=' + String(diag.backdrop)
            + ' min()=' + String(diag.minFn)
            + ' ua=' + String(diag.ua)),
        )
        : null

      if (view.state.error !== null) {
        // 错误态也保持三栏骨架：只弹一个居中红条会让面板「看起来坏了」，
        // 而保留布局能让人一眼确认「面板还在，只是这次读取失败」。
        return h(
          'div',
          { className: 'dshpz-panel' },
          header,
          h(
            'div',
            { className: 'dshpz-body' },
            h('div', { className: 'dshpz-col' }, h('div', { className: 'dshpz-err' }, icon('alert', 14), h('span', null, String(view.state.error)))),
            h('div', { className: 'dshpz-col' }, h('div', { className: 'dshpz-muted' }, '中栏数据未取到。点右上角 ⟳ 重试。')),
            h('div', { className: 'dshpz-col' }, h('div', { className: 'dshpz-muted' }, '右栏内容未取到。')),
          ),
        )
      }
      if (data === null || data === undefined) {
        // 首屏加载：给骨架屏而不是干巴巴的「读取中…」——三栏布局下空白会让面板看起来是坏的。
        return h(
          'div',
          { className: 'dshpz-panel' },
          header,
          h(
            'div',
            { className: 'dshpz-body' },
            h('div', { className: 'dshpz-col' }, h('div', { className: 'dshpz-skel', style: { width: '70%' } }), h('div', { className: 'dshpz-skel', style: { width: '45%' } })),
            h('div', { className: 'dshpz-col' }, h('div', { className: 'dshpz-skel', style: { width: '55%' } }), h('div', { className: 'dshpz-skel', style: { width: '80%' } }), h('div', { className: 'dshpz-skel', style: { width: '65%' } })),
            h('div', { className: 'dshpz-col' }, h('div', { className: 'dshpz-skel', style: { width: '60%' } })),
          ),
        )
      }

      if (data.initialized !== true) {
        var existing = view.state.projects
        var existingList = existing !== null && existing !== undefined && Array.isArray(existing.projects) ? existing.projects : []
        return h(
          'div',
          { className: 'dshpz-panel' },
          header,
          h(
            'div',
            { className: 'dshpz-body' },
            // 空态也分三栏：左＝建项目，中＝说明与目录，右＝可绑定的已有项目。
            h(
              'div',
              { className: 'dshpz-col' },
              styleWarning,
              notice,
              settingsRow(view),
              h(
                'div',
                { className: 'dshpz-sect' },
                h('div', { className: 'dshpz-secttitle' }, '直接建（不经过 AI）'),
                h('input', {
                  className: 'dshpz-in',
                  placeholder: '项目名（= 工作区里的文件夹名）',
                  value: view.state.formProject || '',
                  onChange: function (event) { setState({ formProject: event.target.value }) },
                }),
                h('input', {
                  className: 'dshpz-in',
                  placeholder: '模块名，逗号分隔（可留空）',
                  value: view.state.formModules || '',
                  onChange: function (event) { setState({ formModules: event.target.value }) },
                }),
                h('input', {
                  className: 'dshpz-in',
                  placeholder: '一句话目标（可留空）',
                  value: view.state.formGoal || '',
                  onChange: function (event) { setState({ formGoal: event.target.value }) },
                }),
                h(
                  'button',
                  { className: 'dshpz-act', title: '立刻建出文件夹 + 主文档 + 每个模块一份文档，并绑定本会话', onClick: function () { createByForm(view) } },
                  '立刻建',
                ),
              ),
            ),
            h(
              'div',
              { className: 'dshpz-col' },
              h(
                'div',
                { className: 'dshpz-empty' },
                h('span', { className: 'dshpz-emptyicon' }, icon('inbox', 26)),
                h('div', { className: 'dshpz-emptytitle' }, '本会话还没绑定拼图项目'),
                h('div', { className: 'dshpz-muted' }, '新会话默认是空的，不会自动占用上一个会话的项目。'),
              ),
              h(
                'div',
                { className: 'dshpz-sect' },
                h('div', { className: 'dshpz-secttitle' }, '或交给 AI'),
                h(
                  'div',
                  { className: 'dshpz-acts-vert' },
                  h(
                    'button',
                    { className: 'dshpz-act', title: '不采访，让 AI 直接 op:init 建出文件夹与全部文档', onClick: function () { askAi(view, null, createTemplate) } },
                    '快速建空壳',
                  ),
                  h(
                    'button',
                    { className: 'dshpz-act', title: '先让 AI 问 ≤5 问，再 op:init', onClick: function () { askAi(view, null, interviewTemplate) } },
                    '采访后再建',
                  ),
                ),
              ),
              h('div', { className: 'dshpz-hint' }, '目录：' + (data.projectRoot || '?') + '/<项目名>/拼图/'),
            ),
            h(
              'div',
              { className: 'dshpz-col' },
              h(
                'div',
                { className: 'dshpz-sect' },
                h('div', { className: 'dshpz-secttitle' }, '绑定已有项目', h('span', { className: 'dshpz-count' }, String(existingList.length))),
                existingList.length === 0
                  ? h('div', { className: 'dshpz-muted' }, '工作区里还没有拼图项目。')
                  : h('div', { className: 'dshpz-findings' }, existingList.map(function (item) {
                    return h(
                      'div',
                      { className: 'dshpz-finding', key: item.name },
                      h('div', { className: 'dshpz-ffact' }, item.name + ' · 健康性 ' + item.health + '%'),
                      h(
                        'button',
                        { className: 'dshpz-act', onClick: function () { bindTo(view, item.name) } },
                        '绑定',
                      ),
                    )
                  })),
              ),
            ),
          ),
        )
      }

      var modes = ['只拼不写', '写后再拼', '边拼边写']
      var projects = view.state.projects
      var projectList = projects !== null && projects !== undefined && Array.isArray(projects.projects) ? projects.projects : []
      var dimensions = data.dimensions !== null && data.dimensions !== undefined ? data.dimensions : {}
      var moduleTiles = (Array.isArray(data.modules) ? data.modules : []).map(function (module) {
        return {
          id: 'module:' + module.name,
          kind: 'module',
          name: module.name,
          score: module.health,
          exists: module.exists,
          counts: module.counts,
        }
      })

      return h(
        'div',
        { className: 'dshpz-panel' },
        header,
        h(
          'div',
          { className: 'dshpz-body' },
          /* -------- 左栏：项目、模式、动作。这一栏是「我要做什么」 -------- */
          h(
            'div',
            { className: 'dshpz-col' },
            h(
              'div',
              { className: 'dshpz-sect' },
              h('div', { className: 'dshpz-secttitle' }, '项目'),
              projectList.length > 0
                ? h(
                  'select',
                  {
                    className: 'dshpz-sel',
                    style: { width: '100%' },
                    value: data.project,
                    onChange: function (event) {
                      // 一个会话只绑一个项目：这里切换就是**改绑**，不是临时看别的项目。
                      bindTo(view, event.target.value)
                    },
                  },
                  projectList.map(function (item) {
                    return h('option', { key: item.name, value: item.name }, item.name + ' · 健康性 ' + item.health + '%')
                  }),
                )
                : h('div', { className: 'dshpz-muted' }, data.project || '未命名'),
              h('div', { className: 'dshpz-docpath', style: { marginTop: '6px' } }, data.projectDir || ''),
            ),
            h(
              'div',
              { className: 'dshpz-sect' },
              h('div', { className: 'dshpz-secttitle' }, '执行模式'),
              h(
                'div',
                { className: 'dshpz-seg' },
                modes.map(function (mode) {
                  return h(
                    'button',
                    {
                      key: mode,
                      'data-on': data.mode === mode ? '1' : '0',
                      // 名字的含义换过（v5）：`边拼边写` 现在指「每个写动作前先问」，
                      // 旧的「一轮做完才问」叫 `写后再拼`。悬停/长按能看到差别，免得选错。
                      title: MODE_HINTS[mode] || '',
                      onClick: function () {
                        writeMode(view.state.sessionId, mode, data.project)
                      },
                    },
                    mode,
                  )
                }),
              ),
              h('div', { className: 'dshpz-muted', style: { marginTop: '7px', lineHeight: '1.55' } },
                MODE_HINTS[data.mode] || 'AI 可以动手；具体在什么时候问，见模式按钮的说明。'),
              // front-matter 里还写着旧名字时如实提示：它已被按旧含义（写后再拼）读，
              // 迁移一次才会把名字改过来。不说的话用户会以为「我明明选的是边拼边写」。
              data.modeRenamed === true
                ? h('div', { className: 'dshpz-muted', style: { marginTop: '6px', lineHeight: '1.55' } },
                  '⚠ 文档里写的还是旧名字「边拼边写」（当时表示一轮做完才问），已按「写后再拼」读取；跑一次「迁移/重构」会把名字改过来。')
                : null,
            ),
            // 动作按「干什么」分组：看项目 / 让 AI 动手 / 改文档。分组比一长排按钮好扫。
            h(
              'div',
              { className: 'dshpz-sect' },
              h('div', { className: 'dshpz-secttitle' }, '看项目'),
              h(
                'div',
                { className: 'dshpz-acts-vert' },
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    title: '取五维真实值（声明 vs 实测）+ 源码体检 + 可执行修复清单',
                    onClick: function () { loadAudit(view.state.sessionId, data.project) },
                  },
                  icon('scan', 13), h('span', null, '审查 / 真实值'),
                ),
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    'data-on': view.state.showMain === true ? '1' : '0',
                    title: '只读查看主文档原文（含 front-matter 与五节）；工作流条目与归档也在这一块',
                    onClick: function () {
                      var next = view.state.showMain !== true
                      setState({ showMain: next })
                      // 关掉再打开时**重新拉**：文档可能已被 AI 改过，缓存会给出过期原文。
                      if (next) loadMain(view.state.sessionId, data.project)
                    },
                  },
                  icon('doc', 13), h('span', null, '主文档' + (view.state.showMain === true ? ' · 收起' : '')),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dshpz-sect' },
              h('div', { className: 'dshpz-secttitle' }, '让 AI 动手'),
              h(
                'div',
                { className: 'dshpz-acts-vert' },
                // **新建文档**：在**当前项目**里加一份模块文档（走 op:module）。
                // 与空态的「建项目」区分：那条走 op:init 会新建一个项目；
                // 这条不新建项目，只往已绑定的项目里加文档。放在第一位，
                // 因为「接着加文档」是这个面板里最高频的下一步。
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    title: '把「新建文档」提示词填进输入框：在当前项目里加一份模块文档，并同步主文档的「模块索引」（不会新建项目）',
                    onClick: function () { askAi(view, null, newDocTemplate) },
                  },
                  icon('doc', 13), h('span', null, '新建文档'),
                ),
                // **接续会话**：新会话别通读全部文档。文档全量读一遍是几千字，
                // 而本轮真正用得到的通常只有一两个模块——主文档本来就是查找入口。
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    title: '把「接续会话」提示词填进输入框：新会话按需读（先 op:read → 只读主文档 → 只读相关那一个模块），不通读全部',
                    onClick: function () { askAi(view, null, resumeTemplate) },
                  },
                  h('span', null, '接续会话'),
                ),
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    title: '让 AI 按五维审查这个项目，并出可执行修复清单',
                    onClick: function () { askAi(view, null, auditTemplate) },
                  },
                  h('span', null, '审查（交给 AI）'),
                ),
                // **工作流模板**：工作流是「在某个操作下别做别的事」的约束，不是待办清单；
                // 所以模板要求模型先提问确认目标，再 op:main 落盘（与「建项目先采访」同一思路）。
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    title: '把「工作流」提示词填进输入框：先问清目标与边界，再用 op:main 把确定下来的条目写进主文档',
                    onClick: function () { askAi(view, null, workflowTemplate) },
                  },
                  icon('rules', 13), h('span', null, '工作流模板'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dshpz-sect' },
              h('div', { className: 'dshpz-secttitle' }, '改文档'),
              h(
                'div',
                { className: 'dshpz-acts-vert' },
                // **常驻**：迁移/重构不只在旧格式时需要——格式对得上但正文超长、没出处、
                // 条数超限时，同样要按规格重写。点它 = **把提示词填进输入框**，
                // 真正的动作由模型按提示词执行（先 op:rebuild 落盘，再逐节重写正文）。
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    'data-on': data.outdated === true ? '1' : '0',
                    title: '把「全量迁移/重构」提示词填进输入框：按最新规格清理全部文档，不留手'
                      + (data.outdated === true ? '（当前是旧格式 v' + data.version + '，建议先跑）' : ''),
                    onClick: function () { askAi(view, null, refactorTemplate) },
                  },
                  data.outdated === true ? icon('alert', 13) : null,
                  h('span', null, '迁移/重构' + (data.outdated === true ? ' ⚠' : '')),
                ),
                // 只改形状的机械动作不必经过模型：这里直接出预览（dry-run），确认后落盘。
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    title: '只迁移文档格式（不经过 AI）：收敛成五节、补小节、拆 悬而未决/已定，正文不动。先出预览',
                    onClick: function () { rebuildNow(view, false) },
                  },
                  h('span', null, '仅迁移格式'),
                ),
              ),
            ),
            styleWarning,
            notice,
            settingsRow(view),
            data.cwdSource !== undefined && data.cwdSource !== 'session'
              ? h('div', { className: 'dshpz-warn' }, icon('alert', 14), h('span', null, '拿不到会话工作目录，已退回 ' + data.projectRoot + '（文档可能写错地方）'))
              : null,
            h(
              'div',
              { className: 'dshpz-sect' },
              h(
                'div',
                { className: 'dshpz-acts' },
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    'data-tone': 'danger',
                    title: '解绑本会话（回到没绑定；文档与文件夹都留着，不会被删）',
                    onClick: function () { unbind(view) },
                  },
                  h('span', null, '解绑本会话'),
                ),
              ),
            ),
          ),

          /* -------- 中栏：读数。这一栏是「现在什么状态」 -------- */
          h(
            'div',
            { className: 'dshpz-col' },
            h(
              'div',
              { className: 'dshpz-hero' },
              heroRing(data.health),
              h(
                'div',
                { className: 'dshpz-herotext' },
                h('div', { className: 'dshpz-herolabel' }, '项目健康性'),
                h('div', { className: 'dshpz-heroval' }, healthVerdict(data.health)),
                h('div', { className: 'dshpz-muted', style: { marginTop: '3px' } },
                  '来自文档里写下的证据（要点 / 详细记录 / 悬而未决 / 已定 / 坑）——空文档就是 0，不是印象分。'),
              ),
            ),
            h(
              'div',
              { className: 'dshpz-sect' },
              h('div', { className: 'dshpz-secttitle' }, '五维', h('span', { className: 'dshpz-count' }, '跨模块均值 · 声明值')),
              h('div', { className: 'dshpz-dims' }, DIMENSION_KEYS.map(function (key) {
                return dimensionRow(key, dimensions[key] || 0)
              })),
            ),
            truthBlock(view),
            h(
              'div',
              { className: 'dshpz-sect' },
              h('div', { className: 'dshpz-secttitle' }, '模块', h('span', { className: 'dshpz-count' }, String(moduleTiles.length))),
              moduleTiles.length === 0
                ? h('div', { className: 'dshpz-empty' }, h('span', { className: 'dshpz-emptyicon' }, icon('grid', 24)), h('div', { className: 'dshpz-emptytitle' }, '还没有模块'), h('div', { className: 'dshpz-muted' }, '让 AI 用 op:init 带 modules 一起建。'))
                : h('div', { className: 'dshpz-grid' }, moduleTiles.map(function (piece) { return tile(piece, view) })),
            ),
            findingsBlock(view),
            h(
              'div',
              { className: 'dshpz-hint' },
              '拼图文档只能由 AI 通过 puzzle_mode 改；write / edit 会被文档锁拒绝（所有模式）。',
              h('br', null),
              '每次提问的最后都会问：' + PAUSE_QUESTION,
            ),
          ),

          /* -------- 右栏：文档与细节。这一栏是「具体内容是什么」 -------- */
          h(
            'div',
            { className: 'dshpz-col' },
            detailBlock(view),
            workflowBlock(view),
            mainBlock(view),
            rebuildBlock(view),
          ),
        ),
      )
    }

    function Panel(props) {
      // 面板从共享 store 读 inputActions（shell.overlay 的 props 里没有它）。
      var view = useStore()

      React.useEffect(
        function () {
          if (view.state.open !== true) return undefined
          var sessionId = props.sessionId === undefined ? view.state.sessionId : props.sessionId
          // 开关按**会话**判定，必须拿真实的 sessionId（早先传占位串 'panel' 是全局语义的遗留）。
          loadSettings(sessionId)
          if (sessionId === undefined || sessionId === null) return undefined
          load(sessionId)
          loadProjects(sessionId)
          // 主文档与工作流共用一次取数：**每次打开都重拉**（文档可能刚被 AI 改过），
          // 否则展开「主文档」看到的会是上一次打开时的旧原文。
          loadMain(sessionId)
          // 轮询**不能带显式 project**：这个闭包是在 effect 首次运行时捕获的，
          // 解绑不会让 effect 重跑，所以它会一直握着「解绑前那个项目名」。
          // 而显式 project 在宿主侧的优先级高于绑定 —— 于是解绑 8 秒后面板又显示成已绑定，
          // 看起来就是「解绑了过一会又自动绑定」。只给 sessionId，让宿主按绑定解析。
          var timer = window.setInterval(function () {
            load(sessionId)
          }, POLL_MS)
          return function () {
            window.clearInterval(timer)
          }
        },
        [view.state.open, view.state.sessionId, props.sessionId],
      )

      React.useEffect(function () {
        var onKey = function (event) {
          if (event.key === 'Escape') setState({ open: false, detail: null, detailName: null })
        }
        window.addEventListener('keydown', onKey)
        return function () {
          window.removeEventListener('keydown', onKey)
        }
      }, [])

      if (view.state.open !== true) return null
      return h(
        'div',
        {
          className: 'dshpz-backdrop',
          // **内联兜底**（v0.16.2 加的）：万一整张样式表都没生效（老 WebView 丢弃
          // `inset` 简写、CSP 拦掉 <style>、或别的插件把样式清了），
          // 面板至少还是「全屏遮罩 + 居中」的可用状态，
          // 而不是缩在左上角、文字互相压着。
          //
          // 只内联**没有被 @media 覆盖过**的属性：`padding` 故意不内联，
          // 因为窄屏那条 `@media (max-width:900px)` 会把它改成 10px，
          // 内联会盖掉媒体查询，等于把手机端的边距改坏。
          // 写的值与 `.dshpz-backdrop` 一致，所以样式正常时看不出差别。
          style: {
            position: 'fixed', top: 0, right: 0, bottom: 0, left: 0,
            background: 'rgba(0,0,0,.45)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 40,
          },
          onClick: function (event) {
            if (event.target === event.currentTarget) setState({ open: false, detail: null, detailName: null })
          },
        },
        // `panelBody` 自己返回 `.dshpz-panel`（主题令牌挂在那上面），所以这里**不再包一层**：
        // 多包一层会得到「面板套面板」，玻璃底与网格纹理会叠两次。
        panelBody(view),
      )
    }

    /* -------------------------------- 按钮 -------------------------------- */

    function Button(props) {
      var view = useStore()
      var data = view.state.data
      var label = data !== null && data !== undefined && data.initialized === true ? data.health + '%' : ''

      // 把输入框动作交给面板：只有这个 Slot 拿得到 inputActions。
      React.useEffect(
        function () {
          if (state.inputActions !== props.inputActions) setState({ inputActions: props.inputActions })
        },
        [props.inputActions],
      )

      return h(
        'button',
        {
          type: 'button',
          className: 'dshpz-btn',
          'data-on': view.state.open === true ? '1' : '0',
          title: '拼图模式：项目健康性、模块与工作流',
          onMouseDown: function (event) {
            event.preventDefault()
          },
          onClick: function () {
            var next = view.state.open !== true
            setState({ open: next, sessionId: props.sessionId, detail: null, detailName: null })
            if (next) {
              load(props.sessionId)
              loadProjects(props.sessionId)
            }
          },
        },
        icon('puzzle', 14),
        h('span', null, '拼图'),
        label === '' ? null : h('span', null, label),
      )
    }

    /* -------------------------------- 填模板 -------------------------------- */

    /**
     * 把模板写进输入框——**不自动发送**，由用户补完问题自己发。
     *
     * `inputActions.setDraft` 是 `conversation.input.left` 的标准 props 之一
     * （见 Client Slot catalog 的 InputActions 契约）。它可能不存在（例如没有
     * 当前会话时是 undefined），所以这里必须容错，不能让面板整个崩掉。
     *
     * `template` 现在**必给**：原先「不给就走提问模板」的兜底随「提问模板」按钮一起删了
     * （用户裁定：面板上不要那个按钮）。少了它就在这里说清楚，不要静默填一段空提示词。
     */
    function askAi(view, prefix, template) {
      var actions = view.state.inputActions
      if (actions === undefined || actions === null || typeof actions.setDraft !== 'function') {
        setState({ error: '当前输入框不可写入（没有会话或输入区未就绪）' })
        return
      }
      if (typeof template !== 'function') {
        setState({ error: '没有可用的提示词模板（面板按钮与模板的对应关系断了）' })
        return
      }
      var data = view.state.data
      var project = data && data.initialized === true ? data.project : ''
      var projectDir = data && data.initialized === true ? (data.projectDir || '') : ''
      var build = template
      // 模板收 (project, projectDir)：接续会话那条要把主文档路径写进提示词，
      // 免得模型自己去猜目录。其余模板只关心 project，多传一个参数无害。
      var text = prefix === null || prefix === undefined
        ? build(project, projectDir)
        : '【' + (project || '拼图') + ' · 提问】' + prefix + '\n\n' + PAUSE_QUESTION + '\n① ' + PAUSE_OPTIONS[0] + '\n② ' + PAUSE_OPTIONS[1]
      try {
        actions.setDraft(text)
        setState({ open: false, error: null })
      } catch (error) {
        setState({ error: '写入输入框失败：' + String(error && error.message ? error.message : error) })
      }
    }

    /* --------------------------------- 插件 --------------------------------- */

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return

      ctx.effect(function () {
        var style = document.createElement('style')
        style.setAttribute('data-dsh-puzzle-mode', '')
        style.textContent = CSS
        document.head.appendChild(style)
        // **样式自检**（v0.16.2 加的）：把「这张表到底有没有生效」变成可远程汇报的一行事实。
        // 为什么需要它：老 WebView / CSP / 别的插件清样式，症状都是「面板能开但没样式」，
        // 而拿到截图的人只能猜。这里在挂载后读一次真实计算值——读不到就说明没生效，
        // 顺手把环境指纹（UA / 三项特性支持）记下来，用户截一次图就够定位。
        // 读的是 `getComputedStyle`，即浏览器**实际采纳**的结果，不是我们写了什么。
        try {
          var probe = document.createElement('div')
          probe.className = 'dshpz-backdrop'
          probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:10px;height:10px'
          document.body.appendChild(probe)
          var computed = window.getComputedStyle(probe)
          var applied = computed.position === 'fixed'
          document.body.removeChild(probe)
          var supports = function (prop, value) {
            try { return window.CSS !== undefined && CSS.supports !== undefined && CSS.supports(prop, value) } catch (_e) { return null }
          }
          setState({
            styleDiag: {
              applied: applied,
              ua: String(navigator.userAgent || '').slice(0, 120),
              inset: supports('inset', '0'),
              colorMix: supports('color', 'color-mix(in srgb,red 50%,blue)'),
              backdrop: supports('backdrop-filter', 'blur(1px)') || supports('-webkit-backdrop-filter', 'blur(1px)'),
              minFn: supports('width', 'min(1px,2px)'),
            },
          })
        } catch (_error) {
          /* 自检本身失败不该影响插件：静默跳过，面板照常渲染 */
        }
        return function () {
          if (style.parentNode !== null) style.parentNode.removeChild(style)
        }
      }, 'dsh-puzzle-mode: styles')

      slots.inject('conversation.input.left', function () {
        return slots.register(
          { name: 'conversation.input.left', id: 'puzzle-mode-button', order: 100 },
          Button,
        )
      })

      slots.inject('shell.overlay', function () {
        return slots.register({ name: 'shell.overlay', id: 'puzzle-mode-panel', order: 50 }, Panel)
      })
    }

    module.exports = {
      name: 'dsh-puzzle-mode',
      apply: apply,
      resumeTemplate: resumeTemplate,
      auditTemplate: auditTemplate,
      refactorTemplate: refactorTemplate,
      createTemplate: createTemplate,
      interviewTemplate: interviewTemplate,
      newDocTemplate: newDocTemplate,
      bindTemplate: bindTemplate,
      workflowTemplate: workflowTemplate,
      createByForm: createByForm,
      loadAudit: loadAudit,
      loadMain: loadMain,
      removeWorkflow: removeWorkflow,
      restoreWorkflow: restoreWorkflow,
      workflowAction: workflowAction,
      workflowBlock: workflowBlock,
      mainBlock: mainBlock,
      truthBlock: truthBlock,
      // 导出面板主体与主题，便于在真机之外做一次「元素树 + 令牌」冒烟：
      // 三栏结构、类名、CSS 变量都在这里能看到，不必等页面刷新。
      panelBody: panelBody,
      themeVars: themeVars,
      THEME: THEME,
      CSS: CSS,
      unbind: unbind,
      rebuildNow: rebuildNow,
      entryCards: entryCards,
    }
    return module.exports
  },
})

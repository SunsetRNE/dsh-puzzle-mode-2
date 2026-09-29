## 把 2517 行拆成 12 个文件

v0.10.0 加的源码体检，**第一个抓到的就是我自己**：`lib/puzzle.js` 2517 行，超 2000 行硬限。
这个版本把债还了——不是把阈值调高，是按职责真拆。

`lib/puzzle.js` 退化成 **barrel**（24 行，只 re-export），
所以 `import ... from './puzzle.js'` 这个入口没变，`lib/index.js` 与四组测试**一行都不用改**。

```
constants ─→ util ─→ docfs ─→ frontmatter ─→ entries ─→ health
                                                          ↓
                                          audit ─→ source ─→ migrate
                                                          ↓
                                    templates ─→ project ─→ summary
```

依赖**严格单向**（只允许向右引用）。拆分脚本遇到反向引用会**直接报错退出**——
也就是说「顺手加一个反向依赖」这件事在结构上做不到，除非先想清楚层次。

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `constants.js` | 249 | 对外契约：目录布局、小节标题、条目限长、五维定义 |
| `util.js` | 102 | 无依赖小工具：文件枚举、百分比夹取、均值、slug、时间戳 |
| `docfs.js` | 120 | 拼图目录的**路径守卫**与原子写（任何写盘都得过这里） |
| `frontmatter.js` | 276 | front-matter 解析/生成、小节读写、格式版本 |
| `entries.js` | 243 | 条目规格：限长、必须带出处、超条数删最旧 |
| `health.js` | 297 | 五维健康性：显式声明优先，否则按证据推导 |
| `audit.js` | 210 | 审查：规则化事实 + 写提示词（**只给事实**） |
| `source.js` | 414 | 源码工程化体检 + 五维真实值合成 |
| `migrate.js` | 462 | 文档格式迁移与重建（只改形状） |
| `templates.js` | 77 | 新建项目时的文档模板 |
| `project.js` | 691 | 项目级读写：建/绑/解绑、写小节、汇总状态 |
| `summary.js` | 141 | 给工具面与 UI 面的精简摘要 |

### 怎么保证「只搬运，未改逻辑」

拆完不能只靠「看起来对」。用**旧文件 vs 新 barrel 在同一份真实项目数据上逐项对比**：

```
✓ readState 全量      ✓ auditOf           ✓ summarize(brief)
✓ inspectSource       ✓ planRebuild       ✓ dimensionMeta
✓ summarizeList       ✓ HEALTH_DIMENSIONS ✓ AUDIT_PROMPT
✓ 迁移后主文档/模块文档（v1 → v3 全流程逐字节一致）
✓ 写路径后主文档/模块文档（建项目/写坑/写要点/写健康性/setMode）
✓ 91 个导出名与导出值
```

**全部逐字节一致**才算过。

### 拆分时踩到的两个坑（都是「机械搬运」的假象）

机械搬运听起来很安全，实际有两个地方会**静默出错**：

1. **模板串被当成注释清掉**。扫描引用的脚本把 `` `...${X}...` `` 整体抹掉，
   于是 `formatFrontMatter` 里的 `PUZZLE_VERSION` 默认值没被识别，
   **5 个文件的 import 缺失**，`createProject` 直接报 `PUZZLE_VERSION is not defined`。
   修法：模板串保留内容，并**额外加一道「用了但没 import」的独立体检**兜底。

2. **只导出「原本导出的」名字不够**。跨文件还要用内部 helper（如 `HEADING_BY_KEY`），
   barrel 报 `does not provide an export named ...`。
   修法：凡被别的文件引用的名字，在原文件补 `export`，但**不进 barrel**——
   对外导出集合仍是原来那 91 个，**一个不多一个不少**。

这两条都写进了 README 的「源码怎么分层」，因为下一次拆代码还会遇到。

### 还没拆的，如实记着

拆完 `puzzle.js` 后体检器指向剩下两个：

- `lib/client.js` 1302 行，其中 `factory` **一个箭头函数就 1282 行**；
- `lib/index.js` 904 行（工具面 + RPC + 拦截都在一个 `apply` 里）。

**它说得对**，这两个是真欠债。但浏览器半是手写的 module-loader 包（无打包器、无 JSX），
拆它要动 1282 行的闭包作用域，风险与收益要单独评估——留到下一轮，不在这版混着做。

## 安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.11.0
```

或导入 Release 附件 `dsh-puzzle-mode-0.11.0.tgz`。装完**重启 profile**，再刷新页面。

## 验收判据

- `node --check lib/*.js` 全部无输出；
- `import('dsh-puzzle-mode')` 成功，`name` / `inject` / `apply` 与 v0.10.0 一致；
- `puzzle_mode{op:'read'}` 与 v0.10.0 **返回完全相同**（拆分不改行为）；
- `puzzle_mode{op:'audit'}` 的 `trueDimensions` / `inflation` 与 v0.10.0 一致；
- 面板「迁移/重构」「真实值」「接续会话」照旧可用（UI 未动）。

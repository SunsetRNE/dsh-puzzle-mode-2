## 下载安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.11.0
```

或直接下载附件：[dsh-puzzle-mode-0.11.0.tgz](https://github.com/liancha22/dsh-puzzle-mode/releases/download/v0.11.0/dsh-puzzle-mode-0.11.0.tgz)

装完**重启 profile**，再刷新页面。

---

## 本次改动

v0.10.0 加的源码体检，**第一个抓到的就是我自己**：`lib/puzzle.js` 2517 行，
超 2000 行硬限。这版把债还了——不是把阈值调高，是按职责真拆。

### 拆成 12 个文件，入口不变

`lib/puzzle.js` 退化成**入口文件**（24 行，只做转出），
所以 `import ... from './puzzle.js'` 这个用法没变，外部与测试**一行都不用改**。

```
constants ─→ util ─→ docfs ─→ frontmatter ─→ entries ─→ health
                                                          ↓
                                          audit ─→ source ─→ migrate
                                                          ↓
                                    templates ─→ project ─→ summary
```

| 文件 | 职责 |
| --- | --- |
| `constants.js` | 对外契约：目录布局、小节标题、条目限长、五维定义 |
| `util.js` | 无依赖小工具：文件枚举、百分比夹取、均值、slug、时间戳 |
| `docfs.js` | 拼图目录的**路径守卫**与原子写（任何写盘都得过这里） |
| `frontmatter.js` | front-matter 解析/生成、小节读写、格式版本 |
| `entries.js` | 条目规格：限长、必须带出处、超条数删最旧 |
| `health.js` | 五维健康性：显式声明优先，否则按证据推导 |
| `audit.js` | 审查：规则化事实 + 写提示词（**只给事实**） |
| `source.js` | 源码工程化体检 + 五维真实值合成 |
| `migrate.js` | 文档格式迁移与重建（只改形状） |
| `templates.js` | 新建项目时的文档模板 |
| `project.js` | 项目级读写：建/绑/解绑、写小节、汇总状态 |
| `summary.js` | 给工具面与 UI 面的精简摘要 |

依赖**严格单向**（只允许向右引用）——拆分脚本遇到反向引用会**直接报错退出**，
所以「顺手加一个反向依赖」在结构上做不到，除非先想清楚层次。

### 保证「只搬运，未改逻辑」

拆完不能只靠「看起来对」。用**旧文件 vs 新入口在同一份真实项目数据上逐项对比**：

```
✓ readState      ✓ auditOf        ✓ inspectSource   ✓ planRebuild
✓ 迁移产物（v1 → v3 全流程逐字节一致）
✓ 写路径产物（建项目/写坑/写要点/写健康性/切模式）
✓ 91 个导出名与导出值
```

**全部逐字节一致**才算过。

### 顺带记下两个坑

机械搬运听起来安全，实际有两个地方会**静默出错**：

1. **模板串被当成注释清掉**：扫描脚本把 `` `...${X}...` `` 整体抹掉，
   于是某个默认值没被识别，**5 个文件的 import 缺失**，建项目直接报错。
   修法：模板串保留内容，并额外加一道「用了但没 import」的独立体检。
2. **只导出「原本导出的」名字不够**：跨文件还要用内部 helper。
   修法：凡被引用的名字补上导出，但**不进入口文件**——
   对外导出集合仍是原来那 91 个，一个不多一个不少。

### 还没拆的，如实记着

拆完体检器指向剩下两个：`client.js` 1302 行（其中浏览器半的工厂函数一个就 1282 行）
与 `index.js` 904 行。**它说得对**，这两个是真欠债，留到下一轮单独评估。

---

## 验收判据

- `import('dsh-puzzle-mode')` 成功，`name` / `inject` / `apply` 与 v0.10.0 一致；
- `puzzle_mode{op:'read'}` 与 v0.10.0 **返回完全相同**；
- `op:audit` 的 `trueDimensions` / `inflation` 与 v0.10.0 一致；
- 面板照旧可用（UI 未动）。

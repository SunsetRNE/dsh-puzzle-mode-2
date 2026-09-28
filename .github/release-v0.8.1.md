## 修掉「解绑了过一会又自动绑定」

这个 bug 有**两个独立成因**，只修一个症状会变形——两个都修了。

### 成因一 · 面板轮询握着「解绑前」的项目名

面板每 8 秒轮询一次状态，但 `useEffect` 的依赖是 `[open, sessionId, props.sessionId]`——解绑不会让它重跑，于是定时器永远带着「解绑前那个项目名」当**显式** `project`。而显式 project 在宿主侧的优先级高于绑定：

```
locate() 顺序：显式 project > 绑定 > 空
```

所以解绑 8 秒后，面板又显示成已绑定。

**修**：轮询与刷新只发 `sessionId`，让宿主按绑定解析。归属只能有一个真源，面板不该替宿主记着。

### 成因二 · `createProject` 无条件重绑

```js
const bound = bindTo.length > 0 ? bindSession(...) : null   // 项目已存在也照绑
```

模型常把「建项目」当成幂等的「确保存在」，所以解绑后再走一次 `op:init`，会把刚解绑的会话**重新写回 `会话:` 行**——绑定是真的回来了，不只是显示问题。

**修**：只在主文档**是这次新建**时才绑，并返回 `rebound` 让调用方如实回报。

## 顺带修掉两处「假话」

- `op:init` / RPC `create` 原来一律回 `projectSource: 'explicit'`，掩盖真实绑定状态 → 改为按实际回 `bound` / `none`，并明确给出 `rebound: false` 与「项目已存在：本次没有改动绑定」。
- 面板表单直建填了**已存在**的项目名时原来静默什么都不做 → 现在蓝字提示「项目已存在，**没有改动绑定**（要改绑请用项目下拉）」。另开 `notice` 通道，不与 `error` 抢同一行（红字会让人以为出错了）。

## 安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.8.1
```

或：

```bash
dsh plugin --profile web add github:liancha22/dsh-puzzle-mode#v0.8.1
```

装完**重启 profile**（宿主半是 `patchReload: startup`），再刷新浏览器页面。

## 验收判据

- 面板点「解绑」→ **等 30 秒以上**（轮询 8 秒一次）→ 面板应一直是空态，不会自己变回已绑定；
- 解绑后点「⟳ 刷新」→ 仍是空态；
- `op:read` 返回 `projectSource: 'none'`、`initialized: false`；主文档里 `会话:` 那一行**不存在**；
- 对**已存在**的项目再调一次 `op:init` → 返回 `rebound: false`，解绑状态**保持不变**；
- 面板空态填一个**已存在**的项目名点「立刻建」→ 蓝字提示「项目已存在，**没有改动绑定**」。

## 本版改动

| 文件 | 改动 |
| --- | --- |
| `lib/client.js` | 轮询与刷新不再带显式 project；新增 `notice` 通道与样式 |
| `lib/puzzle.js` | `createProject` 只在新建时绑，返回 `rebound` |
| `lib/index.js` | `op:init` / RPC `create` 的 `projectSource` 与 `hint` 改为诚实口径 |
| `README.md` | 补 v0.8.1 验收判据 + 「闭包会记住你解绑之前的项目」教训 |

**注意**：宿主半改动**必须重启 DSH 才生效**。不重启的话看到的仍是旧行为。

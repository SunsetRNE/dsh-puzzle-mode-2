## 下载安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.16.1
```

或直接下载附件：[dsh-puzzle-mode-0.16.1.tgz](https://github.com/liancha22/dsh-puzzle-mode/releases/download/v0.16.1/dsh-puzzle-mode-0.16.1.tgz)

装完**重启 profile**，再刷新页面。

---

## 一、修掉一个「声明了但等于没声明」的 peer 范围

`peerDependencies` 里写着：

```
^0.1.5-rc.2 || ^0.1.6-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.2
```

**`0.1.6-rc.1` 这个版本从来没有发布过。** `@deepseek-ai/dsh-tools` 的 30 个已发布版本里，
0.1.6 系列**只有 `alpha.1` 和 `alpha.2`**。

而 semver 对预发布版的比较是按标识符元组来的，`rc > alpha`，于是
`0.1.6-alpha.2 < 0.1.6-rc.1` —— **整个 0.1.6-alpha 系列被这个范围排除在外**。
同一类错误还顺带排除了 `0.1.7-alpha.*`、`0.1.7-rc.1` 和 `0.2.0-rc.1`。

按原范围实测 13 个已发布版本，**有 9 个不满足**：

| 版本 | 原范围 | 新范围 |
| --- | --- | --- |
| 0.1.5-alpha.1 / alpha.2 / rc.1 | ❌ | ✅ |
| 0.1.5-rc.2 / rc.3 | ✅ | ✅ |
| **0.1.6-alpha.1 / alpha.2** | ❌ | ✅ |
| **0.1.7-alpha.1 / alpha.2** | ❌ | ✅ |
| 0.1.7-rc.1 | ❌ | ✅ |
| 0.1.7-rc.2 | ✅ | ✅ |
| 0.2.0-rc.1 | ❌ | ✅ |
| 0.2.0-rc.2 | ✅ | ✅ |

修法：**按每个 minor 锚到它最早存在的那个预发布版**，而不是锚一个想当然的 rc：

```
^0.1.5-alpha.1 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1 || ^0.2.0-rc.1
```

这里有个容易踩的细节：`^0.1.5-alpha.1` 展开是 `>=0.1.5-alpha.1 <0.2.0-0`，
看起来像能覆盖到 0.1.6/0.1.7，但 semver 规定**带预发布标识的版本只被同样带预发布标识、
且同一 `[major,minor,patch]` 元组的范围匹配** —— 所以 0.1.6 与 0.1.7 必须各自单列，
少一段就漏一整个 minor。新范围对 13 个已发布版本**全部覆盖**。

## 二、0.1.6-alpha.2 的宿主契约核对（重点：UI 面）

把 `0.1.6-alpha.2` 与 `0.1.7-rc.2` 的宿主包都拉下来逐面比对，**UI 相关的契约全部一致**：

| 面 | 结论 |
| --- | --- |
| `shell.overlay` slot（面板挂载点） | 两版都是 `kind: "list"`, `scope: "root"`；`renderSlot` 传 `{}` |
| `conversation.input.left` slot（小按钮挂载点） | 两版声明逐字相同；`inputActions` 注入方式相同 |
| `overlayLayer` CSS | 两版**逐字相同**：`z-index:20;pointer-events:none;position:absolute;inset:0` |
| 主题令牌 | 面板用到的 **13 个 `--dsw-alias-*` 令牌两版均已定义**，取值链闭合（`--dsw-static-*` 也都在） |
| `ctx.get('slots')` / `slots.inject` / `slots.register` | 两版一致 |
| `__ModuleLoader__.load({id, factory})` | 两版一致；`dsh.client` 的 `platform`/`inject` 校验逻辑无差异 |
| React | 两版都要求 `^18.2.0`；本插件只用 `createElement` / `useState` / `useEffect`，无 18-only API |

**唯一差异**（不影响本插件）：v0.1.7 给 `frame` 加了
`transition: grid-template-columns`，并新增了 `shell.leading` slot；
v0.1.6 没有这两项。本插件不读宿主 DOM、不用 `shell.leading`，所以无感。

> 说明：以上是**静态契约比对**（把包解开逐字对比），不是在该版本上跑起来的真机验证。
> 本机装的是 0.1.7-rc.2，无法同时挂载 0.1.6-alpha.2 的运行时。

---

## 验收判据

- `npm view @deepseek-ai/dsh-tools versions` 里能查到 `0.1.6-alpha.2`，
  且它落在新 peer 范围内（可用 `node -e` 调 semver 复核）；
- 在 **0.1.6-alpha.2** 上安装本插件：**不再报 peer 冲突**；
- 装完重启 profile，刷新页面：面板能打开、有玻璃底与网格纹理（不是透明无样式）、
  三枚模式按钮在、手机端内容区能滑到底；
- 面板背景/文字/边框颜色正常 —— 若出现「面板透明、文字与宿主 UI 重叠」，
  那是 CSS 没注入或 `position:fixed` 被带 `transform` 的祖先劫持，
  与本次 peer 修复无关，请带截图反馈。

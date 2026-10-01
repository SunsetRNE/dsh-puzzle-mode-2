## 下载安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.16.5
```

或直接下载附件：[dsh-puzzle-mode-0.16.5.tgz](https://github.com/liancha22/dsh-puzzle-mode/releases/download/v0.16.5/dsh-puzzle-mode-0.16.5.tgz)

装完**重启 profile**，再刷新页面。

---

## 修「样式自检」自己报假警

**症状**：面板**看起来完全正常**（居中、有遮罩、三栏并排），顶部却显示

> ⚠ 面板样式没有生效（当前是「无样式」兜底显示，功能仍可用）。请把下面这行发给插件作者：
> `puzzle-style-diag applied=false inset=false color-mix=false backdrop=false min()=false ua=…Chrome/152…`

**Chrome 152 不可能同时不支持 `inset`、`color-mix`、`backdrop-filter`、`min()`** ——
四项全 `false` 这个组合本身就不成立。所以问题不在样式，**在这段自检代码自己**。

查下来是两个独立的 bug，都在 v0.16.2 新加的自检里：

### bug ① · 探针自己写了 `position:absolute`，把要检测的东西盖掉了

自检的判定逻辑是：挂一个 `.dshpz-backdrop` 的探针 div，读
`getComputedStyle(probe).position === 'fixed'` —— 样式表里 `.dshpz-backdrop` 正是 `fixed`。

但探针同时设了行内样式：

```js
probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:10px;height:10px'
```

**行内样式的优先级高于样式表**，于是 `position` 恒为 `absolute` ——
`applied` 在**任何**浏览器上都是 `false`。样式好端端的，自检天天喊狼来了。

**修法**：探针只负责挪出视口（`left:-9999px;top:0;width:10px;height:10px`），
`position` 交给样式表判定。

### bug ② · `CSS.supports` 里的 `CSS` 被本文件的样式表字符串遮蔽了

同一文件里有：

```js
var CSS = [ /* … 122 条规则 … */ ].join('\n')
```

这是**本插件的样式表**，但它遮蔽了全局的 `window.CSS`。而自检写的是：

```js
return window.CSS !== undefined && CSS.supports !== undefined && CSS.supports(prop, value)
```

`CSS` 取到的是**字符串**，`CSS.supports` 是 `undefined` →
`CSS.supports !== undefined` 为假 → `&&` **短路** → 函数返回 `false`。
于是 `inset` / `color-mix` / `backdrop` / `min()` **四项一律 `false`**，
报告里那个「四项全 false」就是这么来的。

**修法**：改走 `window.CSS.supports(…)`，不再引用裸 `CSS`。

> 这两个 bug 单独看都不致命，叠在一起的效果是：**自检 100% 误报**，
> 而且误报得「很像真的」（四项全 false 看起来像极老的 WebView）。
> 真正需要它的时候（样式真的没生效）它反而给不出有效信息。

### 顺带：诊断行本身也改成可信的

原先这行把 `applied=false` **写死在字符串字面量里**：

```js
'puzzle-style-diag applied=false inset=' + String(diag.inset) + …
```

也就是说，无论自检算出什么，这行永远印 `applied=false` ——
「误报」和「真没生效」在报告里长得一模一样，这正是排查一开始被带偏的原因。

现在 `applied` 取**真实值**，并新增一项 `rules=`：

```
puzzle-style-diag applied=<真值> rules=<条数|null> inset=… color-mix=… backdrop=… min()=… ua=…
```

- `rules` = `<style>` 元素的 `sheet.cssRules.length`；
- `applied=false` **且** `rules=null` → 样式表**压根没进文档**（CSP 拦掉 `<style>`、
  或别的插件把它删了）—— 这是真正需要上报的那一类；
- `applied=false` 但 `rules>0` → 表进了文档、只是没盖住探针，属于自检自身的问题。

---

## 验收判据

装完重启 profile、刷新页面后：

- **面板样式正常时，顶部不该有任何 `puzzle-style-diag` 字样**（这条是本次修复的核心）；
- 打开面板：居中、有全屏暗色遮罩、三栏并排不重叠、底色不透明；
- 想主动验证自检是否活着：把 `style[data-dsh-puzzle-mode]` 从 `<head>` 里删掉再开面板 ——
  这时**应该**出现诊断行，且 `applied=false rules=null`（表真的没了）；
- 在 Chrome/Edge 新版里正常打开时，那四项特性若被打印出来都应是 `true`。

> 本次修复已用真实 bundle 在模拟层做过对照：同一份 harness 下，
> **修复前**输出 `applied=false, inset/color-mix/backdrop/min() 全 false`（精确复现上报的那一行）；
> **修复后**输出 `applied=true, rules=122, 四项全 true`。

---

## 附带

- 本版本无 API / 文档格式变更，`puzzle:` 仍是 **5**，不需要迁移；
- 同版本已包含 v0.16.4 的「照现有项目搭文档」、v0.16.3 的「新增模块文档」、
  v0.16.2 的 `inset` / `color-mix` 两个真实样式修复。

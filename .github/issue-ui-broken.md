# 远程排障报告：面板显示不正常（样式未生效）

> 这份是给**装插件的用户**看的。你只需要做两件事：
> ① 把面板里那行 `puzzle-style-diag …` 复制出来；
> ② 或者直接升级到 **v0.16.2**，多半就好了。
>
> 下面是给插件作者（我）定位用的技术细节，你可以略过。

---

## 一、症状

面板能打开，但**看起来是坏的**：

- 面板缩在屏幕左上角，没有全屏遮罩、没有居中；
- 面板里的文字**互相重叠**（三栏被挤成一团）；
- 宿主自己的界面从面板底下透出来。

**关键特征**：面板**能渲染内容**（按钮、输入框都在），只是**没有样式**。
这说明 JS 跑得好好的，问题在 CSS。

## 二、最可能的两个成因（v0.16.2 已各修一个）

### 成因 A：`inset:0` 被老浏览器整条丢弃

面板的全屏遮罩原先写的是：

```css
.dshpz-backdrop{position:fixed;inset:0;...}
```

`inset` 是 **Chrome 87+（2020-11）/ Safari 14.1+** 才支持的简写。
不支持的浏览器**不会报错，而是把这一条声明整条丢掉**——于是这个 `position:fixed`
的元素**没有偏移量**，会：

1. 塌成「内容大小」而不是铺满视口 → **缩在左上角**；
2. 因为没了 `inset:0`，`display:flex` 的居中也就失去参照 → 面板贴在角上。

叠加第二个坑：`.dshpz-panel` 的宽度写的是 `width:min(1240px,100%)`，
而 `min()` 是 Chrome 79+。若它也被丢弃，面板宽度退化成「内容宽度」，
里面那个 `grid-template-columns:264px 1fr 424px` 的三栏网格就被塞进一个很窄的框里
→ **列与列互相重叠**，正是截图里的样子。

**v0.16.2 的修法**：
- 全部改用 `top/right/bottom/left` 四边手写（纯 CSS 2.1，任何浏览器都认）；
- 宽度/高度先写 `width:100%;max-width:1240px`，**再用 `min()` 覆盖**——
  不认 `min()` 时前面的声明仍然生效；
- 网格同理：先 `264px auto 424px`，再 `minmax(0,1fr)` 覆盖；
- 另外给遮罩加了**内联样式兜底**：即使整张样式表都没生效，
  面板也至少是「全屏遮罩 + 居中」的可用状态。

### 成因 B：`color-mix` 不支持时，底色被覆盖成无效 → 面板全透明

原先写的是：

```css
@supports (backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px)){
  .dshpz-panel{background-color:color-mix(in srgb,var(--dshpz-glass) 88%,transparent);backdrop-filter:blur(18px)}
}
```

这个 `@supports` **只问了 `backdrop-filter`，却顺手用了 `color-mix`** ——
而 `color-mix` 是**另一项独立特性**（Chrome 111+ / Safari 16.2+）。

浏览器完全可能「认 `backdrop-filter` 但不认 `color-mix`」，
比如 **Chrome 76 ~ 110**：`@supports` 判定通过、进了这个块，
但 `background-color:color-mix(...)` 是**无效值**被丢弃 ——
结果是这一块里的 `background-color` **覆盖失败**，连基底那条
`background-color:var(--dshpz-glass)` 也一起失效 → **面板变成全透明**，
宿主 UI 从面板底下透出来。

**v0.16.2 的修法**：把两项特性拆成**两个独立的 `@supports`**，
`color-mix` 单独判定；只有它真的被支持时才覆盖底色。

## 三、请你提供的信息（任选其一）

### 方式 1：升级后再看（推荐）

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.16.2
```

装完**重启 profile**，刷新页面。若症状消失，就不用管下面的了。

### 方式 2：把面板里的诊断行发我

v0.16.2 起，**样式没生效时面板会自己说出来**，并显示一行环境指纹：

```
puzzle-style-diag applied=<真值> rules=<条数|null> inset=… color-mix=… backdrop=… min()=… ua=…
```

把这一行（连同截图）发出来即可。各项含义：

| 字段 | 含义 |
| --- | --- |
| `applied` | 样式表有没有盖住探针；`false` = **样式表没生效**（这一项是结论，其余是成因线索） |
| `rules` | `<style>` 的 `cssRules` 条数；`null` = **样式表压根没进文档**（CSP / 被清掉） |
| `inset` | `false` = 不支持 `inset` 简写 → 成因 A |
| `color-mix` | `false` = 不支持 `color-mix()` → 成因 B |
| `backdrop` | `false` = 不支持背景模糊（不影响可用性，只影响观感） |
| `min()` | `false` = 不支持 `min()` → 面板宽度会退化成内容宽 |
| `ua` | 浏览器 UA，用来判断 WebView 版本 |

> ⚠️ **若 `applied=false` 且 `inset`/`color-mix`/`backdrop`/`min()` 四项全 `false`，
> 先别排障**：那几乎一定是 **v0.16.5 之前的自检 bug**，不是你的浏览器。
> 成因：探针行内写了 `position:absolute` 盖掉样式表（`applied` 恒 `false`）；
> `CSS.supports` 里的 `CSS` 被本文件的样式表字符串遮蔽（四项恒 `false`）。
> **升到 v0.16.5 再看这一行。**

### 方式 3：手查（没升级时）

在浏览器控制台（或远程调试）执行：

```js
CSS.supports('inset', '0')                                    // false → 成因 A
CSS.supports('color', 'color-mix(in srgb,red 50%,blue)')      // false → 成因 B
CSS.supports('width', 'min(1px,2px)')                         // false → 宽度会退化
document.querySelector('style[data-dsh-puzzle-mode]') !== null // false → 样式表根本没挂上
navigator.userAgent
```

## 四、边界说明（诚实交代）

- 以上是**静态代码分析 + 特性支持表**推出来的成因，**没有**在出问题的那台设备上跑过；
- 我没法访问那台机器（`0.1.6-alpha.2` 是别人的 DSH 版本）；
- 成因 A / B 都能解释截图里的现象，但也**可能存在第三个成因**（例如 CSP 拦掉了 `<style>`、
  或别的插件清空了样式）。诊断行就是为了区分这些情况——`applied=false` 但
  `inset/color-mix` 都是 `true`，就说明是「样式表没挂上」这一类，而不是 A/B。

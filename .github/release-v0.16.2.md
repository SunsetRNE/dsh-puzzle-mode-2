## 下载安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.16.2
```

或直接下载附件：[dsh-puzzle-mode-0.16.2.tgz](https://github.com/liancha22/dsh-puzzle-mode/releases/download/v0.16.2/dsh-puzzle-mode-0.16.2.tgz)

装完**重启 profile**，再刷新页面。

---

## 修「面板能打开但没样式」

有人反馈：面板能打开，但**缩在左上角、文字互相重叠、宿主 UI 从底下透出来**。
关键特征是「**内容都在，只是没样式**」——说明 JS 正常，问题在 CSS。
查下来有两个独立的坑，都修了。

### 坑一：`inset:0` 被老浏览器整条丢弃

面板的全屏遮罩原先写 `position:fixed;inset:0`。`inset` 是
**Chrome 87+（2020-11）/ Safari 14.1+** 的简写；不支持的浏览器**不报错，
而是把这一条声明整条丢掉**。于是这个 fixed 元素没有偏移量：

- 塌成「内容大小」而不是铺满视口 → **缩在左上角**；
- 没了 `inset:0`，`display:flex` 的居中失去参照 → 面板贴在角上。

叠加上第二个点：`.dshpz-panel` 的 `width:min(1240px,100%)` 里
`min()` 是 Chrome 79+，一旦也被丢弃，面板宽度退化成内容宽，
里面 `grid-template-columns:264px 1fr 424px` 的三栏网格就被塞进一个窄框
→ **列与列重叠**，正是截图的样子。

**修法**：

- 遮罩改用 `top/right/bottom/left` 四边手写（纯 CSS 2.1，谁认）；
- 宽高先写 `width:100%;max-width:1240px;max-height:88vh`，
  **再用 `min()` 覆盖** —— 不认 `min()` 时前面的声明仍然生效；
- 网格同理：先 `264px auto 424px`，再 `minmax(0,1fr)` 覆盖；
- 另加**内联样式兜底**：即使整张样式表都没生效，面板也至少是
  「全屏遮罩 + 居中」的可用状态，而不是缩在角上。

> 内联兜底**故意不写 `padding`**：窄屏那条 `@media (max-width:900px)`
> 会把 padding 改成 10px，内联会盖掉媒体查询、把手机端边距改坏。

### 坑二：`color-mix` 不支持时，底色被覆盖成无效 → 面板全透明

原先是一个 `@supports`：

```css
@supports (backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px)){
  .dshpz-panel{background-color:color-mix(in srgb,var(--dshpz-glass) 88%,transparent);...}
}
```

这个 `@supports` **只问了 `backdrop-filter`，却顺手用了 `color-mix`** ——
而 `color-mix` 是**另一项独立特性**（Chrome 111+ / Safari 16.2+）。
浏览器完全可能「认 backdrop-filter 但不认 color-mix」，比如 **Chrome 76 ~ 110**：
`@supports` 判定通过、进了这个块，但 `background-color:color-mix(...)`
是无效值被丢弃 —— 这一块里的 `background-color` **覆盖失败**，
连基底那条 `background-color:var(--dshpz-glass)` 也一起失效
→ **面板全透明**，宿主 UI 透出来。

**修法**：拆成两个独立的 `@supports`，`color-mix` 单独判定，
只有它真被支持时才覆盖底色。

## 新增：样式自检（为远程排障）

样式没生效时，面板现在会**自己说出来**，并显示一行可复制的环境指纹：

```
puzzle-style-diag applied=false inset=… color-mix=… backdrop=… min()=… ua=…
```

- 只在 `applied === false`（确实没生效）时渲染，样式正常时用户看不到任何技术噪音；
- 读数走 `getComputedStyle`，即浏览器**实际采纳**的结果，不是我们写了什么；
- `applied=false` 但 `inset`/`color-mix` 都是 `true`，说明是第三类成因
  （例如 CSP 拦掉 `<style>`、或别的插件清了样式），而不是上面两个坑；
- 自检本身失败会被吞掉，不影响插件正常工作。

---

## 验收判据

- 装完重启、刷新页面：**面板居中、有全屏暗色遮罩、三栏并排不重叠**；
- 面板背景**不透明**（能盖住下面的对话），不是「透出宿主 UI」；
- 在样式正常的浏览器里，面板里**看不到**任何 `puzzle-style-diag` 字样；
- 想主动验证兜底：把 `style[data-dsh-puzzle-mode]` 从 `<head>` 里删掉再开面板 ——
  面板应仍然**全屏居中、可点可用**（只是没有玻璃底与配色），
  并显示那行诊断；
- 手机端（<900px）：内容区能上下滑动到底，面板左右边距是 10px
  （这条用来确认内联兜底没有盖掉媒体查询）。

## 附带

- 同版本已包含 v0.16.1 的 peer 修复：原 `^0.1.6-rc.1` 指向从未发布的版本，
  导致 0.1.6-alpha / 0.1.7-alpha 全系列被排除；现按每个 minor 锚到最早的预发布版，
  13 个已发布版本全覆盖。

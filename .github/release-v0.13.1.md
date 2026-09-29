## 下载安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.13.1
```

或直接下载附件：[dsh-puzzle-mode-0.13.1.tgz](https://github.com/liancha22/dsh-puzzle-mode/releases/download/v0.13.1/dsh-puzzle-mode-0.13.1.tgz)

装完**重启 profile**，再刷新页面。

---

## 关掉某个会话的拼图模式

> ⚠️ **如果你装的是 v0.13.0，请升级**：那一版的开关是「全局时刻」语义，
> 只对*此后新建*的会话生效——你在当前会话里按下去**毫无变化**。
> 这就是用户反馈的「怎么禁用没有效果」。v0.13.1 改成按会话。

### 一、开关改成按会话

```jsonc
{ "op": "settings" }                     // 只查询：本会话禁用了没有
{ "op": "settings", "disabled": true }   // 关掉**本会话**的拼图模式
{ "op": "settings", "disabled": false }  // 恢复**本会话**
```

面板顶部也有对应按钮（「关掉本会话的拼图模式」），**空态也渲染**。

关键语义：

- 记的是**会话 ID 名单**，只影响被点名的那个会话——其他会话照旧；
- **立即生效**：宿主每个 step 都重新 `systemPrompt.assemble(...)`
  （见 `dsh-agent-loop` 的 `preStep`），所以本会话**下一轮**就不再注入拼图规则、
  也不再拦工具，**不必等新会话**；
- 被关掉的会话**完全不受拼图影响**：不注入提示段、不拦工具，就是个普通会话；
- 恢复本会话不影响其他会话的禁用状态。

名单存在 `$DSH_HOME/.dsh-puzzle-mode.json`（`disabledSessions` 数组，上限 200）。
文件坏掉 / 读不出来一律当作「没禁用」：宁可少拦，
也不要因为一个坏文件让所有会话都用不了拼图。

**不兼容旧文件**：v0.13.0 写的 `disabledSince` 字段现在**直接忽略**——
读不到 `disabledSessions` 就当没人被禁用。若你曾用 v0.13.0 开过开关，
升级后等于没开过，需要重新关一次。

### 二、修掉一处真 bug：开关曾被「没绑项目」挡住

`puzzle_mode` 工具有一句守卫：

```js
if (project === '' && !['read', 'audit', 'init', 'bind', 'unbind'].includes(args.op)) {
  return failure('本会话还没绑定拼图项目', ...)
}
```

`settings` **不在放行名单里**。于是最需要它的场景——**还没绑定任何项目**的会话
——调 `op:settings` 会先撞上「本会话还没绑定拼图项目」，开关根本用不了。
已把 `settings` 加入放行名单。

---

## 验收判据

- 面板顶部出现「关掉本会话的拼图模式」；**空态（未绑定项目）也看得到**；
- 点一下 → 提示「已关掉**本会话**的拼图模式」，且**本会话下一轮**就不再
  被拼图规则约束（提示段消失、工具不再被拦）；
- **同时**另开一个会话 → 它**照常**带拼图模式（这才是「单独会话禁用」）；
- 回到原会话点「点此恢复」→ 本会话恢复，其他会话不受影响；
- `op:settings` 在**未绑定任何项目**的会话里也能调用（这正是修掉的那个 bug）；
- `cat $DSH_HOME/.dsh-puzzle-mode.json` 能看到 `disabledSessions` 数组；
  删掉该文件等价于「谁都没被禁用」。

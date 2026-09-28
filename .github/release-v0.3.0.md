## 提问

- 一轮提问上限 **3 → 5**（提示段、init 的 next、面板提问模板的槽位同步）。
- 面板提问模板从 3 个槽位扩到 5 个。

## 审查（op:audit）

新增 `op:audit`：返回 `findings`（客观发现）+ `ranking`（五维升序）+ `prompt`（写点评的指令）。

**审查分两半**：插件只给**事实**（规则数出来的，每条带 `fact` + `fix`），点评由模型写——规则写不出人话，而「一针见血」要上下文。

三档 level：

| level | 含义 |
| --- | --- |
| `blocker` | 数字与文档对不上 |
| `warn` | 该补 |
| `info` | 提示 |

关键发现：

- `progress_no_points` —— 完成度写满而要点为空 → **在装样子**
- `declared_without_evidence` —— 手写高分而证据 0 条 → **自己封的分**
- `never_reviewed` —— 全模块都没人工评估，合并成一条不刷屏

面板新增「审查」按钮（填审查模板，不自动发送）与「审查 · 客观发现」区块。`op:read` 保持精简：只给 `findingCount`；完整 findings 走 `op:audit` 与 RPC 的 `state`。

## 修复（审查自己抓出来的）

可拓展性此前只看模块自己的勾选框，于是主文档写了 5 条已定、这一维仍是 0——**数字与文档事实矛盾**。改为与 `quality` 用主文档「坑」对称：主文档的悬而未决/已定对每个模块都算数。项目健康性 **48 → 68**。

## 安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.3.0
```

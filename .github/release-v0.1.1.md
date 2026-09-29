## 下载安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.1.1
```

> 这一版早于 v0.8.1，Release 页没有附件；用上面的命令装，或直接装最新版。

---

## 修掉一个「测试假绿」的真问题

只拼不写的拦截原先写在 `agent/pre-step` 上，而该事件的 `decision.messages` 契约是 `UserMessage[]`——里面**根本没有 tool-call**。那段「剔除 assistant 消息」是永远不生效的死代码；旧测试自己伪造了一条带 tool-call 的 assistant 消息，所以是**假绿**。

改为 `tools/pre-execute`（真实契约：返回 `{kind:'deny',reason}`），deny 的 reason 会作为该次调用的错误回到模型，正好用来让它改走文档路径。

## 新增能力

- `op:'list'` 列出现有项目（模式/完整度/模块数/更新时间）并标出默认项
- `op:'show'` 读单个模块文档详情（要点/相关决策/详细记录），不建文件
- 图块详情与提问模板

## 提示段写死一条规则

文档只走 `puzzle_mode`，不要用 `write`/`edit`——它们能绕过模块名的 slug 过滤与路径守卫，是只拼不写模式里唯一能写到拼图目录之外的路径。

规则写在**模型动手前必读的提示段**里，而不只是放在 deny 的 reason 里（后者要等它已经犯错才看到）。

## 安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.1.1
```

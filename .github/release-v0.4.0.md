## 下载安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.4.0
```

> 这一版早于 v0.8.1，Release 页没有附件；用上面的命令装，或直接装最新版。

---

## 破坏性变更：一个会话只绑一个项目

- `locate` 解析顺序改为 **显式 project > 本会话绑定 > 空**，删掉「回退最新项目」。
  那条回退正是文档混成一团的根因：新会话一进来就被塞进上一个会话的项目。
- 绑定写进主文档 front-matter 的 `会话: []` 数组，**随文档走**。
- `updateMainSection` / `setMainFields` 透传 `会话`，写小节不再丢绑定。
- 新增 `op:bind` 与 RPC `create`/`bind`；`op:init` 自动绑定并解绑旧项目。
- 只拼不写拦截改用绑定项目判定：**未绑定不拦**，不误伤别的会话。

## 面板

- 新会话空态（不再自动占用别的项目）
- 快速建空壳 / 采访后再建
- 一键绑定、下拉切换即改绑

## 安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.4.0
```

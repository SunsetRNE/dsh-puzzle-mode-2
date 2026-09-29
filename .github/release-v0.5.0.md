## 下载安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.5.0
```

> 这一版早于 v0.8.1，Release 页没有附件；用上面的命令装，或直接装最新版。

---

## 面板表单直建

空态新增表单直建：填项目名/模块名/目标 → 直接调 RPC `create`，**不经过模型**（建空壳是纯机械动作，走模型要多花一整轮对话）。

模块名按 `,` `，` `、` `;` `；` 与空格切分，仍走 `slugify` + `safeJoin` 守卫。

## 新增 op:unbind

解绑本会话回到空，**文档与文件夹都留着**。`bindSession` 的解绑循环抽成 `unbindSession`，解绑语义只有一处实现。

## 提问必须调 ask_user_question

提示段与面板提问模板两处都点明：**在正文里列 ① ② ③ 不算提问**——用户看不到可点选项，只能在聊天里手打。

## 安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.5.0
```

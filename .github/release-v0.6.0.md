## 下载安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.6.0
```

> 这一版早于 v0.8.1，Release 页没有附件；用上面的命令装，或直接装最新版。

---

## 文档格式版本号 + 迁移链

`front-matter` 的 `puzzle:` 正式当**文档格式版本**用（v1 单维完成度 → v2 五维 + 会话绑定）。

新增 `MIGRATIONS` 迁移链与 `pendingMigrations`。**破坏性改动必须 +1 并补一步**——版本号不 +1 的破坏性改动就是「旧文档静默降级」：读得出来、不报错，但形状已经对不上。

## op:rebuild

**默认 dry-run**（预览与实际落盘是**同一份产物**，所以「看到的」就是「会做的」），`apply:true` 才写。

迁移**只改形状**：

- 补 `模块:` / 版本 / 缺失小节
- 去掉模块文档上多余的 `模式:` / `计划模块:`
- 旧完成度按 **×0.5** 折算成五维起点，且**只填推导拿不到分的维度**（填了就冻住推导）
- `## 健康性` 插到标题之后（模板位置），不走 `withSection`（它会插到文末）

## 其他

- `op:read` 带 `version` / `outdated`；审查新增 `doc_outdated`（warn）
- 面板旧格式时出现「重建格式」按钮，**点两次**（预览 → 落盘）

## 实测

拿 v0.1.x 真实备份跑：**73% → 83%**，15 处改动 / 4 个文件，**正文零改动**，幂等（再跑 0 改动）。

## 安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.6.0
```

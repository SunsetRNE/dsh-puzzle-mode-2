# v0.20.3 —— 修包内容：把兼容层的契约与工具装进包

**一句话**：v0.20.2 的 `files` 漏了 `compat.json` / `COMPAT.md` / `tools/`，于是**装出来的包里 `npm test` 会在握手校验那一步直接 ENOENT**。
本版只补包内容，**运行时代码一个字节没动**（`lib/` 与 v0.20.2 逐字节一致）。

## 复现（在 v0.20.2 上，本机实测）

```bash
tar -tzf dsh-puzzle-mode-0.20.2.tgz | grep -c 'compat.json'                 # 0
tar -tzf dsh-puzzle-mode-0.20.2.tgz | grep -c 'tools/verify-cross-plugin.mjs' # 0
cd <装好的插件目录> && node tools/verify-cross-plugin.mjs
#   → Error: ENOENT ... path: '<插件目录>/compat.json'
```

**影响面**：插件本体照常加载（`lib/` 运行时不读 `compat.json`，已核）；坏的是**包自己的验收链**——
`npm test` 末尾那步握手校验因为文件不在包里而失败，而本仓的全部价值就在这条链上。

## 本版改了什么

| 文件 | 改动 |
| --- | --- |
| `package.json` | `files` 补 `tools`、`COMPAT.md`、`compat.json` 三项（版本 0.20.2 → 0.20.3） |
| 其余 | 与 v0.20.2 完全一致（含上游 v0.19.9–v0.20.1 的同步内容与兼容层） |

## 验收判据

```bash
npm pack --dry-run | grep -E 'compat\.json|COMPAT\.md|tools/verify-cross-plugin\.mjs'   # 三行都在
npm test; echo "退出码=$?"                        # 期望 0；末行「跨插件握手校验：21 通过 / 0 失败」
tar -tzf dsh-puzzle-mode-0.20.3.tgz | grep -c 'compat.json'   # 期望 1
cd <装好的插件目录> && node tools/verify-cross-plugin.mjs       # 期望 21 通过 / 0 失败（不再 ENOENT）
```

## 安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github SunsetRNE dsh-puzzle-mode-2 v0.20.3
# 或离线：python3 "$DSH_HOME/plugin-manager.py" import dsh-puzzle-mode-0.20.3.tgz
```

## 记一笔

这条缺陷是**发版后装机自检**抓到的：装完在插件目录里跑一遍 `node tools/verify-cross-plugin.mjs` 就露了。
所以 `COMPAT.md` §五 加了一条纪律：**每次发版前用 `npm pack --dry-run` 核 `compat.json` 与 `tools/` 在场**。

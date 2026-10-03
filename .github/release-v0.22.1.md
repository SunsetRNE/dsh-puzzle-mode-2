# dsh-puzzle-mode v0.22.1（兼容性复刻仓 · 瘦身版）

> 本仓 = **上游 `liancha22/dsh-puzzle-mode` v0.22.0 + 三件上游没有的东西**。
> 上游 v0.22.0 已把「跨插件共存层」并回主线，本仓据此**退役**了原先重复维护的兼容面。

## 这版做了什么

| 项 | 内容 |
| --- | --- |
| **瘦身** | 段序可协商（默认 **10120**）、`compat.json` 契约、`COMPAT.md`、`tools/verify-cross-plugin.mjs`、CI 校验 —— **全部取上游 v0.22.0**，本仓不再各留一份 |
| **保留** | `tools/log-compat.mjs`（互校归档器）· `tools/sync-upstream.mjs`（上游同步器）· `compat-log.jsonl`（归档账本） |
| **版本号** | `0.22.1`（上游 0.22.0 + 本仓三件；序号独立，避免与上游同号歧义） |

## 段序为什么是 10120

上游 v0.22.0 把默认段序从 `10500` 改为**可协商的 `10120`**：

- `10100` 与 **DSH 内置段序表**的 `WEB_SURFACE: 10100` **撞号**
  （`@deepseek-ai/dsh-system-prompt` 的 `SECTION_ORDERS`：`HARNESS_SOURCE: 1e4` / `WEB_SURFACE: 10100` / `DEPLOYMENT_PERSONA_SUFFIX: 10200`）；
- 段序相同时宿主排序**回退到按段名比较**（`comparePromptSections: a.order - b.order || compareNames(…)`）——
  撞号意味着「拼图段排在 `dsh-infinite-gen-5` 末位锚点 `10150` 之前」不再由协商决定；
- `10120` 三条都满足：小于 `10150`、不落在内置表任何取值上、仍可被 `PUZZLE_SECTION_ORDER` 覆盖。

## 验证（本仓实测）

```bash
npm test                      # 上游全链测试 + 握手校验，退出码 0
npm run verify:cross          # 23 通过 / 0 失败
npm run log:compat            # 归档一行：0.22.0 / 0.65.5 / 10120<10150 / 6 条 / 23/0 / 21/0 / ok
```

与本仓对接的 `dsh-infinite-gen-5` 侧（v0.65.5）已把 `PZ_ORDER_FORK_DEFAULT` 同步为 **10120**，
双向互校闭环（其 issue #1 已关闭）。

## 安装

```bash
npm i <本 release 附件 dsh-puzzle-mode-0.22.1.tgz>
# 或按你惯用的插件管理器装本仓；装完重启 profile 生效
```

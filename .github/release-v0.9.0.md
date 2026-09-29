## 下载安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.9.0
```

或直接下载附件：[dsh-puzzle-mode-0.9.0.tgz](https://github.com/liancha22/dsh-puzzle-mode/releases/download/v0.9.0/dsh-puzzle-mode-0.9.0.tgz)

装完**重启 profile**，再刷新页面。

---

## 接续会话：新会话不必通读全部文档

新会话慢的根因不是文档大，是**读法错了**。

项目文档是「主文档 + N 个模块文档」，全量读一遍是几千字（本项目实测 **8888 字符**），
而本轮真正用得到的通常只有一两个模块。主文档本来就是**查找入口**
（模块索引 / 源码索引 / 工具索引 / 坑），正确顺序是：

```
op:read（brief）→ 只读主文档 → 只读本轮相关的那一个模块 → 按「源码索引」跳源码
```

而不是把模块目录整个读一遍。

### 1. `op:read` 新增 `brief:true` 精简档

```jsonc
{ "op": "read", "brief": true }
```

精简掉：

- 每个模块的五维明细与来源（原本占返回的 **67%**）
- 五维说明表 `dimensionMeta`（372 字符）——同时把 `dimensions` 的 key 换成**中文维度名**，
  这样去掉图例也不会看不懂

并**附带 `readNext` 指路数组**，直接告诉你下一步该读哪个文件。

**实测：2916 → 1105 字符，省 62%。**

不带 `brief` 的 `op:read` **保持原样**（有 `dimensionMeta`、`dimensions` 是英文 key）——
面板依赖这些字段，精简档不会改坏它。

### 2. 面板新增「接续会话」按钮

点它，把这段读法填进当前会话的输入框（**只填、不自动发送**）：

```
1. puzzle_mode{op:"read", brief:true}：精简档
2. 只读主文档：<绝对路径> —— 它只有四节，是查找入口
3. 按本轮要动的地方，只读相关的那一个模块文档；不确定就先问我
4. 需要看实现时按「源码索引」直接跳源码
```

最后要求模型用三句话回报：这个项目在干什么、当前最弱的一维、打算从哪继续。

### 3. 提示段同步

系统提示段里写明「**新会话不要通读全部文档**」，并给出上面的顺序；
工具描述也标了 `brief:true` 的用途。这样即使不点按钮，模型也会按这个读法走。

### 设计取舍

两条都只是**指路**，没有偷偷替模型读文件——读什么、读多少仍由模型决定。
按钮也不自动发送：看不顺眼可以改完再发。

## 安装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.9.0
```

或导入 Release 附件 `dsh-puzzle-mode-0.9.0.tgz`。

装完**重启 profile**（宿主半是 `patchReload: startup`），再刷新浏览器页面。

## 验收判据

- `puzzle_mode{op:'read', brief:true}` → 返回里**没有** `dimensionMeta`，
  `dimensions` 是中文维度名，`modules` 每项只有 `name`/`exists`/`health`/`progress`，
  并附 `readNext`；
- 同一个项目，`brief:true` 的返回比不带 brief **小 60% 左右**；
- 不带 brief 的 `op:read` 保持原样；
- 面板点「接续会话」→ 输入框出现按需读提示词，第 2 步是主文档的**绝对路径**，
  且**不含**「要不要先停下？」。

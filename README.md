# 飞镖 501 双倍结束计分后端

本地可运行的飞镖 501（直接起分、双倍结束）计分后端，仅提供 HTTP API 与 CLI，无前端。
技术栈：TypeScript + Node.js（>= 22.5，推荐 24+）+ SQLite（Node 内置 `node:sqlite`，零运行时依赖）。
不需要 Docker、WSL 或任何外部服务。

## 功能范围

- 2–8 名玩家固定顺序轮流投掷，每回合最多 3 镖
- 默认起分 501，支持 2–501 的练习起分
- 双倍结束 + 爆分的**回合原子性**：爆分恢复回合开始分数并立即换人
- 落点语义录入（单/双/三倍区 1–20、单牛眼 25、双牛眼 50、脱靶 0），拒绝非法组合
- 逐镖事件持久化，支持导出与独立重放核验；重启后可继续未结束的比赛
- 请求编号幂等：同号同载荷重试返回原结果，同号不同载荷拒绝
- 不包含赛事排程、摄像识别、投注、撤销历史事件

## 快速开始

```powershell
npm install        # 仅安装 typescript 与 @types/node（开发依赖）
npm test           # 运行 14 个测试
npm run build      # 编译到 dist/
npm run demo       # 运行内置演示（爆分 / 获胜 / 正常交接）
npm start          # 启动 HTTP 服务（默认自动选择空闲端口，$env:PORT=8080 可指定）
```

数据库文件默认在 `data/darts.db`，可用环境变量 `DARTS_DB` 覆盖。

## CLI 用法

```powershell
node src/cli.ts create 2 32                 # 建局：2 人，起分 32
node src/cli.ts throw 1 0 1 r1 s16          # 比赛1 玩家0 回合1 请求r1 单倍16
node src/cli.ts throw 1 0 1 r2 t6           # 三倍6 -> 爆分
node src/cli.ts state 1                     # 当前状态
node src/cli.ts events 1                    # 逐镖事件解释
node src/cli.ts export 1 export.json        # 导出
node src/cli.ts verify 1                    # 从事件重放核验
```

落点记号：`s16`=单倍16，`d10`=双倍10，`t20`=三倍20，`sb`=单牛眼25，`db`=双牛眼50，`miss`=脱靶。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/matches` | 建局 `{playerCount, startScore?, playerNames?}` |
| POST | `/matches/:id/throws` | 投镖 `{requestId, playerIdx, round, dart}` |
| GET | `/matches/:id` | 当前状态与比分 |
| GET | `/matches/:id/turn` | 当前回合（玩家、已投镖、剩余镖数） |
| GET | `/matches/:id/events` | 逐镖事件解释 |
| GET | `/matches/:id/export` | 完整导出（可独立重放） |
| POST | `/matches/:id/verify` | 重放核验，不一致时报告错误且不修改历史 |

`dart` 示例：`{"ring":"single","segment":16}`、`{"ring":"double","segment":10}`、
`{"ring":"triple","segment":20}`、`{"ring":"single","segment":25}`（单牛眼）、
`{"ring":"double","segment":25}`（双牛眼）、`{"ring":"miss"}`（脱靶）。

每镖响应包含：落点分值 `dartValue`、投掷前余额 `scoreBefore`、临时余额 `tempScore`、
爆分原因 `bustReason`、回合起始值 `roundStartScore`、最终保留分 `keptScore`，
以及 `outcome`（`continue` / `turn_complete` / `bust` / `win`）。

## 规则要点

- 扣分后低于 0、恰好剩 1、或到 0 但最后一镖不是双倍区 → 本回合爆分：
  分数恢复为回合开始值，立即轮到下一位，本回合不可继续投镖。
- 恰好到 0 且最后一镖为双倍区（含双牛眼 50）→ 立即获胜，之后任何投镖返回 `MATCH_FINISHED`。
- 三倍区与单牛眼不能作为结束镖；脱靶占一镖且计 0 分。
- 三镖用完未获胜未爆分 → 保留临时余额并自动交接；玩家顺序循环。

## 文本比分表演示

正常回合（起分 501，三镖后交接）：

```
回合1 玩家0 第1镖 三倍20(60) | 投前 501 -> 临时 441 | continue      | 保留 441
回合1 玩家0 第2镖 三倍20(60) | 投前 441 -> 临时 381 | continue      | 保留 381
回合1 玩家0 第3镖 单倍5(5)   | 投前 381 -> 临时 376 | turn_complete | 保留 376  -> 轮到玩家1
```

爆分（练习起分 32）：

```
回合1 玩家0 第1镖 单倍16(16) | 投前 32 -> 临时 16 | continue | 保留 16
回合1 玩家0 第2镖 三倍6(18)  | 投前 16 -> 临时 -2 | bust     | 保留 32  爆分原因: 低于零 -> 轮到玩家1
```

获胜（练习起分 40）：

```
回合1 玩家0 第1镖 单倍20(20) | 投前 40 -> 临时 20 | continue | 保留 20
回合1 玩家0 第2镖 双倍10(20) | 投前 20 -> 临时 0  | win      | 保留 0   比赛结束
```

## 错误码

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `INVALID_PARAMS` | 400 | 参数缺失或越界（玩家数 2–8、起分 2–501 等） |
| `INVALID_DART` | 400 | 非法落点（三倍牛眼、21 分区等） |
| `INVALID_JSON` / `PAYLOAD_TOO_LARGE` | 400 / 413 | 请求体非法或超过 16KB |
| `MATCH_NOT_FOUND` | 404 | 比赛不存在 |
| `MATCH_FINISHED` | 409 | 比赛已结束 |
| `WRONG_PLAYER` | 409 | 非当前玩家 |
| `STALE_ROUND` | 409 | 陈旧回合号 |
| `REQUEST_CONFLICT` | 409 | 请求编号已用于不同载荷 |
| `ROUND_COMPLETE` / `LIMIT_EXCEEDED` | 409 | 回合三镖已满 / 事件数超上限（100000） |

注意：合法爆分是比赛事件（HTTP 200，`outcome=bust`），参数错误是拒绝操作（4xx），两者不混淆。

## 限制与假设

- 单进程服务；事务（`BEGIN IMMEDIATE`）保证投镖、回合结束与换人的原子性，并发请求在 SQLite 层串行化。
- 玩家编号固定为 0..N-1，创建后不可增减玩家。
- 不支持撤销任意历史事件；`verify` 只报告不一致，绝不修改历史。
- `node:sqlite` 目前带有 ExperimentalWarning，不影响功能。
- 需要 Node.js >= 22.5（建议 24+）；直接以类型剥离方式运行 `.ts`，也可用 `npm run build` 编译到 `dist/` 后运行。

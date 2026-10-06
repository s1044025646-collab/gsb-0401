# 飞镖 501 双倍结束 / 爆分回合回放后端

Windows 本地可运行的飞镖计分后端，只提供 **HTTP API 与命令行（CLI）**，无任何前端。
使用 TypeScript + Node.js（内置 `node:http`）+ SQLite（内置 `node:sqlite`），
**不依赖 Docker、WSL、原生编译、付费服务或外部在线 API**。

## 特性与范围

- 2 至 8 名玩家，按固定顺序循环投掷；每回合最多 3 镖。
- 直接起分（默认 501），允许 2..501 的练习起分；**双倍区结束**（double-out）。
- 落点语义录入：`1..20` 分区的单/双/三倍、牛眼（`section=25`：单 25 / 双 50）、脱靶（`section=0`）。
  拒绝不存在的组合，如三倍牛眼、21 分区、4 倍区。
- **回合原子性**：一镖后若低于 0、恰好剩 1、或到 0 但末镖不是双倍区，则本回合爆分，
  分数整回合回滚到回合起始值，并立即换到下一人；爆分后不能继续投本回合。
  到 0 且末镖为双倍区（含双牛眼 50）立即获胜，赛后一切投镖被拒绝。
- 逐镖事件溯源：每次结果都记录落点分值、投前余额、临时余额、爆分原因、回合起始值、最终保留分数。
- 幂等：相同 `requestId` + 相同载荷的重试返回原结果、不重复扣分；相同 `requestId` 不同载荷返回冲突。
- 单次投镖、回合结束、选择下一位玩家在**同一 SQLite 事务**内完成。
- 重启后从同一数据库继续未结束回合；可从事件表独立重放并与缓存分数核对，不一致只报错、绝不篡改历史。

## 环境要求

- Windows + Node.js **>= 22.5**（开发验证于 Node 25.5.0，内置 `node:sqlite`）。
- 在项目根目录执行以下命令（PowerShell）。

## 安装与构建

```powershell
npm install
npm run build
```

## 一键演示

```powershell
npm run demo
```

演示包含：起分 32 爆分回滚、起分 40 双倍获胜、501 正常三镖换人、重放核验与幂等重试。

## 启动 HTTP 服务

```powershell
# 默认自动选择一个空闲端口；也可用 --port 指定
npm start
# 或
node --experimental-sqlite --no-warnings dist/server.js --port=8080
```

启动后会打印实际监听地址，例如 `http://127.0.0.1:58829`。
数据库默认在项目内 `data/darts.db`，可用环境变量 `DARTS_DB` 覆盖。

## HTTP API

所有请求/响应均为 JSON。请求体上限 16 KB。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/games` | 建局。body：`{"startScore":32,"players":["甲","乙"]}`（均可选） |
| POST | `/games/{id}/throw` | 录入一镖 |
| GET | `/games/{id}/status` | 当前回合与玩家比分 |
| GET | `/games/{id}/export` | 导出含全部逐镖事件的比赛记录 |
| POST | `/games/{id}/verify` | 从事件重放并与缓存核对 |
| GET | `/health` | 健康检查 |

### 投镖请求

```json
{
  "requestId": "唯一请求编号，重试时保持不变",
  "playerIndex": 0,
  "turnId": 1,
  "dart": { "section": 6, "multiplier": 3 }
}
```

- `section`：`1..20` 分区，`25` 牛眼，`0` 脱靶。
- `multiplier`：`1` 单倍 / `2` 双倍 / `3` 三倍。牛眼仅允许 `25x1=25` 与 `25x2=50`；脱靶固定 `0x1=0`。

### 投镖响应（关键字段）

```json
{
  "duplicate": false,
  "result": {
    "requestId": "r2", "eventId": 2, "playerIndex": 0, "turnId": 1, "dartInTurn": 2,
    "label": "三倍 6", "dartValue": 18,
    "scoreBefore": 16, "tempScore": -2,
    "turnStartScore": 32, "finalScore": 32,
    "busted": true, "bustReason": "BELOW_ZERO",
    "won": false, "turnEnded": true,
    "nextPlayerIndex": 1, "nextTurnId": 2
  }
}
```

### 错误码

| HTTP | error | 含义 |
| --- | --- | --- |
| 400 | `INVALID_DART` | 落点组合不存在（参数错误，**不是**爆分） |
| 400 | `INVALID_START_SCORE` / `INVALID_PLAYERS` / `INVALID_REQUEST_ID` / `INVALID_TURN` / `INVALID_PLAYER` / `INVALID_JSON` | 参数校验失败 |
| 404 | `GAME_NOT_FOUND` / `NOT_FOUND` | 比赛或路径不存在 |
| 409 | `NOT_YOUR_TURN` | 不是当前玩家 |
| 409 | `STALE_TURN` | 回合编号已过期 |
| 409 | `GAME_FINISHED` | 比赛已结束仍投镖 |
| 409 | `REQUEST_CONFLICT` | 相同 requestId 携带不同载荷 |
| 409 | `REPLAY_MISMATCH` | 事件重放与缓存/历史不一致 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超限 |
| 405 | `METHOD_NOT_ALLOWED` | 方法不支持 |

爆分原因 `bustReason`：`BELOW_ZERO`（低于零）、`LEFT_ONE`（剩 1）、`NOT_DOUBLE`（到零但非双倍）。

### curl / PowerShell 示例

```powershell
$base = 'http://127.0.0.1:8080'
$g = Invoke-RestMethod -Method Post "$base/games" -ContentType 'application/json' -Body '{"startScore":32}'
$id = $g.gameId
Invoke-RestMethod -Method Post "$base/games/$id/throw" -ContentType 'application/json' `
  -Body '{"requestId":"a1","playerIndex":0,"turnId":1,"dart":{"section":16,"multiplier":1}}'
Invoke-RestMethod -Method Post "$base/games/$id/throw" -ContentType 'application/json' `
  -Body '{"requestId":"a2","playerIndex":0,"turnId":1,"dart":{"section":6,"multiplier":3}}'
Invoke-RestMethod "$base/games/$id/status"
```

## 命令行 CLI

```powershell
# 数据库可用 DARTS_DB 指定，默认 ./data/darts.db
node dist/cli.js create --start=32 --players=甲,乙
node dist/cli.js throw  <gameId> <requestId> <playerIndex> <turnId> <section> <multiplier>
node dist/cli.js status <gameId>
node dist/cli.js export <gameId>
node dist/cli.js verify <gameId>
```

## 文本比分表演示

### 1) 正常回合（起分 501，玩家 A/B/C）

```
玩家A 第1回合（回合起始 501）
  镖1 三倍20 = 60   501 -> 441   保留 441
  镖2 三倍19 = 57   441 -> 384   保留 384
  镖3 三倍18 = 54   384 -> 330   保留 330
三镖用完，回合结束 -> 玩家B（第2回合，起始 501）
比分: A=330  B=501  C=501
```

### 2) 爆分回滚（起分 32，玩家 甲/乙）

```
玩家甲 第1回合（回合起始 32）
  镖1 单倍16 = 16   32 -> 16    保留 16
  镖2 三倍6  = 18   16 -> -2    爆分 BELOW_ZERO
整回合回滚到回合起始值 32（不保留前面已扣的 16），立即换玩家乙
比分: 甲=32  乙=32（乙当前，第2回合，起始 32）
```

其他爆分：扣分后恰好剩 1（`LEFT_ONE`）；到 0 但末镖不是双倍区（`NOT_DOUBLE`，
例如剩 25 投单牛眼）。剩 50 投双牛眼则合法获胜。

### 3) 双倍获胜（起分 40）

```
玩家丙 第1回合（回合起始 40）
  镖1 单倍20 = 20   40 -> 20    保留 20
  镖2 双倍10 = 20   20 -> 0     末镖为双倍区，获胜，比赛结束
比分: 丙=0（胜者）  丁=40；此后任何投镖请求返回 GAME_FINISHED
```

## 数据模型

SQLite（WAL 模式）包含四张表：

- `games`：比赛配置与当前状态（当前玩家、当前回合、回合起始分、本回合已投镖数、胜者）。
- `events`：按序逐镖事件，含投前/临时/回合起始/最终分数与爆分、交接信息，是可独立重放的事实来源。
- `scores`：每位玩家当前缓存分数（派生数据，供快速查询）。
- `requests`：`requestId -> 载荷哈希 + 原响应`，用于幂等。

`GET /games/{id}/export` 导出的事件足以脱离数据库独立重放；`POST /games/{id}/verify`
会重放全部事件并逐字段核对，再与 `games`/`scores` 缓存比对，发现不一致返回 `REPLAY_MISMATCH`，
不会改动历史。

## 测试

```powershell
npm test
```

测试使用内置 `node:test`，覆盖：规则与非法落点、剩 2 投单一爆分、单牛眼不能结束 / 双牛眼结束、
脱靶占镖、三镖换人、错误玩家与陈旧回合、赛后拒绝、手写事件表逐步核对余额与玩家、
幂等重复/冲突、事务回滚、重启接续、重放不一致检测，以及完整 HTTP API 流程。

## 限制与假设

- 只管理单局比赛与逐镖事件，不做赛事排程、摄像识别、投注或复杂职业赛制（无 Sets/Legs/Start 规则）。
- 不支持撤销任意旧事件；如需更正，应以事件为准重新建局。
- 单机单进程使用；事务（`BEGIN IMMEDIATE`）已保证同进程内并发提交串行化。
- `node:sqlite` 在当前 Node 版本带实验性标记，运行命令已加 `--experimental-sqlite --no-warnings`。
- 数据目录固定在项目内 `data/`；玩家数 2..8、请求体 16 KB、起分 2..501 为公开限制。

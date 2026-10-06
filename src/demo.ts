// 端到端演示：建局、正常回合、爆分回滚、双倍获胜，最后核验重放

import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { GameService } from './service.js';
import { BUST_REASON_TEXT } from './rules.js';

const dbPath = resolve('data/demo.db');
rmSync(dbPath, { force: true });
rmSync(dbPath + '-wal', { force: true });
rmSync(dbPath + '-shm', { force: true });

const store = new Store(dbPath);
const game = new GameService(store);

function line(t: string): void {
  console.log('\n=== ' + t + ' ===');
}

function t(gameId: number, id: string, p: number, turn: number, s: number, m: number): void {
  const { result } = game.throwDart(gameId, {
    requestId: id,
    playerIndex: p,
    turnId: turn,
    dart: { section: s, multiplier: m },
  });
  const r = result as Record<string, unknown>;
  let tail = '';
  if (r.busted) tail = ` 爆分(${BUST_REASON_TEXT[r.bustReason as string]})->恢复${r.finalScore}`;
  if (r.won) tail = ' 获胜!';
  if (r.turnEnded && !r.won) tail += ` ->换玩家${r.nextPlayerIndex}`;
  console.log(
    `${r.label}: ${r.scoreBefore}-${r.dartValue}=${r.tempScore} 保留${r.finalScore}${tail}`,
  );
}

line('演示1: 起分32，单16后三倍6，第二镖爆分恢复32并换人');
let g = game.createGame({ startScore: 32, players: ['甲', '乙'] });
t(g.gameId, 'a1', 0, 1, 16, 1); // 32-16=16
t(g.gameId, 'a2', 0, 1, 6, 3); // 16-18=-2 爆分，恢复32，换乙
const st1 = game.status(g.gameId);
console.log(`玩家甲最终分数=${st1.players[0].score}（应为32），当前玩家=${st1.game.current_player}（应为1）`);

line('演示2: 起分40，单20后双10，双倍获胜');
g = game.createGame({ startScore: 40, players: ['丙', '丁'] });
t(g.gameId, 'b1', 0, 1, 20, 1); // 40-20=20
t(g.gameId, 'b2', 0, 1, 10, 2); // 20-20=0 双倍获胜

line('演示3: 正常三镖与换人（起分501）');
g = game.createGame({ startScore: 501, players: ['A', 'B', 'C'] });
t(g.gameId, 'c1', 0, 1, 20, 3); // 60
t(g.gameId, 'c2', 0, 1, 19, 3); // 57
t(g.gameId, 'c3', 0, 1, 18, 3); // 54，三镖用完换B

line('重放核验');
const report = game.verify(g.gameId);
console.log(`核验通过，事件数=${report.eventCount}，当前玩家=${report.state.currentPlayer} 第${report.state.currentTurn}回合`);

line('幂等重试');
const first = game.throwDart(g.gameId, {
  requestId: 'c1',
  playerIndex: 0,
  turnId: 1,
  dart: { section: 20, multiplier: 3 },
});
console.log(`重复 requestId 返回 duplicate=${first.duplicate}，未重复扣分`);

store.close();
console.log('\n演示完成，数据库位于 ' + dbPath);

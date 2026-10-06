import { openDb } from '../src/db.ts';
import { createMatch, recordThrow, getState } from '../src/engine.ts';

const db = openDb(':memory:');

function board(title: string, matchId: number) {
  const s = getState(db, matchId);
  console.log(`\n== ${title} ==`);
  console.log('玩家  分数  回合起始');
  for (const p of s.players) {
    const mark = s.currentPlayer === p.idx ? '*' : ' ';
    console.log(`${mark} ${p.name}  ${String(p.score).padStart(4)}  ${p.roundStartScore}`);
  }
  if (s.winner !== null) console.log(`胜者: 玩家${s.winner}`);
}

function t(matchId: number, playerIdx: number, round: number, req: string, dart: object) {
  const r = recordThrow(db, matchId, { requestId: req, playerIdx, round, dart });
  const bust = r.bustReason ? ` 爆分原因: ${r.bustReason}` : '';
  console.log(
    `回合${r.round} 玩家${r.playerIdx} 第${r.dartIndex}镖 ${r.dartDescription}`
    + ` | 投前 ${r.scoreBefore} -> 临时 ${r.tempScore} | 结果 ${r.outcome} | 保留 ${r.keptScore}${bust}`,
  );
}

console.log('--- 演示 1: 起分 32，单16 后三倍6 爆分 ---');
const m1 = createMatch(db, { playerCount: 2, startScore: 32 });
board('开局', m1.matchId);
t(m1.matchId, 0, 1, 'd1-r1', { ring: 'single', segment: 16 });
t(m1.matchId, 0, 1, 'd1-r2', { ring: 'triple', segment: 6 });
board('爆分后（恢复 32，轮到玩家1）', m1.matchId);

console.log('\n--- 演示 2: 起分 40，单20 后双10 获胜 ---');
const m2 = createMatch(db, { playerCount: 2, startScore: 40 });
t(m2.matchId, 0, 1, 'd2-r1', { ring: 'single', segment: 20 });
t(m2.matchId, 0, 1, 'd2-r2', { ring: 'double', segment: 10 });
board('获胜后', m2.matchId);

console.log('\n--- 演示 3: 正常三镖回合交接 ---');
const m3 = createMatch(db, { playerCount: 2, startScore: 501 });
t(m3.matchId, 0, 1, 'd3-r1', { ring: 'triple', segment: 20 });
t(m3.matchId, 0, 1, 'd3-r2', { ring: 'triple', segment: 20 });
t(m3.matchId, 0, 1, 'd3-r3', { ring: 'single', segment: 5 });
board('三镖用完自动换人', m3.matchId);

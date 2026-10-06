import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { createMatch, recordThrow, getState, getEvents, verifyMatch, exportMatch } from '../src/engine.ts';
import { ApiError } from '../src/domain.ts';

function mem() {
  return openDb(':memory:');
}
function thr(db: any, id: number, playerIdx: number, round: number, req: string, dart: object) {
  return recordThrow(db, id, { requestId: req, playerIdx, round, dart });
}

test('演示场景: 起分32 单16 后三倍6 爆分恢复32并换人', () => {
  const db = mem();
  const m = createMatch(db, { playerCount: 2, startScore: 32 });
  const r1 = thr(db, m.matchId, 0, 1, 'a1', { ring: 'single', segment: 16 });
  assert.equal(r1.tempScore, 16);
  assert.equal(r1.outcome, 'continue');
  const r2 = thr(db, m.matchId, 0, 1, 'a2', { ring: 'triple', segment: 6 });
  assert.equal(r2.outcome, 'bust');
  assert.equal(r2.keptScore, 32);
  assert.equal(r2.roundStartScore, 32);
  assert.equal(r2.scoreBefore, 16);
  assert.equal(r2.tempScore, -2);
  assert.ok(r2.bustReason);
  const s = getState(db, m.matchId);
  assert.equal(s.players[0].score, 32);
  assert.equal(s.currentPlayer, 1);
  // 爆分后本回合结束，玩家0 再投属于错误玩家
  assert.throws(() => thr(db, m.matchId, 0, 1, 'a3', { ring: 'single', segment: 1 }),
    (e: ApiError) => e.code === 'WRONG_PLAYER');
});

test('演示场景: 起分40 单20 双10 获胜', () => {
  const db = mem();
  const m = createMatch(db, { playerCount: 2, startScore: 40 });
  thr(db, m.matchId, 0, 1, 'b1', { ring: 'single', segment: 20 });
  const r2 = thr(db, m.matchId, 0, 1, 'b2', { ring: 'double', segment: 10 });
  assert.equal(r2.outcome, 'win');
  assert.equal(r2.keptScore, 0);
  assert.equal(getState(db, m.matchId).winner, 0);
  // 赛后拒绝
  assert.throws(() => thr(db, m.matchId, 1, 1, 'b3', { ring: 'single', segment: 1 }),
    (e: ApiError) => e.code === 'MATCH_FINISHED');
});

test('剩2时单1导致爆分(剩1)', () => {
  const db = mem();
  const m = createMatch(db, { playerCount: 2, startScore: 2 });
  const r = thr(db, m.matchId, 0, 1, 'c1', { ring: 'single', segment: 1 });
  assert.equal(r.outcome, 'bust');
  assert.equal(r.tempScore, 1);
  assert.equal(r.keptScore, 2);
});

test('单牛眼不能结束，双牛眼可以结束', () => {
  const db = mem();
  const m = createMatch(db, { playerCount: 2, startScore: 25 });
  const r = thr(db, m.matchId, 0, 1, 'e1', { ring: 'single', segment: 25 });
  assert.equal(r.outcome, 'bust');
  assert.equal(r.keptScore, 25);
  const m2 = createMatch(db, { playerCount: 2, startScore: 50 });
  const r2 = thr(db, m2.matchId, 0, 1, 'e2', { ring: 'double', segment: 25 });
  assert.equal(r2.outcome, 'win');
});

test('三倍牛眼与21分区被拒绝', () => {
  const db = mem();
  const m = createMatch(db, { playerCount: 2, startScore: 501 });
  assert.throws(() => thr(db, m.matchId, 0, 1, 'f1', { ring: 'triple', segment: 25 }),
    (e: ApiError) => e.code === 'INVALID_DART');
  assert.throws(() => thr(db, m.matchId, 0, 1, 'f2', { ring: 'single', segment: 21 }),
    (e: ApiError) => e.code === 'INVALID_DART');
});

test('脱靶占一镖', () => {
  const db = mem();
  const m = createMatch(db, { playerCount: 2, startScore: 501 });
  const r = thr(db, m.matchId, 0, 1, 'g1', { ring: 'miss' });
  assert.equal(r.dartValue, 0);
  assert.equal(r.dartIndex, 1);
  const r2 = thr(db, m.matchId, 0, 1, 'g2', { ring: 'single', segment: 20 });
  assert.equal(r2.dartIndex, 2);
});

test('三镖用完自动换人，回合循环', () => {
  const db = mem();
  const m = createMatch(db, { playerCount: 2, startScore: 501 });
  thr(db, m.matchId, 0, 1, 'h1', { ring: 'single', segment: 20 });
  thr(db, m.matchId, 0, 1, 'h2', { ring: 'single', segment: 20 });
  const r3 = thr(db, m.matchId, 0, 1, 'h3', { ring: 'single', segment: 20 });
  assert.equal(r3.outcome, 'turn_complete');
  assert.equal(r3.nextPlayer, 1);
  assert.equal(r3.nextRound, 1);
  const s = getState(db, m.matchId);
  assert.equal(s.players[0].score, 441);
  assert.equal(s.currentPlayer, 1);
  // 玩家1 三镖后回到玩家0，回合变 2
  thr(db, m.matchId, 1, 1, 'h4', { ring: 'single', segment: 1 });
  thr(db, m.matchId, 1, 1, 'h5', { ring: 'single', segment: 1 });
  const r6 = thr(db, m.matchId, 1, 1, 'h6', { ring: 'single', segment: 1 });
  assert.equal(r6.nextPlayer, 0);
  assert.equal(r6.nextRound, 2);
});

test('陈旧回合被拒绝', () => {
  const db = mem();
  const m = createMatch(db, { playerCount: 2, startScore: 501 });
  assert.throws(() => thr(db, m.matchId, 0, 2, 'i1', { ring: 'single', segment: 1 }),
    (e: ApiError) => e.code === 'STALE_ROUND');
});

test('幂等: 相同请求编号相同载荷返回原结果，不同载荷拒绝', () => {
  const db = mem();
  const m = createMatch(db, { playerCount: 2, startScore: 501 });
  const r1 = thr(db, m.matchId, 0, 1, 'j1', { ring: 'single', segment: 20 });
  const r2 = thr(db, m.matchId, 0, 1, 'j1', { ring: 'single', segment: 20 });
  assert.equal(r2.idempotentReplay, true);
  assert.equal(r2.seq, r1.seq);
  assert.equal(getState(db, m.matchId).players[0].score, 481); // 只扣一次
  assert.throws(() => thr(db, m.matchId, 0, 1, 'j1', { ring: 'single', segment: 19 }),
    (e: ApiError) => e.code === 'REQUEST_CONFLICT');
});

test('逐镖事件表核对每一步余额与玩家', () => {
  const db = mem();
  const m = createMatch(db, { playerCount: 2, startScore: 100 });
  thr(db, m.matchId, 0, 1, 'k1', { ring: 'triple', segment: 20 }); // 100->40
  thr(db, m.matchId, 0, 1, 'k2', { ring: 'single', segment: 5 });  // 40->35
  thr(db, m.matchId, 0, 1, 'k3', { ring: 'miss' });                // 35->35, 交接
  thr(db, m.matchId, 1, 1, 'k4', { ring: 'single', segment: 25 }); // 100->75
  const evs = getEvents(db, m.matchId);
  const expected = [
    { playerIdx: 0, dartIndex: 1, scoreBefore: 100, tempScore: 40, keptScore: 40, outcome: 'continue' },
    { playerIdx: 0, dartIndex: 2, scoreBefore: 40, tempScore: 35, keptScore: 35, outcome: 'continue' },
    { playerIdx: 0, dartIndex: 3, scoreBefore: 35, tempScore: 35, keptScore: 35, outcome: 'turn_complete' },
    { playerIdx: 1, dartIndex: 1, scoreBefore: 100, tempScore: 75, keptScore: 75, outcome: 'continue' },
  ];
  assert.equal(evs.length, 4);
  for (let i = 0; i < expected.length; i++) {
    const { playerIdx, dartIndex, scoreBefore, tempScore, keptScore, outcome } = expected[i];
    assert.deepEqual(
      { playerIdx: evs[i].playerIdx, dartIndex: evs[i].dartIndex, scoreBefore: evs[i].scoreBefore,
        tempScore: evs[i].tempScore, keptScore: evs[i].keptScore, outcome: evs[i].outcome },
      { playerIdx, dartIndex, scoreBefore, tempScore, keptScore, outcome },
    );
  }
});

test('重放一致；篡改缓存分数后重放报告不一致且不修改历史', () => {
  const db = mem();
  const m = createMatch(db, { playerCount: 2, startScore: 501 });
  thr(db, m.matchId, 0, 1, 'l1', { ring: 'single', segment: 20 });
  const v1 = verifyMatch(db, m.matchId);
  assert.equal(v1.ok, true);
  db.prepare('UPDATE players SET score = 999 WHERE match_id = ? AND idx = 0').run(m.matchId);
  const v2 = verifyMatch(db, m.matchId);
  assert.equal(v2.ok, false);
  assert.deepEqual(v2.mismatchedPlayers, [0]);
  // 历史事件未被修改
  const evs = getEvents(db, m.matchId);
  assert.equal(evs[0].keptScore, 481);
});

test('重启接续: 重新打开数据库后回合起始分保留，爆分正确', () => {
  const path = `data/test-restart-${Date.now()}.db`;
  let db = openDb(path);
  const m = createMatch(db, { playerCount: 2, startScore: 32 });
  thr(db, m.matchId, 0, 1, 'm1', { ring: 'single', segment: 16 });
  db.close();
  db = openDb(path);
  const r = thr(db, m.matchId, 0, 1, 'm2', { ring: 'triple', segment: 6 });
  assert.equal(r.outcome, 'bust');
  assert.equal(r.roundStartScore, 32);
  assert.equal(r.keptScore, 32);
  db.close();
});

test('导出包含独立重放所需信息', () => {
  const db = mem();
  const m = createMatch(db, { playerCount: 2, startScore: 40 });
  thr(db, m.matchId, 0, 1, 'n1', { ring: 'single', segment: 20 });
  thr(db, m.matchId, 0, 1, 'n2', { ring: 'double', segment: 10 });
  const exp = exportMatch(db, m.matchId);
  assert.equal(exp.match.startScore, 40);
  assert.equal(exp.events.length, 2);
  assert.equal(exp.events[1].outcome, 'win');
  assert.ok(exp.events.every((e) => e.dart && e.roundStartScore !== undefined));
});

test('参数校验: 玩家数与起分范围', () => {
  const db = mem();
  assert.throws(() => createMatch(db, { playerCount: 1 }), (e: ApiError) => e.code === 'INVALID_PARAMS');
  assert.throws(() => createMatch(db, { playerCount: 9 }), (e: ApiError) => e.code === 'INVALID_PARAMS');
  assert.throws(() => createMatch(db, { playerCount: 2, startScore: 1 }), (e: ApiError) => e.code === 'INVALID_PARAMS');
  assert.throws(() => createMatch(db, { playerCount: 2, startScore: 502 }), (e: ApiError) => e.code === 'INVALID_PARAMS');
});

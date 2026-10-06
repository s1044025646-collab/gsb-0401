import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { GameService } from '../service.js';
import { resolveDart, evaluateThrow } from '../rules.js';
import { AppError } from '../types.js';
import { replayEvents } from '../replay.js';

function tempDb(name: string): string {
  const p = join(tmpdir(), `darts-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}.db`);
  rmSync(p, { force: true });
  return p;
}

function svc(db: string): { store: Store; game: GameService } {
  const store = new Store(db);
  return { store, game: new GameService(store) };
}

function throwDart(
  game: GameService,
  gid: number,
  id: string,
  p: number,
  turn: number,
  s: number,
  m: number,
): Record<string, unknown> {
  const out = game.throwDart(gid, {
    requestId: id,
    playerIndex: p,
    turnId: turn,
    dart: { section: s, multiplier: m },
  });
  return out.result as Record<string, unknown>;
}

test('resolveDart 校验非法组合', () => {
  assert.equal(resolveDart({ section: 20, multiplier: 3 }).value, 60);
  assert.equal(resolveDart({ section: 25, multiplier: 2 }).value, 50);
  assert.equal(resolveDart({ section: 25, multiplier: 2 }).isDouble, true);
  assert.equal(resolveDart({ section: 25, multiplier: 1 }).isDouble, false);
  assert.equal(resolveDart({ section: 0, multiplier: 1 }).value, 0);
  assert.throws(() => resolveDart({ section: 25, multiplier: 3 }), AppError);
  assert.throws(() => resolveDart({ section: 21, multiplier: 1 }), AppError);
  assert.throws(() => resolveDart({ section: 20, multiplier: 4 }), AppError);
});

test('evaluateThrow 双倍/爆分判定', () => {
  const dbl = resolveDart({ section: 10, multiplier: 2 });
  assert.equal(evaluateThrow(20, 20, dbl).won, true);
  const single = resolveDart({ section: 20, multiplier: 1 });
  assert.equal(evaluateThrow(20, 20, single).bustReason, 'NOT_DOUBLE');
  const big = resolveDart({ section: 20, multiplier: 3 });
  assert.equal(evaluateThrow(50, 50, big).bustReason, 'BELOW_ZERO');
  const one = resolveDart({ section: 1, multiplier: 1 });
  assert.equal(evaluateThrow(2, 2, one).bustReason, 'LEFT_ONE');
});

test('起分32: 单16后三倍6爆分，恢复32并换人', () => {
  const { store, game } = svc(tempDb('bust'));
  const gid = game.createGame({ startScore: 32, players: ['甲', '乙'] }).gameId;
  const r1 = throwDart(game, gid, '1', 0, 1, 16, 1);
  assert.equal(r1.tempScore, 16);
  assert.equal(r1.finalScore, 16);
  assert.equal(r1.turnEnded, false);
  const r2 = throwDart(game, gid, '2', 0, 1, 6, 3);
  assert.equal(r2.tempScore, -2);
  assert.equal(r2.busted, true);
  assert.equal(r2.bustReason, 'BELOW_ZERO');
  assert.equal(r2.turnStartScore, 32);
  assert.equal(r2.finalScore, 32); // 整回合回滚
  assert.equal(r2.nextPlayerIndex, 1);
  assert.equal(r2.nextTurnId, 2);
  const st = game.status(gid);
  assert.equal(st.players[0].score, 32);
  assert.equal(st.game.current_player, 1);
  assert.equal(st.game.turn_start_score, 32);
  store.close();
});

test('起分40: 单20后双10双倍获胜，赛后拒绝', () => {
  const { store, game } = svc(tempDb('win'));
  const gid = game.createGame({ startScore: 40 }).gameId;
  throwDart(game, gid, '1', 0, 1, 20, 1);
  const win = throwDart(game, gid, '2', 0, 1, 10, 2);
  assert.equal(win.won, true);
  assert.equal(win.finalScore, 0);
  assert.throws(
    () => throwDart(game, gid, '3', 0, 1, 1, 1),
    (e: AppError) => e.code === 'GAME_FINISHED',
  );
  store.close();
});

test('剩2时单一爆分(LEFT_ONE)', () => {
  const { store, game } = svc(tempDb('leftone'));
  const gid = game.createGame({ startScore: 5, players: ['A', 'B'] }).gameId;
  throwDart(game, gid, '1', 0, 1, 1, 3); // 5-3=2
  const r = throwDart(game, gid, '2', 0, 1, 1, 1); // 2-1=1 爆分
  assert.equal(r.bustReason, 'LEFT_ONE');
  assert.equal(r.finalScore, 5);
  store.close();
});

test('单牛眼不能结束，双牛眼可以结束', () => {
  const { store, game } = svc(tempDb('bull'));
  const gid = game.createGame({ startScore: 25, players: ['A', 'B'] }).gameId;
  const r = throwDart(game, gid, '1', 0, 1, 25, 1);
  assert.equal(r.busted, true);
  assert.equal(r.bustReason, 'NOT_DOUBLE');
  assert.equal(r.finalScore, 25);
  store.close();

  const s2 = svc(tempDb('bull2'));
  const gid2 = s2.game.createGame({ startScore: 50 }).gameId;
  const win = throwDart(s2.game, gid2, '1', 0, 1, 25, 2);
  assert.equal(win.won, true);
  s2.store.close();
});

test('脱靶占镖，三镖自动换人', () => {
  const { store, game } = svc(tempDb('miss'));
  const gid = game.createGame({ startScore: 100, players: ['A', 'B'] }).gameId;
  const m = throwDart(game, gid, '1', 0, 1, 0, 1);
  assert.equal(m.dartValue, 0);
  assert.equal(m.tempScore, 100);
  assert.equal(m.dartInTurn, 1);
  throwDart(game, gid, '2', 0, 1, 5, 1); // 95
  const third = throwDart(game, gid, '3', 0, 1, 5, 1); // 90 三镖用完
  assert.equal(third.turnEnded, true);
  assert.equal(third.nextPlayerIndex, 1);
  // 第四镖必须属于新玩家新回合
  assert.throws(
    () => throwDart(game, gid, '4', 0, 2, 1, 1),
    (e: AppError) => e.code === 'NOT_YOUR_TURN',
  );
  const ok = throwDart(game, gid, '4', 1, 2, 1, 1);
  assert.equal(ok.scoreBefore, 100);
  store.close();
});

test('错误玩家与陈旧回合拒绝', () => {
  const { store, game } = svc(tempDb('turn'));
  const gid = game.createGame({ startScore: 100, players: ['A', 'B'] }).gameId;
  assert.throws(
    () => throwDart(game, gid, '1', 1, 1, 1, 1),
    (e: AppError) => e.code === 'NOT_YOUR_TURN',
  );
  assert.throws(
    () => throwDart(game, gid, '2', 0, 99, 1, 1),
    (e: AppError) => e.code === 'STALE_TURN',
  );
  assert.throws(
    () => throwDart(game, gid, '3', 7, 1, 1, 1),
    (e: AppError) => e.code === 'INVALID_PLAYER',
  );
  store.close();
});

test('幂等: 同 requestId 同载荷返回原结果不重复扣分; 不同载荷拒绝', () => {
  const { store, game } = svc(tempDb('idem'));
  const gid = game.createGame({ startScore: 100 }).gameId;
  const a = throwDart(game, gid, 'dup', 0, 1, 20, 3);
  const b = game.throwDart(gid, {
    requestId: 'dup',
    playerIndex: 0,
    turnId: 1,
    dart: { section: 20, multiplier: 3 },
  });
  assert.equal(b.duplicate, true);
  assert.deepEqual(b.result, a);
  const st = game.status(gid);
  assert.equal(st.players[0].score, 40); // 只扣一次
  assert.throws(
    () =>
      game.throwDart(gid, {
        requestId: 'dup',
        playerIndex: 0,
        turnId: 1,
        dart: { section: 19, multiplier: 3 },
      }),
    (e: AppError) => e.code === 'REQUEST_CONFLICT',
  );
  store.close();
});

test('事件表逐步核对余额与玩家（手写序列）', () => {
  const { store, game } = svc(tempDb('table'));
  const gid = game.createGame({ startScore: 32, players: ['甲', '乙'] }).gameId;
  throwDart(game, gid, '1', 0, 1, 16, 1);
  throwDart(game, gid, '2', 0, 1, 6, 3); // 爆分回滚, 换乙
  throwDart(game, gid, '3', 1, 2, 16, 2); // 乙 32-32=0 双16获胜

  const events = store.getEvents(gid);
  assert.equal(events.length, 3);
  const e = events.map((x) => ({
    p: x.player_index,
    turn: x.turn_id,
    n: x.dart_in_turn,
    before: x.score_before,
    temp: x.temp_score,
    kept: x.final_score,
    bust: x.busted === 1,
    won: x.won === 1,
  }));
  assert.deepEqual(e, [
    { p: 0, turn: 1, n: 1, before: 32, temp: 16, kept: 16, bust: false, won: false },
    { p: 0, turn: 1, n: 2, before: 16, temp: -2, kept: 32, bust: true, won: false },
    { p: 1, turn: 2, n: 1, before: 32, temp: 0, kept: 0, bust: false, won: true },
  ]);

  // 独立重放与缓存一致
  const report = game.verify(gid);
  assert.equal(report.ok, true);
  assert.deepEqual(report.state.scores, [32, 0]);
  assert.equal(report.state.winner, 1);
  store.close();
});

test('纯事件重放：篡改缓存分数应被报告', () => {
  const { store, game } = svc(tempDb('tamper'));
  const gid = game.createGame({ startScore: 100 }).gameId;
  throwDart(game, gid, '1', 0, 1, 20, 3);
  // 人为破坏缓存，不改正历史
  store.db.prepare('UPDATE scores SET score = 7 WHERE game_id = ?').run(gid);
  assert.throws(
    () => game.verify(gid),
    (e: AppError) => e.code === 'REPLAY_MISMATCH',
  );
  // 历史事件未被修改
  const ev = store.getEvents(gid);
  assert.equal(ev[0].final_score, 40);
  store.close();
});

test('重启接续：重新打开数据库后继续未结束回合', () => {
  const db = tempDb('restart');
  let s = svc(db);
  const gid = s.game.createGame({ startScore: 100, players: ['A', 'B'] }).gameId;
  throwDart(s.game, gid, '1', 0, 1, 20, 3); // 剩40, 本回合第1镖
  s.store.close();

  s = svc(db); // 重启
  const st = s.game.status(gid);
  assert.equal(st.game.current_player, 0);
  assert.equal(st.game.darts_in_turn, 1);
  assert.equal(st.players[0].score, 40);
  // 继续第2镖
  const r = throwDart(s.game, gid, '2', 0, 1, 20, 1); // 40-20=20
  assert.equal(r.scoreBefore, 40);
  assert.equal(r.finalScore, 20);
  s.store.close();
});

test('建局参数边界', () => {
  const { store, game } = svc(tempDb('cfg'));
  assert.throws(() => game.createGame({ startScore: 1 }), (e: AppError) => e.code === 'INVALID_START_SCORE');
  assert.throws(() => game.createGame({ startScore: 502 }), (e: AppError) => e.code === 'INVALID_START_SCORE');
  assert.throws(
    () => game.createGame({ players: ['仅一人'] }),
    (e: AppError) => e.code === 'INVALID_PLAYERS',
  );
  assert.throws(
    () => game.createGame({ players: Array(9).fill('x') }),
    (e: AppError) => e.code === 'INVALID_PLAYERS',
  );
  const ok = game.createGame({ startScore: 2, players: ['a', 'b'] });
  assert.equal(ok.startScore, 2);
  store.close();
});

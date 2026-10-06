import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ApiError, MAX_EVENTS_PER_MATCH, dartValue, describeDart, isDouble, validateCreateParams, validateDart,
} from './domain.ts';
import type { Dart } from './domain.ts';

interface MatchRow {
  id: number; player_count: number; start_score: number; status: string;
  current_player: number; current_round: number; winner: number | null;
}
interface PlayerRow { idx: number; name: string; score: number; round_start_score: number }

function getMatch(db: DatabaseSync, matchId: number): MatchRow {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as MatchRow | undefined;
  if (!m) throw new ApiError('MATCH_NOT_FOUND', `比赛 ${matchId} 不存在`, 404);
  return m;
}

function getPlayers(db: DatabaseSync, matchId: number): PlayerRow[] {
  return db.prepare('SELECT idx, name, score, round_start_score FROM players WHERE match_id = ? ORDER BY idx')
    .all(matchId) as unknown as PlayerRow[];
}

export function createMatch(db: DatabaseSync, body: unknown) {
  const { playerCount, startScore, playerNames } = validateCreateParams(body);
  db.exec('BEGIN');
  try {
    const r = db.prepare('INSERT INTO matches (player_count, start_score) VALUES (?, ?)')
      .run(playerCount, startScore);
    const id = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO players (match_id, idx, name, score, round_start_score) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < playerCount; i++) ins.run(id, i, playerNames[i], startScore, startScore);
    db.exec('COMMIT');
    return getState(db, id);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface ThrowResult {
  matchId: number;
  seq: number;
  round: number;
  playerIdx: number;
  playerName: string;
  dartIndex: number;
  dart: Dart;
  dartDescription: string;
  dartValue: number;
  scoreBefore: number;
  roundStartScore: number;
  tempScore: number;
  outcome: 'continue' | 'turn_complete' | 'bust' | 'win';
  bustReason: string | null;
  keptScore: number;
  nextPlayer: number | null;
  nextRound: number | null;
  matchStatus: string;
  winner: number | null;
  idempotentReplay: boolean;
}

function computeThrow(m: MatchRow, players: PlayerRow[], dart: Dart, dartIndex: number,
  priorDarts: Dart[]): Omit<ThrowResult, 'matchId' | 'seq' | 'idempotentReplay'> {
  const p = players[m.current_player];
  const roundStart = p.round_start_score;
  const thrown = priorDarts.reduce((s, d) => s + dartValue(d), 0) + dartValue(dart);
  const temp = roundStart - thrown;

  let outcome: ThrowResult['outcome'] = 'continue';
  let bustReason: string | null = null;
  let keptScore = temp;
  let matchStatus = m.status;
  let winner: number | null = null;
  let roundOver = false;

  if (temp < 0) {
    outcome = 'bust'; bustReason = `扣分后为 ${temp}，低于零`;
  } else if (temp === 1) {
    outcome = 'bust'; bustReason = '扣分后恰好剩 1，无法用双倍结束';
  } else if (temp === 0) {
    if (isDouble(dart)) {
      outcome = 'win'; matchStatus = 'finished'; winner = m.current_player;
    } else {
      outcome = 'bust'; bustReason = '到零但最后一镖不是双倍区';
    }
  } else if (dartIndex === 3) {
    outcome = 'turn_complete';
  }

  if (outcome === 'bust') {
    keptScore = roundStart;
    roundOver = true;
  } else if (outcome === 'win' || outcome === 'turn_complete') {
    roundOver = true;
  }

  let nextPlayer: number | null = null;
  let nextRound: number | null = null;
  if (roundOver && matchStatus === 'active') {
    nextPlayer = (m.current_player + 1) % m.player_count;
    nextRound = nextPlayer === 0 ? m.current_round + 1 : m.current_round;
  }

  return {
    round: m.current_round,
    playerIdx: m.current_player,
    playerName: p.name,
    dartIndex,
    dart,
    dartDescription: describeDart(dart),
    dartValue: dartValue(dart),
    scoreBefore: temp + dartValue(dart),
    roundStartScore: roundStart,
    tempScore: temp,
    outcome,
    bustReason,
    keptScore,
    nextPlayer,
    nextRound,
    matchStatus,
    winner,
  };
}

export function recordThrow(db: DatabaseSync, matchId: number, body: unknown): ThrowResult {
  if (typeof body !== 'object' || body === null) throw new ApiError('INVALID_PARAMS', '请求体必须是对象');
  const b = body as Record<string, unknown>;
  const requestId = b.requestId;
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 64) {
    throw new ApiError('INVALID_PARAMS', 'requestId 必须是 1-64 字符的字符串');
  }
  const playerIdx = b.playerIdx;
  if (typeof playerIdx !== 'number' || !Number.isInteger(playerIdx)) {
    throw new ApiError('INVALID_PARAMS', 'playerIdx 必须是整数');
  }
  const round = b.round;
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 1) {
    throw new ApiError('INVALID_PARAMS', 'round 必须是正整数');
  }
  const dart = validateDart(b.dart);

  const payloadHash = createHash('sha256')
    .update(JSON.stringify({ playerIdx, round, dart })).digest('hex');

  db.exec('BEGIN IMMEDIATE');
  try {
    const m = getMatch(db, matchId);

    const existing = db.prepare('SELECT result_json, dart_json FROM events WHERE match_id = ? AND request_id = ?')
      .get(matchId, requestId) as { result_json: string; dart_json: string } | undefined;
    if (existing) {
      const stored = JSON.parse(existing.result_json) as ThrowResult & { payloadHash: string };
      if (stored.payloadHash !== payloadHash) {
        throw new ApiError('REQUEST_CONFLICT', `请求编号 ${requestId} 已用于不同载荷`, 409);
      }
      db.exec('COMMIT');
      const { payloadHash: _ph, ...result } = stored;
      return { ...result, idempotentReplay: true };
    }

    if (m.status !== 'active') {
      throw new ApiError('MATCH_FINISHED', '比赛已结束，拒绝后续投镖', 409);
    }
    if (playerIdx !== m.current_player) {
      throw new ApiError('WRONG_PLAYER', `当前应由玩家 ${m.current_player} 投掷，收到 ${playerIdx}`, 409);
    }
    if (round !== m.current_round) {
      throw new ApiError('STALE_ROUND', `当前回合为 ${m.current_round}，收到 ${round}`, 409);
    }

    const eventCount = (db.prepare('SELECT COUNT(*) AS c FROM events WHERE match_id = ?')
      .get(matchId) as { c: number }).c;
    if (eventCount >= MAX_EVENTS_PER_MATCH) {
      throw new ApiError('LIMIT_EXCEEDED', `比赛事件数超过上限 ${MAX_EVENTS_PER_MATCH}`, 409);
    }

    const roundEvents = db.prepare(
      'SELECT dart_json FROM events WHERE match_id = ? AND round = ? AND player_idx = ? ORDER BY dart_index',
    ).all(matchId, m.current_round, m.current_player) as { dart_json: string }[];
    if (roundEvents.length >= 3) {
      throw new ApiError('ROUND_COMPLETE', '本回合三镖已用完', 409);
    }
    const priorDarts = roundEvents.map((r) => JSON.parse(r.dart_json) as Dart);
    const dartIndex = roundEvents.length + 1;

    const players = getPlayers(db, matchId);
    const partial = computeThrow(m, players, dart, dartIndex, priorDarts);
    const seq = eventCount + 1;
    const result: ThrowResult & { payloadHash?: string } = {
      ...partial, matchId, seq, idempotentReplay: false, payloadHash,
    };

    db.prepare(
      `INSERT INTO events (match_id, seq, round, player_idx, dart_index, request_id, dart_json, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(matchId, seq, m.current_round, m.current_player, dartIndex, requestId,
      JSON.stringify(dart), JSON.stringify(result));

    const roundOver = partial.outcome !== 'continue';
    if (roundOver) {
      db.prepare('UPDATE players SET score = ?, round_start_score = ? WHERE match_id = ? AND idx = ?')
        .run(partial.keptScore, partial.keptScore, matchId, m.current_player);
    } else {
      db.prepare('UPDATE players SET score = ? WHERE match_id = ? AND idx = ?')
        .run(partial.keptScore, matchId, m.current_player);
    }

    if (partial.matchStatus === 'finished') {
      db.prepare("UPDATE matches SET status = 'finished', winner = ? WHERE id = ?")
        .run(partial.winner, matchId);
    } else if (partial.nextPlayer !== null) {
      db.prepare('UPDATE matches SET current_player = ?, current_round = ? WHERE id = ?')
        .run(partial.nextPlayer, partial.nextRound, matchId);
    }

    db.exec('COMMIT');
    const { payloadHash: _ph, ...out } = result;
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getState(db: DatabaseSync, matchId: number) {
  const m = getMatch(db, matchId);
  const players = getPlayers(db, matchId);
  const dartsTurnCount = m.status === 'active'
    ? (db.prepare(
        'SELECT dart_json FROM events WHERE match_id = ? AND round = ? AND player_idx = ? ORDER BY dart_index',
      ).all(matchId, m.current_round, m.current_player) as { dart_json: string }[])
        .map((r) => JSON.parse(r.dart_json) as Dart)
    : [];
  return {
    matchId: m.id,
    status: m.status,
    startScore: m.start_score,
    playerCount: m.player_count,
    currentPlayer: m.status === 'active' ? m.current_player : null,
    currentRound: m.current_round,
    winner: m.winner,
    players: players.map((p) => ({
      idx: p.idx, name: p.name, score: p.score, roundStartScore: p.round_start_score,
    })),
    currentTurn: m.status === 'active' ? {
      playerIdx: m.current_player,
      round: m.current_round,
      dartsThrown: dartsTurnCount,
      dartsRemaining: 3 - dartsTurnCount.length,
    } : null,
  };
}

export function getEvents(db: DatabaseSync, matchId: number) {
  getMatch(db, matchId);
  const rows = db.prepare('SELECT result_json FROM events WHERE match_id = ? ORDER BY seq')
    .all(matchId) as { result_json: string }[];
  return rows.map((r) => {
    const { payloadHash: _ph, ...rest } = JSON.parse(r.result_json);
    return rest as ThrowResult;
  });
}

export function exportMatch(db: DatabaseSync, matchId: number) {
  const m = getMatch(db, matchId);
  const players = getPlayers(db, matchId);
  return {
    version: 1,
    match: {
      id: m.id,
      playerCount: m.player_count,
      startScore: m.start_score,
      status: m.status,
      winner: m.winner,
      players: players.map((p) => ({ idx: p.idx, name: p.name })),
    },
    events: getEvents(db, matchId),
  };
}

export function verifyMatch(db: DatabaseSync, matchId: number) {
  const exp = exportMatch(db, matchId);
  const m = getMatch(db, matchId);
  const players = getPlayers(db, matchId);
  const scores = players.map(() => m.start_score);
  const problems: string[] = [];

  let expectedPlayer = 0;
  let expectedRound = 1;
  let dartsTurnCount = 0;
  let roundStart = m.start_score;
  let status = 'active';

  for (const ev of exp.events) {
    if (status !== 'active') {
      problems.push(`事件 ${ev.seq}: 比赛已结束仍存在后续事件`);
      break;
    }
    if (ev.playerIdx !== expectedPlayer || ev.round !== expectedRound) {
      problems.push(`事件 ${ev.seq}: 期望玩家 ${expectedPlayer} 回合 ${expectedRound}，实际玩家 ${ev.playerIdx} 回合 ${ev.round}`);
      break;
    }
    dartsTurnCount += 1;
    // 独立重算：仅用本回合已累计的镖值，不信任事件内缓存字段
    if (ev.roundStartScore !== roundStart) {
      problems.push(`事件 ${ev.seq}: 回合起始分不符，重算 ${roundStart}，记录 ${ev.roundStartScore}`);
    }
    const priorThrown = roundStart - ev.scoreBefore;
    const t = roundStart - priorThrown - dartValue(ev.dart);
    if (t !== ev.tempScore) {
      problems.push(`事件 ${ev.seq}: 临时余额不符，重算 ${t}，记录 ${ev.tempScore}`);
    }
    let outcome: string = 'continue';
    if (t < 0) outcome = 'bust';
    else if (t === 1) outcome = 'bust';
    else if (t === 0) outcome = isDouble(ev.dart) ? 'win' : 'bust';
    else if (dartsTurnCount === 3) outcome = 'turn_complete';
    if (outcome !== ev.outcome) {
      problems.push(`事件 ${ev.seq}: 结果不符，重算 ${outcome}，记录 ${ev.outcome}`);
    }
    const kept = outcome === 'bust' ? roundStart : t;
    if (kept !== ev.keptScore) {
      problems.push(`事件 ${ev.seq}: 保留分不符，重算 ${kept}，记录 ${ev.keptScore}`);
    }
    scores[ev.playerIdx] = kept;
    if (outcome === 'win') {
      status = 'finished';
    } else if (outcome === 'bust' || outcome === 'turn_complete') {
      dartsTurnCount = 0;
      expectedPlayer = (expectedPlayer + 1) % m.player_count;
      if (expectedPlayer === 0) expectedRound += 1;
      roundStart = scores[expectedPlayer];
    }
  }

  const mismatch: number[] = [];
  players.forEach((p, i) => {
    if (p.score !== scores[i]) mismatch.push(i);
  });
  const ok = problems.length === 0 && mismatch.length === 0;
  return {
    ok,
    problems,
    replayedScores: scores,
    cachedScores: players.map((p) => p.score),
    mismatchedPlayers: mismatch,
    message: ok
      ? '重放一致：事件序列重算结果与当前缓存分数相符'
      : '重放不一致：事件重算结果与缓存分数存在差异（未修改历史数据）',
  };
}

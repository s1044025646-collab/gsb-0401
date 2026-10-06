// SQLite 存储：比赛配置、逐镖事件、状态缓存、请求幂等

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError, type DartSpec } from './types.js';

export interface GameRow {
  id: number;
  start_score: number;
  player_count: number;
  names_json: string;
  current_player: number;
  current_turn: number;
  turn_start_score: number;
  darts_in_turn: number;
  winner: number | null;
  created_at: string;
}

export interface EventRow {
  id: number;
  game_id: number;
  event_type: 'THROW';
  request_id: string;
  player_index: number;
  turn_id: number;
  dart_in_turn: number;
  section: number;
  multiplier: number;
  dart_value: number;
  score_before: number;
  temp_score: number;
  turn_start_score: number;
  final_score: number;
  busted: number;
  bust_reason: string | null;
  won: number;
  turn_ended: number;
  next_player: number | null;
  next_turn: number | null;
  created_at: string;
}

interface RequestRow {
  request_id: string;
  game_id: number;
  payload_hash: string;
  event_id: number | null;
  response_json: string;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_score INTEGER NOT NULL,
  player_count INTEGER NOT NULL,
  names_json TEXT NOT NULL,
  current_player INTEGER NOT NULL,
  current_turn INTEGER NOT NULL,
  turn_start_score INTEGER NOT NULL,
  darts_in_turn INTEGER NOT NULL,
  winner INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id),
  event_type TEXT NOT NULL,
  request_id TEXT NOT NULL,
  player_index INTEGER NOT NULL,
  turn_id INTEGER NOT NULL,
  dart_in_turn INTEGER NOT NULL,
  section INTEGER NOT NULL,
  multiplier INTEGER NOT NULL,
  dart_value INTEGER NOT NULL,
  score_before INTEGER NOT NULL,
  temp_score INTEGER NOT NULL,
  turn_start_score INTEGER NOT NULL,
  final_score INTEGER NOT NULL,
  busted INTEGER NOT NULL,
  bust_reason TEXT,
  won INTEGER NOT NULL,
  turn_ended INTEGER NOT NULL,
  next_player INTEGER,
  next_turn INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY,
  game_id INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  event_id INTEGER,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS scores (
  game_id INTEGER NOT NULL REFERENCES games(id),
  player_index INTEGER NOT NULL,
  score INTEGER NOT NULL,
  PRIMARY KEY (game_id, player_index)
);
CREATE INDEX IF NOT EXISTS idx_events_game ON events(game_id, id);
`;

export function createHash(payload: unknown): string {
  // 稳定序列化后做 FNV-1a，无需外部依赖
  const json = stableStringify(payload);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + ':' + json.length;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export class Store {
  db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createGame(startScore: number, names: string[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO games (start_score, player_count, names_json, current_player,
        current_turn, turn_start_score, darts_in_turn, winner)
       VALUES (?, ?, ?, 0, 1, ?, 0, NULL)`,
    );
    const info = stmt.run(startScore, names.length, JSON.stringify(names), startScore);
    return Number(info.lastInsertRowid);
  }

  getGame(gameId: number): GameRow {
    const row = this.db.prepare('SELECT * FROM games WHERE id = ?').get(gameId) as GameRow | undefined;
    if (!row) throw new AppError('GAME_NOT_FOUND', `比赛 ${gameId} 不存在`, 404);
    return row;
  }

  getEvents(gameId: number): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE game_id = ? ORDER BY id')
      .all(gameId) as unknown as EventRow[];
  }

  getRequest(requestId: string): RequestRow | undefined {
    return this.db.prepare('SELECT * FROM requests WHERE request_id = ?').get(requestId) as
      | RequestRow
      | undefined;
  }

  // 投镖事务：幂等检查、规则判定、写事件、更新状态在同一事务内完成。
  // 返回 { result, duplicate }。
  throwTransaction(params: {
    gameId: number;
    requestId: string;
    playerIndex: number;
    turnId: number;
    dart: DartSpec;
    value: number;
    isDouble: boolean;
    payloadHash: string;
  }): { response: unknown; duplicate: boolean } {
    const { db } = this;
    const {
      gameId,
      requestId,
      playerIndex,
      turnId,
      dart,
      value,
      isDouble,
      payloadHash,
    } = params;

    db.exec('BEGIN IMMEDIATE');
    try {
      // 1) 幂等：相同 requestId 已处理
      const existing = this.getRequest(requestId);
      if (existing) {
        if (existing.game_id !== gameId || existing.payload_hash !== payloadHash) {
          throw new AppError(
            'REQUEST_CONFLICT',
            '相同 requestId 携带了不同的比赛或载荷，已拒绝',
            409,
          );
        }
        db.exec('COMMIT');
        return { response: JSON.parse(existing.response_json), duplicate: true };
      }

      // 2) 锁定并读取比赛当前状态
      const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId) as GameRow | undefined;
      if (!game) throw new AppError('GAME_NOT_FOUND', `比赛 ${gameId} 不存在`, 404);

      // 3) 状态与归属校验（参数错误，并非爆分）
      if (game.winner !== null) {
        throw new AppError('GAME_FINISHED', `比赛已由玩家 ${game.winner} 获胜，拒绝任何投镖`, 409);
      }
      if (playerIndex < 0 || playerIndex >= game.player_count) {
        throw new AppError('INVALID_PLAYER', `玩家编号必须在 0..${game.player_count - 1}`);
      }
      if (playerIndex !== game.current_player) {
        throw new AppError(
          'NOT_YOUR_TURN',
          `当前轮到玩家 ${game.current_player}，不是玩家 ${playerIndex}`,
          409,
        );
      }
      if (turnId !== game.current_turn) {
        throw new AppError(
          'STALE_TURN',
          `当前回合为 ${game.current_turn}，请求回合 ${turnId} 已过期`,
          409,
        );
      }

      // 4) 规则判定
      const dartInTurn = game.darts_in_turn + 1;
      const scoreBefore =
        dartInTurn === 1 ? game.turn_start_score : this.currentScore(gameId, playerIndex);
      const tempScore = scoreBefore - value;

      let busted = false;
      let bustReason: string | null = null;
      let won = false;
      let finalScore: number;

      if (tempScore < 0) {
        busted = true;
        bustReason = 'BELOW_ZERO';
        finalScore = game.turn_start_score;
      } else if (tempScore === 1) {
        busted = true;
        bustReason = 'LEFT_ONE';
        finalScore = game.turn_start_score;
      } else if (tempScore === 0) {
        if (isDouble) {
          won = true;
          finalScore = 0;
        } else {
          busted = true;
          bustReason = 'NOT_DOUBLE';
          finalScore = game.turn_start_score;
        }
      } else {
        finalScore = tempScore;
      }

      const turnEnded = won || busted || dartInTurn === 3;
      let nextPlayer: number | null = null;
      let nextTurn: number | null = null;

      if (turnEnded && !won) {
        nextPlayer = (playerIndex + 1) % game.player_count;
        nextTurn = game.current_turn + 1;
      }

      // 5) 写事件
      const ev = db
        .prepare(
          `INSERT INTO events (game_id, event_type, request_id, player_index, turn_id,
            dart_in_turn, section, multiplier, dart_value, score_before, temp_score,
            turn_start_score, final_score, busted, bust_reason, won, turn_ended,
            next_player, next_turn)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          gameId,
          'THROW',
          requestId,
          playerIndex,
          turnId,
          dartInTurn,
          dart.section,
          dart.multiplier,
          value,
          scoreBefore,
          tempScore,
          game.turn_start_score,
          finalScore,
          busted ? 1 : 0,
          bustReason,
          won ? 1 : 0,
          turnEnded ? 1 : 0,
          nextPlayer,
          nextTurn,
        );
      const eventId = Number(ev.lastInsertRowid);

      // 6) 更新缓存分数（scores 表通过事件回放推导，这里直接持久化玩家分数）
      db.prepare(
        'INSERT OR REPLACE INTO scores (game_id, player_index, score) VALUES (?,?,?)',
      ).run(gameId, playerIndex, finalScore);

      // 7) 更新比赛状态
      if (won) {
        db.prepare(
          'UPDATE games SET darts_in_turn = ?, winner = ? WHERE id = ?',
        ).run(dartInTurn, playerIndex, gameId);
      } else if (turnEnded) {
        const ns = this.scoreOf(gameId, nextPlayer as number, game.start_score);
        db.prepare(
          `UPDATE games SET current_player = ?, current_turn = ?, turn_start_score = ?,
            darts_in_turn = 0 WHERE id = ?`,
        ).run(nextPlayer, nextTurn, ns, gameId);
      } else {
        db.prepare('UPDATE games SET darts_in_turn = ? WHERE id = ?').run(dartInTurn, gameId);
      }

      const response = {
        requestId,
        eventId,
        gameId,
        playerIndex,
        turnId,
        dartInTurn,
        section: dart.section,
        multiplier: dart.multiplier,
        dartValue: value,
        scoreBefore,
        tempScore,
        turnStartScore: game.turn_start_score,
        finalScore,
        busted,
        bustReason,
        won,
        turnEnded,
        nextPlayerIndex: nextPlayer,
        nextTurnId: nextTurn,
      };

      db.prepare(
        'INSERT INTO requests (request_id, game_id, payload_hash, event_id, response_json) VALUES (?,?,?,?,?)',
      ).run(requestId, gameId, payloadHash, eventId, JSON.stringify(response));

      db.exec('COMMIT');
      return { response, duplicate: false };
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }

  private currentScore(gameId: number, playerIndex: number): number {
    const row = this.db
      .prepare('SELECT score FROM scores WHERE game_id = ? AND player_index = ?')
      .get(gameId, playerIndex) as { score: number } | undefined;
    if (!row) return this.getGame(gameId).start_score;
    return row.score;
  }

  private scoreOf(gameId: number, playerIndex: number, fallback: number): number {
    const row = this.db
      .prepare('SELECT score FROM scores WHERE game_id = ? AND player_index = ?')
      .get(gameId, playerIndex) as { score: number } | undefined;
    return row ? row.score : fallback;
  }

  playerScores(gameId: number): number[] {
    const game = this.getGame(gameId);
    const rows = this.db
      .prepare('SELECT player_index, score FROM scores WHERE game_id = ?')
      .all(gameId) as { player_index: number; score: number }[];
    const map = new Map(rows.map((r) => [r.player_index, r.score]));
    return Array.from({ length: game.player_count }, (_, i) =>
      map.has(i) ? (map.get(i) as number) : game.start_score,
    );
  }
}

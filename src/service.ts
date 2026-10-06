// 应用服务：参数校验 + 调用存储事务

import {
  AppError,
  MAX_BODY_BYTES,
  MAX_PLAYERS,
  MAX_START_SCORE,
  MIN_PLAYERS,
  MIN_START_SCORE,
  type PlayerView,
} from './types.js';
import { resolveDart } from './rules.js';
import { createHash, Store, type EventRow, type GameRow } from './store.js';
import { replayEvents, verifyGame } from './replay.js';

export interface CreateGameInput {
  startScore?: number;
  players?: string[];
}

export class GameService {
  constructor(public store: Store) {}

  createGame(input: CreateGameInput): { gameId: number; playerCount: number; startScore: number; names: string[] } {
    const startScore = input.startScore ?? 501;
    if (
      typeof startScore !== 'number' ||
      !Number.isInteger(startScore) ||
      startScore < MIN_START_SCORE ||
      startScore > MAX_START_SCORE
    ) {
      throw new AppError(
        'INVALID_START_SCORE',
        `起分必须是 ${MIN_START_SCORE}..${MAX_START_SCORE} 的整数（直接起分，双倍结束）`,
      );
    }

    let names = input.players;
    if (names === undefined) {
      names = ['玩家1', '玩家2'];
    }
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || n.trim() === '')) {
      throw new AppError('INVALID_PLAYERS', 'players 必须是非空字符串数组');
    }
    if (names.length < MIN_PLAYERS || names.length > MAX_PLAYERS) {
      throw new AppError('INVALID_PLAYERS', `玩家数必须在 ${MIN_PLAYERS}..${MAX_PLAYERS} 之间`);
    }
    const trimmed = names.map((n) => n.trim()).slice(0, MAX_PLAYERS);

    const gameId = this.store.createGame(startScore, trimmed);
    return { gameId, playerCount: trimmed.length, startScore, names: trimmed };
  }

  throwDart(gameId: number, body: Record<string, unknown>): { result: unknown; duplicate: boolean } {
    const requestId = body.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
      throw new AppError('INVALID_REQUEST_ID', 'requestId 必须是 1..128 字符的非空字符串');
    }
    const playerIndex = body.playerIndex;
    const turnId = body.turnId;
    if (typeof playerIndex !== 'number' || !Number.isInteger(playerIndex)) {
      throw new AppError('INVALID_PLAYER', 'playerIndex 必须是整数');
    }
    if (typeof turnId !== 'number' || !Number.isInteger(turnId) || turnId < 1) {
      throw new AppError('INVALID_TURN', 'turnId 必须是 >=1 的整数');
    }
    const resolved = resolveDart(body.dart);

    const payloadHash = createHash({ playerIndex, turnId, dart: resolved.spec });
    const out = this.store.throwTransaction({
      gameId,
      requestId,
      playerIndex,
      turnId,
      dart: resolved.spec,
      value: resolved.value,
      isDouble: resolved.isDouble,
      payloadHash,
    });

    const result = out.response as Record<string, unknown>;
    result.label = resolved.label;
    result.isDouble = resolved.isDouble;
    return { result: out.response, duplicate: out.duplicate };
  }

  status(gameId: number): {
    game: GameRow;
    names: string[];
    players: PlayerView[];
    events: EventRow[];
  } {
    const game = this.store.getGame(gameId);
    const names = JSON.parse(game.names_json) as string[];
    const scores = this.store.playerScores(gameId);
    const players: PlayerView[] = names.map((name, i) => ({
      playerIndex: i,
      name,
      score: scores[i],
      current: i === game.current_player && game.winner === null,
    }));
    return { game, names, players, events: this.store.getEvents(gameId) };
  }

  exportLog(gameId: number): {
    game: GameRow;
    names: string[];
    events: EventRow[];
  } {
    const game = this.store.getGame(gameId);
    return { game, names: JSON.parse(game.names_json), events: this.store.getEvents(gameId) };
  }

  verify(gameId: number): ReturnType<typeof verifyGame> {
    return verifyGame(this.store, gameId);
  }

  replayOnly(gameId: number): ReturnType<typeof replayEvents> {
    const game = this.store.getGame(gameId);
    return replayEvents(game, this.store.getEvents(gameId));
  }
}

export { MAX_BODY_BYTES };

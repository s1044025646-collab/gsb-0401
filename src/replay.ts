// 从逐镖事件独立重放，并与当前缓存分数核对

import type { EventRow, GameRow } from './store.js';
import type { Store } from './store.js';
import { AppError } from './types.js';

export interface ReplayState {
  scores: number[];
  currentPlayer: number;
  currentTurn: number;
  turnStartScore: number;
  dartsInTurn: number;
  winner: number | null;
}

export interface ReplayMismatch {
  eventId: number;
  field: string;
  expected: unknown;
  recorded: unknown;
}

export interface ReplayReport {
  ok: boolean;
  eventCount: number;
  state: ReplayState;
  mismatches: ReplayMismatch[];
}

// 纯事件重放：仅依赖事件序列，推导每位玩家每一步余额与当前回合。
export function replayEvents(game: GameRow, events: EventRow[]): ReplayReport {
  const scores = Array.from({ length: game.player_count }, () => game.start_score);
  let currentPlayer = 0;
  let currentTurn = 1;
  let turnStartScore = game.start_score;
  let dartsInTurn = 0;
  let winner: number | null = null;
  const mismatches: ReplayMismatch[] = [];

  const check = (
    ev: EventRow,
    field: string,
    expected: unknown,
    recorded: unknown,
  ): void => {
    if (JSON.stringify(expected) !== JSON.stringify(recorded)) {
      mismatches.push({ eventId: ev.id, field, expected, recorded });
    }
  };

  for (const ev of events) {
    // 事件归属必须与重放的当前玩家/回合一致
    check(ev, 'playerIndex', currentPlayer, ev.player_index);
    check(ev, 'turnId', currentTurn, ev.turn_id);
    check(ev, 'dartInTurn', dartsInTurn + 1, ev.dart_in_turn);
    check(ev, 'turnStartScore', turnStartScore, ev.turn_start_score);

    const scoreBefore = scores[ev.player_index];
    check(ev, 'scoreBefore', scoreBefore, ev.score_before);

    const temp = scoreBefore - ev.dart_value;
    check(ev, 'tempScore', temp, ev.temp_score);

    let busted = false;
    let bustReason: string | null = null;
    let won = false;
    let finalScore: number;

    if (temp < 0) {
      busted = true;
      bustReason = 'BELOW_ZERO';
      finalScore = turnStartScore;
    } else if (temp === 1) {
      busted = true;
      bustReason = 'LEFT_ONE';
      finalScore = turnStartScore;
    } else if (temp === 0) {
      const isDouble = ev.multiplier === 2;
      if (isDouble) {
        won = true;
        finalScore = 0;
      } else {
        busted = true;
        bustReason = 'NOT_DOUBLE';
        finalScore = turnStartScore;
      }
    } else {
      finalScore = temp;
    }

    check(ev, 'busted', busted, ev.busted === 1);
    check(ev, 'bustReason', bustReason, ev.bust_reason);
    check(ev, 'won', won, ev.won === 1);
    check(ev, 'finalScore', finalScore, ev.final_score);

    scores[ev.player_index] = finalScore;
    dartsInTurn = ev.dart_in_turn;

    const turnEnded = won || busted || dartsInTurn === 3;
    check(ev, 'turnEnded', turnEnded, ev.turn_ended === 1);

    if (won) {
      winner = ev.player_index;
    } else if (turnEnded) {
      currentPlayer = (currentPlayer + 1) % game.player_count;
      currentTurn += 1;
      turnStartScore = scores[currentPlayer];
      dartsInTurn = 0;
      check(ev, 'nextPlayer', currentPlayer, ev.next_player);
      check(ev, 'nextTurn', currentTurn, ev.next_turn);
    }
  }

  return {
    ok: mismatches.length === 0,
    eventCount: events.length,
    state: { scores, currentPlayer, currentTurn, turnStartScore, dartsInTurn, winner },
    mismatches,
  };
}

// 重放并与 games/scores 缓存核对；不符则报错，绝不修改历史。
export function verifyGame(store: Store, gameId: number): ReplayReport {
  const game = store.getGame(gameId);
  const events = store.getEvents(gameId);
  const report = replayEvents(game, events);

  const cached = store.playerScores(gameId);
  report.state.scores.forEach((s, i) => {
    if (s !== cached[i]) {
      report.mismatches.push({
        eventId: -1,
        field: `cachedScore[${i}]`,
        expected: s,
        recorded: cached[i],
      });
    }
  });

  if (report.state.currentPlayer !== game.current_player) {
    report.mismatches.push({
      eventId: -1,
      field: 'cachedCurrentPlayer',
      expected: report.state.currentPlayer,
      recorded: game.current_player,
    });
  }
  if (report.state.currentTurn !== game.current_turn) {
    report.mismatches.push({
      eventId: -1,
      field: 'cachedCurrentTurn',
      expected: report.state.currentTurn,
      recorded: game.current_turn,
    });
  }
  if ((report.state.winner ?? null) !== (game.winner ?? null)) {
    report.mismatches.push({
      eventId: -1,
      field: 'cachedWinner',
      expected: report.state.winner,
      recorded: game.winner,
    });
  }

  report.ok = report.mismatches.length === 0;
  if (!report.ok) {
    throw new AppError(
      'REPLAY_MISMATCH',
      `重放与缓存/历史不一致，共 ${report.mismatches.length} 处，历史保持不变`,
      409,
    );
  }
  return report;
}

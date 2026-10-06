#!/usr/bin/env node
// 命令行：create / throw / status / export / verify / replay

import { resolve } from 'node:path';
import { Store } from './store.js';
import { GameService } from './service.js';
import { BUST_REASON_TEXT } from './rules.js';
import { AppError } from './types.js';

function usage(): never {
  console.error(`飞镖 501 命令行

用法:
  darts501 create [--start=32] [--players=甲,乙]
  darts501 status <gameId>
  darts501 throw <gameId> <requestId> <playerIndex> <turnId> <section> <multiplier>
  darts501 export <gameId>
  darts501 verify <gameId>
  darts501 replay <gameId>

落点: section 为 1-20、25(牛眼)、0(脱靶); multiplier 为 1/2/3
数据库可用环境变量 DARTS_DB 指定，默认 ./data/darts.db
`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function printResult(result: Record<string, unknown>, duplicate: boolean): void {
  console.log(
    `${duplicate ? '[重复请求，返回原结果] ' : ''}事件#${result.eventId} 玩家${result.playerIndex} ` +
      `第${result.turnId}回合 第${result.dartInTurn}镖  ${result.label}`,
  );
  console.log(
    `  投前余额=${result.scoreBefore} 本镖=${result.dartValue} 临时余额=${result.tempScore} ` +
      `回合起始=${result.turnStartScore} 最终保留=${result.finalScore}`,
  );
  if (result.busted) {
    console.log(`  爆分! 原因=${result.bustReason}（${BUST_REASON_TEXT[result.bustReason as string]}），本回合得分回滚`);
  }
  if (result.won) console.log('  获胜! 以双倍区结束比赛');
  if (result.turnEnded && !result.won) {
    console.log(`  回合结束，轮到玩家${result.nextPlayerIndex}（第${result.nextTurnId}回合）`);
  }
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  const dbPath = process.env.DARTS_DB ? resolve(process.env.DARTS_DB) : resolve('data/darts.db');
  const store = new Store(dbPath);
  const service = new GameService(store);

  try {
    if (cmd === 'create') {
      const startScore = arg('start') ? Number(arg('start')) : undefined;
      const players = arg('players') ? (arg('players') as string).split(',') : undefined;
      const created = service.createGame({ startScore, players });
      console.log(`已建局 gameId=${created.gameId} 起分=${created.startScore} 玩家=${created.names.join(', ')}`);
      console.log(`数据库: ${dbPath}`);
    } else if (cmd === 'throw') {
      const [g, requestId, p, turn, section, mult] = rest;
      if (!g || !requestId || p === undefined || !turn || !section || !mult) usage();
      const { result, duplicate } = service.throwDart(Number(g), {
        requestId,
        playerIndex: Number(p),
        turnId: Number(turn),
        dart: { section: Number(section), multiplier: Number(mult) },
      });
      printResult(result as Record<string, unknown>, duplicate);
    } else if (cmd === 'status') {
      const s = service.status(Number(rest[0]));
      console.log(
        `比赛#${rest[0]} 起分=${s.game.start_score} 当前=玩家${s.game.current_player} ` +
          `第${s.game.current_turn}回合 本回合已投${s.game.darts_in_turn}镖 ` +
          `回合起始=${s.game.turn_start_score}`,
      );
      if (s.game.winner !== null) console.log(`胜者: 玩家${s.game.winner}`);
      for (const pl of s.players) {
        console.log(`  玩家${pl.playerIndex} ${pl.name}: ${pl.score}${pl.current ? '  <- 当前' : ''}`);
      }
    } else if (cmd === 'export' || cmd === 'replay') {
      const log = service.exportLog(Number(rest[0]));
      console.log(`比赛#${log.game.id} 起分=${log.game.start_score} 玩家=${log.names.join(',')}`);
      for (const e of log.events) {
        const tag = e.won ? '获胜' : e.busted ? `爆分:${BUST_REASON_TEXT[e.bust_reason as string]}` : '正常';
        console.log(
          `#${e.id} P${e.player_index} T${e.turn_id}.${e.dart_in_turn} ` +
            `${e.section}x${e.multiplier}=${e.dart_value} ${e.score_before}->${e.temp_score} ` +
            `保留${e.final_score} [${tag}]`,
        );
      }
      console.log(`事件总数: ${log.events.length}`);
    } else if (cmd === 'verify') {
      const report = service.verify(Number(rest[0]));
      console.log(`核验通过: ${report.eventCount} 个事件，重放与缓存一致`);
      console.log(`当前状态: 玩家${report.state.currentPlayer} 第${report.state.currentTurn}回合 分数=${report.state.scores.join(',')}`);
    } else {
      usage();
    }
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`错误 [${err.code}]: ${err.message}`);
      process.exit(2);
    }
    throw err;
  } finally {
    store.close();
  }
}

main();

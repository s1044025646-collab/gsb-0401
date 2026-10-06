import { writeFileSync } from 'node:fs';
import { openDb, defaultDbPath } from './db.ts';
import { createMatch, getEvents, getState, recordThrow, exportMatch, verifyMatch } from './engine.ts';

const db = openDb(process.env.DARTS_DB ?? defaultDbPath());
const [, , cmd, ...args] = process.argv;

function parseDart(s: string) {
  // 形如 s16 / d10 / t20 / sb / db / miss
  const m = /^(s|d|t|sb|db|miss)(\d+)?$/i.exec(s);
  if (!m) throw new Error(`无法解析落点: ${s}，示例 s16 d10 t20 sb db miss`);
  const kind = m[1].toLowerCase();
  if (kind === 'miss') return { ring: 'miss' };
  if (kind === 'sb') return { ring: 'single', segment: 25 };
  if (kind === 'db') return { ring: 'double', segment: 25 };
  const ring = kind === 's' ? 'single' : kind === 'd' ? 'double' : 'triple';
  return { ring, segment: Number(m[2]) };
}

function out(v: unknown) {
  console.log(JSON.stringify(v, null, 2));
}

try {
  switch (cmd) {
    case 'create': {
      // create <playerCount> [startScore]
      out(createMatch(db, {
        playerCount: Number(args[0]),
        startScore: args[1] === undefined ? undefined : Number(args[1]),
      }));
      break;
    }
    case 'throw': {
      // throw <matchId> <playerIdx> <round> <requestId> <dart>
      const [matchId, playerIdx, round, requestId, dart] = args;
      out(recordThrow(db, Number(matchId), {
        requestId, playerIdx: Number(playerIdx), round: Number(round), dart: parseDart(dart),
      }));
      break;
    }
    case 'state': out(getState(db, Number(args[0]))); break;
    case 'events': out(getEvents(db, Number(args[0]))); break;
    case 'export': {
      const data = exportMatch(db, Number(args[0]));
      if (args[1]) {
        writeFileSync(args[1], JSON.stringify(data, null, 2));
        console.log(`已导出到 ${args[1]}`);
      } else out(data);
      break;
    }
    case 'verify': out(verifyMatch(db, Number(args[0]))); break;
    default:
      console.log(`用法:
  node src/cli.ts create <玩家数2-8> [起分2-501]
  node src/cli.ts throw <比赛ID> <玩家序号> <回合> <请求ID> <落点: s16|d10|t20|sb|db|miss>
  node src/cli.ts state <比赛ID>
  node src/cli.ts events <比赛ID>
  node src/cli.ts export <比赛ID> [输出文件]
  node src/cli.ts verify <比赛ID>`);
  }
} catch (e) {
  const err = e as { code?: string; message?: string };
  console.error(`错误 [${err.code ?? 'ERROR'}]: ${err.message ?? e}`);
  process.exitCode = 1;
}

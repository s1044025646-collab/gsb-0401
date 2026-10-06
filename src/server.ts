// 仅使用 node:http 的 JSON API

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as netCreateServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { AppError, MAX_BODY_BYTES } from './types.js';
import { Store } from './store.js';
import { BUST_REASON_TEXT } from './rules.js';
import { GameService } from './service.js';

export interface RunningServer {
  server: Server;
  port: number;
  store: Store;
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AppError('PAYLOAD_TOO_LARGE', `请求体超过 ${MAX_BODY_BYTES} 字节`, 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not object');
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new AppError('INVALID_JSON', '请求体必须是 JSON 对象'));
      }
    });
    req.on('error', () => reject(new AppError('INVALID_JSON', '读取请求体失败')));
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

// 找到空闲端口（port=0 时由操作系统分配）
export function findFreePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.on('error', reject);
    srv.listen(preferred, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('无法获取端口')));
      }
    });
  });
}

export async function startServer(dbPath: string, preferredPort?: number): Promise<RunningServer> {
  const store = new Store(dbPath);
  const service = new GameService(store);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (req.method === 'GET' && path === '/health') {
        return send(res, 200, { ok: true, limits: { maxPlayers: 8, maxBodyBytes: MAX_BODY_BYTES } });
      }

      if (req.method === 'POST' && path === '/games') {
        const body = await readJson(req);
        const created = service.createGame({
          startScore: body.startScore as number | undefined,
          players: body.players as string[] | undefined,
        });
        return send(res, 201, created);
      }

      const gameMatch = path.match(/^\/games\/(\d+)(?:\/(throw|status|export|verify))?$/);
      if (!gameMatch) {
        throw new AppError('NOT_FOUND', `未知路径 ${path}`, 404);
      }
      const gameId = Number(gameMatch[1]);
      const action = gameMatch[2];

      if (!action) {
        throw new AppError('NOT_FOUND', `未知路径 ${path}`, 404);
      }

      if (req.method === 'GET' && action === 'status') {
        const s = service.status(gameId);
        return send(res, 200, {
          gameId,
          startScore: s.game.start_score,
          currentPlayer: s.game.current_player,
          currentTurn: s.game.current_turn,
          turnStartScore: s.game.turn_start_score,
          dartsInTurn: s.game.darts_in_turn,
          winner: s.game.winner,
          players: s.players,
        });
      }

      if (req.method === 'GET' && action === 'export') {
        const log = service.exportLog(gameId);
        return send(res, 200, {
          game: {
            id: log.game.id,
            startScore: log.game.start_score,
            playerCount: log.game.player_count,
            names: log.names,
          },
          events: log.events.map((e) => ({
            eventId: e.id,
            requestId: e.request_id,
            playerIndex: e.player_index,
            turnId: e.turn_id,
            dartInTurn: e.dart_in_turn,
            section: e.section,
            multiplier: e.multiplier,
            dartValue: e.dart_value,
            scoreBefore: e.score_before,
            tempScore: e.temp_score,
            turnStartScore: e.turn_start_score,
            finalScore: e.final_score,
            busted: e.busted === 1,
            bustReason: e.bust_reason,
            bustReasonText: e.bust_reason ? BUST_REASON_TEXT[e.bust_reason] : null,
            won: e.won === 1,
            turnEnded: e.turn_ended === 1,
            nextPlayerIndex: e.next_player,
            nextTurnId: e.next_turn,
            createdAt: e.created_at,
          })),
        });
      }

      if (req.method === 'POST' && action === 'verify') {
        const report = service.verify(gameId);
        return send(res, 200, { ok: true, eventCount: report.eventCount, state: report.state });
      }

      if (req.method === 'POST' && action === 'throw') {
        const body = await readJson(req);
        const { result, duplicate } = service.throwDart(gameId, body);
        return send(res, duplicate ? 200 : 201, { duplicate, result });
      }

      throw new AppError('METHOD_NOT_ALLOWED', `${req.method} ${path} 不支持`, 405);
    } catch (err) {
      if (err instanceof AppError) {
        return send(res, err.httpStatus, { error: err.code, message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      return send(res, 500, { error: 'INTERNAL', message });
    }
  });

  const port = await findFreePort(preferredPort ?? 0);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port, store };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argPort = process.argv.find((a) => a.startsWith('--port='));
  const preferred = argPort ? Number(argPort.split('=')[1]) : undefined;
  const dbPath = process.env.DARTS_DB ?? 'data/darts.db';
  startServer(dbPath, preferred).then(({ port }) => {
    console.log(`飞镖 501 后端已启动: http://127.0.0.1:${port}`);
    console.log(`数据库: ${dbPath}`);
    console.log('按 Ctrl+C 退出');
  });
}

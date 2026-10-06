import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { openDb, defaultDbPath } from './db.ts';
import { ApiError, MAX_BODY_BYTES } from './domain.ts';
import { createMatch, getEvents, getState, recordThrow, exportMatch, verifyMatch } from './engine.ts';

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError('PAYLOAD_TOO_LARGE', `请求体超过 ${MAX_BODY_BYTES} 字节上限`, 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError('INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function startServer(port = 0, dbPath = defaultDbPath()) {
  const db = openDb(dbPath);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && url.pathname === '/matches') {
        return send(res, 201, createMatch(db, await readBody(req)));
      }
      if (parts[0] === 'matches' && parts.length >= 2) {
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) throw new ApiError('INVALID_PARAMS', '比赛编号必须是整数');
        const sub = parts[2];
        if (method === 'POST' && sub === 'throws') {
          return send(res, 200, recordThrow(db, id, await readBody(req)));
        }
        if (method === 'GET' && sub === undefined) return send(res, 200, getState(db, id));
        if (method === 'GET' && sub === 'turn') return send(res, 200, getState(db, id).currentTurn);
        if (method === 'GET' && sub === 'events') return send(res, 200, getEvents(db, id));
        if (method === 'GET' && sub === 'export') return send(res, 200, exportMatch(db, id));
        if (method === 'POST' && sub === 'verify') return send(res, 200, verifyMatch(db, id));
      }
      throw new ApiError('NOT_FOUND', `未知路由: ${method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof ApiError) {
        return send(res, e.status, { error: { code: e.code, message: e.message } });
      }
      return send(res, 500, { error: { code: 'INTERNAL', message: String(e) } });
    }
  });
  return new Promise<{ server: typeof server; port: number }>((resolvePromise) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolvePromise({ server, port: actualPort });
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  const port = process.env.PORT ? Number(process.env.PORT) : 0;
  startServer(port).then(({ port: p }) => {
    console.log(`飞镖 501 服务已启动: http://127.0.0.1:${p} (数据库: ${defaultDbPath()})`);
  });
}

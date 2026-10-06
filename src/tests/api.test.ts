import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from '../server.js';

function tempDb(name: string): string {
  const p = join(tmpdir(), `darts-api-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}.db`);
  rmSync(p, { force: true });
  return p;
}

async function api(running: RunningServer, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${running.port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('HTTP API 完整流程 + 错误码', async () => {
  const running = await startServer(tempDb('api'));
  try {
    const created = await api(running, 'POST', '/games', { startScore: 32, players: ['甲', '乙'] });
    assert.equal(created.status, 201);
    const gid = created.json.gameId;

    const r1 = await api(running, 'POST', `/games/${gid}/throw`, {
      requestId: 'x1',
      playerIndex: 0,
      turnId: 1,
      dart: { section: 16, multiplier: 1 },
    });
    assert.equal(r1.json.result.tempScore, 16);

    const bust = await api(running, 'POST', `/games/${gid}/throw`, {
      requestId: 'x2',
      playerIndex: 0,
      turnId: 1,
      dart: { section: 6, multiplier: 3 },
    });
    assert.equal(bust.json.result.busted, true);
    assert.equal(bust.json.result.finalScore, 32);

    // 错误玩家
    const wrong = await api(running, 'POST', `/games/${gid}/throw`, {
      requestId: 'x3',
      playerIndex: 0,
      turnId: 2,
      dart: { section: 1, multiplier: 1 },
    });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.json.error, 'NOT_YOUR_TURN');

    // 非法落点
    const bad = await api(running, 'POST', `/games/${gid}/throw`, {
      requestId: 'x4',
      playerIndex: 1,
      turnId: 2,
      dart: { section: 25, multiplier: 3 },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'INVALID_DART');

    // 导出与核验
    const verify = await api(running, 'POST', `/games/${gid}/verify`);
    assert.equal(verify.status, 200);
    const exp = await api(running, 'GET', `/games/${gid}/export`);
    assert.equal(exp.json.events.length, 2);

    // 404
    const nf = await api(running, 'GET', '/games/99999/status');
    assert.equal(nf.status, 404);
  } finally {
    running.server.close();
    running.store.close();
  }
});

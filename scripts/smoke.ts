import { startServer } from '../src/server.ts';

const { server, port } = await startServer(0, `data/smoke-${Date.now()}.db`);
const base = `http://127.0.0.1:${port}`;

async function post(path: string, body: object) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const m = await post('/matches', { playerCount: 2, startScore: 40 });
console.log('创建比赛:', m.status, m.body.matchId);
const id = m.body.matchId;
const t1 = await post(`/matches/${id}/throws`, { requestId: 's1', playerIdx: 0, round: 1, dart: { ring: 'single', segment: 20 } });
console.log('第1镖:', t1.body.outcome, '临时', t1.body.tempScore);
const t2 = await post(`/matches/${id}/throws`, { requestId: 's2', playerIdx: 0, round: 1, dart: { ring: 'double', segment: 10 } });
console.log('第2镖:', t2.body.outcome, '胜者', t2.body.winner);
const t3 = await post(`/matches/${id}/throws`, { requestId: 's3', playerIdx: 1, round: 1, dart: { ring: 'single', segment: 1 } });
console.log('赛后投镖:', t3.status, t3.body.error.code);
const dup = await post(`/matches/${id}/throws`, { requestId: 's1', playerIdx: 0, round: 1, dart: { ring: 'single', segment: 19 } });
console.log('同号不同载荷:', dup.status, dup.body.error.code);
const v = await post(`/matches/${id}/verify`, {});
console.log('重放核验:', v.body.ok, v.body.message);
server.close();

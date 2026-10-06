export type Ring = 'single' | 'double' | 'triple' | 'miss';

export interface Dart {
  ring: Ring;
  segment?: number;
}

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const MIN_START_SCORE = 2;
export const MAX_START_SCORE = 501;
export const MAX_EVENTS_PER_MATCH = 100000;
export const MAX_BODY_BYTES = 16 * 1024;

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function dartValue(d: Dart): number {
  if (d.ring === 'miss') return 0;
  const seg = d.segment!;
  if (d.ring === 'single') return seg;
  if (d.ring === 'double') return seg * 2;
  return seg * 3;
}

export function isDouble(d: Dart): boolean {
  return d.ring === 'double';
}

export function describeDart(d: Dart): string {
  if (d.ring === 'miss') return '脱靶(0)';
  if (d.ring === 'single' && d.segment === 25) return '单牛眼(25)';
  if (d.ring === 'double' && d.segment === 25) return '双牛眼(50)';
  const ringName = d.ring === 'single' ? '单倍' : d.ring === 'double' ? '双倍' : '三倍';
  return `${ringName}${d.segment}(${dartValue(d)})`;
}

export function validateDart(raw: unknown): Dart {
  if (typeof raw !== 'object' || raw === null) {
    throw new ApiError('INVALID_DART', '落点必须是对象');
  }
  const d = raw as Record<string, unknown>;
  const ring = d.ring;
  if (ring === 'miss') {
    if (d.segment !== undefined) throw new ApiError('INVALID_DART', '脱靶不应带分区号');
    return { ring: 'miss' };
  }
  if (ring !== 'single' && ring !== 'double' && ring !== 'triple') {
    throw new ApiError('INVALID_DART', `未知环区: ${String(ring)}`);
  }
  const seg = d.segment;
  if (typeof seg !== 'number' || !Number.isInteger(seg)) {
    throw new ApiError('INVALID_DART', '分区号必须是整数');
  }
  if (seg === 25) {
    if (ring === 'triple') throw new ApiError('INVALID_DART', '不存在三倍牛眼');
    return { ring, segment: 25 };
  }
  if (seg < 1 || seg > 20) {
    throw new ApiError('INVALID_DART', `不存在的分区: ${seg}`);
  }
  return { ring, segment: seg };
}

export function validateCreateParams(raw: unknown): {
  playerCount: number;
  startScore: number;
  playerNames: string[];
} {
  if (typeof raw !== 'object' || raw === null) {
    throw new ApiError('INVALID_PARAMS', '请求体必须是对象');
  }
  const b = raw as Record<string, unknown>;
  const playerCount = b.playerCount;
  if (typeof playerCount !== 'number' || !Number.isInteger(playerCount)
    || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    throw new ApiError('INVALID_PARAMS', `玩家数必须是 ${MIN_PLAYERS}-${MAX_PLAYERS} 的整数`);
  }
  const startScore = b.startScore === undefined ? 501 : b.startScore;
  if (typeof startScore !== 'number' || !Number.isInteger(startScore)
    || startScore < MIN_START_SCORE || startScore > MAX_START_SCORE) {
    throw new ApiError('INVALID_PARAMS', `起分必须是 ${MIN_START_SCORE}-${MAX_START_SCORE} 的整数`);
  }
  let playerNames: string[] = [];
  if (b.playerNames !== undefined) {
    if (!Array.isArray(b.playerNames) || b.playerNames.length !== playerCount
      || !b.playerNames.every((n) => typeof n === 'string' && n.length > 0 && n.length <= 32)) {
      throw new ApiError('INVALID_PARAMS', 'playerNames 必须是与玩家数等长的非空短字符串数组');
    }
    playerNames = b.playerNames as string[];
  } else {
    playerNames = Array.from({ length: playerCount }, (_, i) => `玩家${i + 1}`);
  }
  return { playerCount, startScore, playerNames };
}

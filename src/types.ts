// 公共类型与限制常量

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const MIN_START_SCORE = 2;
export const MAX_START_SCORE = 501;
export const DEFAULT_START_SCORE = 501;
export const DARTS_PER_TURN = 3;
export const MAX_BODY_BYTES = 16 * 1024;

// 落点类型
export type Multiplier = 1 | 2 | 3;

export interface DartSpec {
  // 分区编号 1-20，或牛眼标记
  section: number; // 1..20，或 25（牛眼）
  multiplier: Multiplier;
}

export type BustReason =
  | 'BELOW_ZERO' // 扣分后低于零
  | 'LEFT_ONE' // 恰好剩 1（无法用双倍结束）
  | 'NOT_DOUBLE'; // 到零但最后一镖不是双倍区

export interface ThrowInput {
  requestId: string;
  playerIndex: number;
  turnId: number;
  dart: DartSpec;
}

export interface ThrowResult {
  requestId: string;
  eventId: number;
  playerIndex: number;
  turnId: number;
  dartInTurn: number; // 本回合第几镖 1..3
  label: string; // 落点中文描述，如 "三倍 6"
  dartValue: number; // 本镖实际得分
  scoreBefore: number; // 投掷前余额
  tempScore: number; // 投掷后临时余额
  turnStartScore: number; // 回合起始值
  finalScore: number; // 最终保留分数
  busted: boolean;
  bustReason: BustReason | null;
  won: boolean;
  turnEnded: boolean; // 本回合是否结束
  nextPlayerIndex: number | null;
  nextTurnId: number | null;
}

export interface PlayerView {
  playerIndex: number;
  name: string;
  score: number;
  current: boolean;
}

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

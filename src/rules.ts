// 落点语义解析与飞镖规则（纯函数，无数据库依赖）

import { AppError, type DartSpec, type Multiplier } from './types.js';

export interface ResolvedDart {
  spec: DartSpec;
  value: number; // 实际得分
  label: string; // 中文落点描述
  isDouble: boolean; // 是否双倍区（双牛眼也算）
}

// 解析并校验落点。非法组合直接抛参数错误（这不是爆分）。
export function resolveDart(input: unknown): ResolvedDart {
  if (typeof input !== 'object' || input === null) {
    throw new AppError('INVALID_DART', '落点必须是对象，例如 {"section":20,"multiplier":3}');
  }
  const obj = input as Record<string, unknown>;
  const section = obj.section;
  const multiplier = obj.multiplier;

  if (typeof section !== 'number' || !Number.isInteger(section)) {
    throw new AppError('INVALID_DART', 'section 必须是整数');
  }
  if (typeof multiplier !== 'number' || !Number.isInteger(multiplier)) {
    throw new AppError('INVALID_DART', 'multiplier 必须是整数 1、2、3');
  }

  // 牛眼：section 25，只允许单 25 / 双 50
  if (section === 25) {
    if (multiplier === 1) {
      return { spec: { section: 25, multiplier: 1 }, value: 25, label: '单牛眼 25', isDouble: false };
    }
    if (multiplier === 2) {
      return { spec: { section: 25, multiplier: 2 }, value: 50, label: '双牛眼 50', isDouble: true };
    }
    throw new AppError('INVALID_DART', '牛眼只有单牛眼 25 与双牛眼 50，不存在三倍牛眼');
  }

  // 脱靶：section 0，只能 multiplier 1
  if (section === 0) {
    if (multiplier !== 1) {
      throw new AppError('INVALID_DART', '脱靶零分不区分倍区');
    }
    return { spec: { section: 0, multiplier: 1 }, value: 0, label: '脱靶 0', isDouble: false };
  }

  if (section < 1 || section > 20) {
    throw new AppError('INVALID_DART', `不存在 ${section} 分区，分区编号只能是 1-20、25（牛眼）或 0（脱靶）`);
  }
  if (multiplier < 1 || multiplier > 3) {
    throw new AppError('INVALID_DART', '倍区只能是 1（单倍）、2（双倍）、3（三倍）');
  }

  const m = multiplier as Multiplier;
  const names = { 1: '单倍', 2: '双倍', 3: '三倍' } as const;
  return {
    spec: { section, multiplier: m },
    value: section * m,
    label: `${names[m]} ${section}`,
    isDouble: m === 2,
  };
}

export interface RuleOutcome {
  tempScore: number;
  busted: boolean;
  bustReason: 'BELOW_ZERO' | 'LEFT_ONE' | 'NOT_DOUBLE' | null;
  won: boolean;
  finalScore: number;
}

// 判定一镖后的结果。turnStartScore 为回合开始余额，scoreBefore 为投前余额。
export function evaluateThrow(
  scoreBefore: number,
  turnStartScore: number,
  dart: ResolvedDart,
): RuleOutcome {
  const tempScore = scoreBefore - dart.value;

  if (tempScore < 0) {
    return { tempScore, busted: true, bustReason: 'BELOW_ZERO', won: false, finalScore: turnStartScore };
  }
  if (tempScore === 1) {
    return { tempScore, busted: true, bustReason: 'LEFT_ONE', won: false, finalScore: turnStartScore };
  }
  if (tempScore === 0) {
    if (dart.isDouble) {
      return { tempScore: 0, busted: false, bustReason: null, won: true, finalScore: 0 };
    }
    return { tempScore: 0, busted: true, bustReason: 'NOT_DOUBLE', won: false, finalScore: turnStartScore };
  }
  return { tempScore, busted: false, bustReason: null, won: false, finalScore: tempScore };
}

export const BUST_REASON_TEXT: Record<string, string> = {
  BELOW_ZERO: '扣分后低于零',
  LEFT_ONE: '恰好剩 1，无法以双倍结束',
  NOT_DOUBLE: '到零但最后一镖不是双倍区',
};

import type {LandmarkPoint} from '../kowtowDetection';
import {classifyPose} from './classifier';
import {extractFrameFeatures} from './features';
import type {
  FieldOfView,
  FinishReason,
  FrameFeatures,
  PoseBaseline,
  PoseEngineParams,
  PoseLabel,
  SequencePhase,
} from './types';

const SMOOTH_ALPHA = 0.5;
// 跳变被连续拒绝多帧后,承认为真实的新位置(动作断层后续上)
const JUMP_ACCEPT_STREAK = 5;
// ARMED 站立时基线慢速自适应(镜头微移自愈)
const BASELINE_ADAPT_ALPHA = 0.05;
// 基线 gap/肩宽下限,防退化
const MIN_SCALE = 0.05;
// 安置期采样中,髋或膝可见帧占比超过此值 → 全身视野
const FULL_VIEW_SEEN_RATIO = 0.5;

export type PoseEngineState = {
  phase: SequencePhase;
  baseline: PoseBaseline | null;
  // 输入清洗
  smoothedHeadY: number | null;
  smoothedShoulderY: number | null;
  smoothedWidth: number | null;
  jumpRejectStreak: number;
  // 标签防抖
  candidateLabel: PoseLabel;
  candidateFrames: number;
  label: PoseLabel;
  labelSince: number;
  // 安置期采样
  setupStandingSince: number | null;
  setupHeadSum: number;
  setupShoulderSum: number;
  setupWidthSum: number;
  setupSamples: number;
  setupHipSeen: number;
  setupKneeSeen: number;
  // 周期(唯一出口:applyFinish)
  cycleStartAt: number | null;
  bowReturnedAt: number | null;
  evidenceKneeled: boolean;
  occludedBottom: boolean;
  suspendedAt: number | null;
  phaseStartedAt: number;
  lastFinishReason: FinishReason | null;
};

export type PoseEngineDebug = {
  phase: SequencePhase;
  label: PoseLabel;
  headY: number | null;
  shoulderY: number | null;
  gap: number | null;
  sink: number | null;
  baselineShoulderY: number | null;
  fieldOfView: FieldOfView | null;
  lastFinishReason: FinishReason | null;
};

export type PoseEngineStepResult = {
  state: PoseEngineState;
  counted: boolean;
  backfilled: boolean;
  debug: PoseEngineDebug;
};

export function createPoseEngineState(now: number): PoseEngineState {
  return {
    phase: 'AWAIT_SETUP',
    baseline: null,
    smoothedHeadY: null,
    smoothedShoulderY: null,
    smoothedWidth: null,
    jumpRejectStreak: 0,
    candidateLabel: 'absent',
    candidateFrames: 0,
    label: 'absent',
    labelSince: now,
    setupStandingSince: null,
    setupHeadSum: 0,
    setupShoulderSum: 0,
    setupWidthSum: 0,
    setupSamples: 0,
    setupHipSeen: 0,
    setupKneeSeen: 0,
    cycleStartAt: null,
    bowReturnedAt: null,
    evidenceKneeled: false,
    occludedBottom: false,
    suspendedAt: null,
    phaseStartedAt: now,
    lastFinishReason: null,
  };
}

const ABSENT_FEATURES: FrameFeatures = {
  headY: null,
  shoulderY: null,
  hipY: null,
  kneeY: null,
  shoulderWidth: null,
};

function ema(prevValue: number | null, value: number | null): number | null {
  if (value === null) {
    return prevValue;
  }
  if (prevValue === null) {
    return value;
  }
  return prevValue * (1 - SMOOTH_ALPHA) + value * SMOOTH_ALPHA;
}

// 跳变剔除 + EMA 平滑;直接更新 next 上的 smoothed/jump 字段,返回清洗后的特征
function cleanFeatures(
  next: PoseEngineState,
  raw: FrameFeatures,
  params: PoseEngineParams,
): FrameFeatures {
  const visible = raw.headY !== null || raw.shoulderY !== null;
  if (!visible) {
    next.jumpRejectStreak = 0;
    return ABSENT_FEATURES;
  }

  const probe = raw.shoulderY ?? raw.headY;
  const reference = next.smoothedShoulderY ?? next.smoothedHeadY;
  if (
    probe !== null &&
    reference !== null &&
    Math.abs(probe - reference) > params.jumpRejectThreshold
  ) {
    next.jumpRejectStreak += 1;
    if (next.jumpRejectStreak < JUMP_ACCEPT_STREAK) {
      // 单帧不可能的位移:按本帧不可见处理(关键点错乱的典型形态)
      return ABSENT_FEATURES;
    }
    // 连续多帧自洽的新位置:承认并重置平滑,避免拖尾假轨迹
    next.smoothedHeadY = raw.headY;
    next.smoothedShoulderY = raw.shoulderY;
    next.smoothedWidth = raw.shoulderWidth;
    next.jumpRejectStreak = 0;
  } else {
    next.jumpRejectStreak = 0;
    next.smoothedHeadY = ema(next.smoothedHeadY, raw.headY);
    next.smoothedShoulderY = ema(next.smoothedShoulderY, raw.shoulderY);
    next.smoothedWidth = ema(next.smoothedWidth, raw.shoulderWidth);
  }

  return {
    headY: raw.headY !== null ? next.smoothedHeadY : null,
    shoulderY: raw.shoulderY !== null ? next.smoothedShoulderY : null,
    hipY: raw.hipY,
    kneeY: raw.kneeY,
    shoulderWidth: raw.shoulderWidth !== null ? next.smoothedWidth : null,
  };
}

function updateLabel(
  next: PoseEngineState,
  features: FrameFeatures,
  now: number,
  params: PoseEngineParams,
): void {
  const rawLabel = classifyPose(features, next.baseline, params);
  if (rawLabel === next.candidateLabel) {
    next.candidateFrames += 1;
  } else {
    next.candidateLabel = rawLabel;
    next.candidateFrames = 1;
  }
  if (next.candidateFrames >= params.labelConfirmFrames && next.label !== next.candidateLabel) {
    next.label = next.candidateLabel;
    next.labelSince = now;
  }
}

function resetSetupSampling(next: PoseEngineState): void {
  next.setupStandingSince = null;
  next.setupHeadSum = 0;
  next.setupShoulderSum = 0;
  next.setupWidthSum = 0;
  next.setupSamples = 0;
  next.setupHipSeen = 0;
  next.setupKneeSeen = 0;
}

function handleAwaitSetup(
  next: PoseEngineState,
  features: FrameFeatures,
  now: number,
  params: PoseEngineParams,
): void {
  const sampleReady =
    next.label === 'standing' &&
    features.headY !== null &&
    features.shoulderY !== null &&
    features.shoulderWidth !== null;
  if (!sampleReady) {
    resetSetupSampling(next);
    return;
  }
  if (next.setupStandingSince === null) {
    next.setupStandingSince = now;
  }
  next.setupHeadSum += features.headY as number;
  next.setupShoulderSum += features.shoulderY as number;
  next.setupWidthSum += features.shoulderWidth as number;
  next.setupSamples += 1;
  if (features.hipY !== null) {
    next.setupHipSeen += 1;
  }
  if (features.kneeY !== null) {
    next.setupKneeSeen += 1;
  }

  if (now - next.setupStandingSince >= params.setupStandingMs && next.setupSamples > 0) {
    const headY = next.setupHeadSum / next.setupSamples;
    const shoulderY = next.setupShoulderSum / next.setupSamples;
    const shoulderWidth = next.setupWidthSum / next.setupSamples;
    const lowerSeen = Math.max(next.setupHipSeen, next.setupKneeSeen);
    next.baseline = {
      headY,
      shoulderY,
      gap: Math.max(shoulderY - headY, MIN_SCALE),
      shoulderWidth: Math.max(shoulderWidth, MIN_SCALE),
      fieldOfView: lowerSeen / next.setupSamples > FULL_VIEW_SEEN_RATIO ? 'full' : 'upper',
    };
    next.phase = 'ARMED';
    next.phaseStartedAt = now;
    resetSetupSampling(next);
  }
}

function handleArmed(
  next: PoseEngineState,
  features: FrameFeatures,
  now: number,
  params: PoseEngineParams,
): void {
  if (
    next.label === 'standing' &&
    next.baseline !== null &&
    features.headY !== null &&
    features.shoulderY !== null
  ) {
    // 站立时基线慢速自适应(镜头微移自愈)
    const base = next.baseline;
    const headY = base.headY * (1 - BASELINE_ADAPT_ALPHA) + features.headY * BASELINE_ADAPT_ALPHA;
    const shoulderY =
      base.shoulderY * (1 - BASELINE_ADAPT_ALPHA) + features.shoulderY * BASELINE_ADAPT_ALPHA;
    next.baseline = {
      ...base,
      headY,
      shoulderY,
      gap: Math.max(shoulderY - headY, MIN_SCALE),
      shoulderWidth:
        features.shoulderWidth !== null
          ? base.shoulderWidth * (1 - BASELINE_ADAPT_ALPHA) +
            features.shoulderWidth * BASELINE_ADAPT_ALPHA
          : base.shoulderWidth,
    };
    return;
  }

  const folded = next.label === 'bowing' || next.label === 'prostrate';
  const foldConfirmed = folded && now - next.labelSince >= params.bowConfirmMs;
  const kneelConfirmed = next.label === 'kneeling' && now - next.labelSince >= params.bowConfirmMs;

  if (params.mode === 'prostration') {
    // 磕头数模式:跪坐基线下俯身即趴底,无独立的弯腰/跪阶段
    if (foldConfirmed) {
      next.phase = 'BOTTOM';
      next.phaseStartedAt = now;
      next.cycleStartAt = next.labelSince;
      next.bowReturnedAt = null;
      next.evidenceKneeled = true;
      next.occludedBottom = false;
    }
    return;
  }

  if (foldConfirmed) {
    next.phase = 'BOW';
    next.phaseStartedAt = now;
    next.cycleStartAt = next.labelSince;
    next.bowReturnedAt = null;
    next.evidenceKneeled = false;
    next.occludedBottom = false;
    return;
  }
  if (kneelConfirmed) {
    // 未观测到问讯直接下跪(弯腰永远不会产生 kneeling 标签,放行安全)
    next.phase = 'KNEEL';
    next.phaseStartedAt = now;
    next.cycleStartAt = next.labelSince;
    next.bowReturnedAt = null;
    next.evidenceKneeled = true;
    next.occludedBottom = false;
  }
}

function toSuspended(next: PoseEngineState, now: number): void {
  next.phase = 'SUSPENDED';
  next.phaseStartedAt = now;
  next.suspendedAt = now;
}

function handleBow(
  next: PoseEngineState,
  now: number,
  params: PoseEngineParams,
): FinishReason | null {
  if (next.label === 'kneeling') {
    next.evidenceKneeled = true;
    next.phase = 'KNEEL';
    next.phaseStartedAt = now;
    return null;
  }
  if (next.label === 'standing') {
    if (next.bowReturnedAt === null) {
      next.bowReturnedAt = next.labelSince;
    }
    if (now - next.bowReturnedAt >= params.bowReturnGraceMs) {
      // 弯腰后宽限窗内无下沉:单独问讯,拒计
      return 'rejected';
    }
  } else {
    next.bowReturnedAt = null;
  }
  if (now - next.phaseStartedAt >= params.phaseTimeoutMs) {
    // 无下跪证据即长时间无进展(含弯腰后消失):宁漏勿误,放弃
    return 'abandoned';
  }
  return null;
}

function handleKneel(
  next: PoseEngineState,
  now: number,
  params: PoseEngineParams,
): FinishReason | null {
  if (next.label === 'prostrate') {
    next.phase = 'BOTTOM';
    next.phaseStartedAt = now;
    return null;
  }
  if (next.label === 'standing' && now - next.labelSince >= params.standConfirmMs) {
    // 跪了又直接起身,没磕头:不是完整一拜
    return 'rejected';
  }
  if (next.label === 'absent') {
    if (next.baseline?.fieldOfView === 'upper') {
      // 上半身视野:跪后消失符合趴底消失签名 → 视作到底(被遮挡形态)
      next.occludedBottom = true;
      next.phase = 'BOTTOM';
      next.phaseStartedAt = now;
      return null;
    }
    if (now - next.labelSince >= params.absentToSuspendMs) {
      toSuspended(next, now);
      return null;
    }
  }
  if (now - next.phaseStartedAt >= params.phaseTimeoutMs) {
    // 已有下跪证据:转挂起等待回站确认,而非直接放弃
    toSuspended(next, now);
  }
  return null;
}

function handleBottom(
  next: PoseEngineState,
  now: number,
  params: PoseEngineParams,
): FinishReason | null {
  if (next.label === 'kneeling' || next.label === 'standing' || next.label === 'bowing') {
    next.phase = 'RISE';
    next.phaseStartedAt = now;
    return null;
  }
  // prostrate / absent / transition 都属于趴底中(磕长头允许长停留)
  if (now - next.phaseStartedAt >= params.bottomTimeoutMs) {
    toSuspended(next, now);
  }
  return null;
}

function handleRise(
  next: PoseEngineState,
  now: number,
  params: PoseEngineParams,
): FinishReason | null {
  if (next.label === 'standing' && now - next.labelSince >= params.standConfirmMs) {
    const longEnough = next.cycleStartAt !== null && now - next.cycleStartAt >= params.minCycleMs;
    return longEnough ? 'completed' : 'rejected';
  }
  if (next.label === 'prostrate') {
    next.phase = 'BOTTOM';
    next.phaseStartedAt = now;
    return null;
  }
  if (next.label === 'absent' && now - next.labelSince >= params.absentToSuspendMs) {
    toSuspended(next, now);
    return null;
  }
  if (now - next.phaseStartedAt >= params.phaseTimeoutMs) {
    toSuspended(next, now);
  }
  return null;
}

function handleSuspended(
  next: PoseEngineState,
  now: number,
  params: PoseEngineParams,
): FinishReason | null {
  // 挂起期间正常计数路径全部关闭,唯一出口:回站确认补计 / 超时放弃
  if (next.label === 'standing' && now - next.labelSince >= params.backfillStandMs) {
    return 'backfilled';
  }
  if (next.suspendedAt !== null && now - next.suspendedAt >= params.suspendTimeoutMs) {
    return 'abandoned';
  }
  return null;
}

// 周期唯一出口:同一周期结构上只能终结一次(spec §9 防双计)
function applyFinish(next: PoseEngineState, reason: FinishReason, now: number): void {
  next.lastFinishReason = reason;
  next.cycleStartAt = null;
  next.bowReturnedAt = null;
  next.evidenceKneeled = false;
  next.occludedBottom = false;
  next.suspendedAt = null;
  if (reason === 'abandoned') {
    // 人已不在或信号不可信:基线作废,重新安置
    next.phase = 'AWAIT_SETUP';
    next.baseline = null;
    resetSetupSampling(next);
  } else {
    next.phase = 'ARMED';
  }
  next.phaseStartedAt = now;
}

function makeDebug(next: PoseEngineState, features: FrameFeatures): PoseEngineDebug {
  const gap =
    features.headY !== null && features.shoulderY !== null
      ? features.shoulderY - features.headY
      : null;
  const sink =
    features.shoulderY !== null && next.baseline !== null
      ? features.shoulderY - next.baseline.shoulderY
      : null;
  return {
    phase: next.phase,
    label: next.label,
    headY: features.headY,
    shoulderY: features.shoulderY,
    gap,
    sink,
    baselineShoulderY: next.baseline?.shoulderY ?? null,
    fieldOfView: next.baseline?.fieldOfView ?? null,
    lastFinishReason: next.lastFinishReason,
  };
}

export function advancePoseSequence(
  prev: PoseEngineState,
  landmarks: LandmarkPoint[] | null | undefined,
  now: number,
  params: PoseEngineParams,
): PoseEngineStepResult {
  const next: PoseEngineState = {...prev};
  const cleaned = cleanFeatures(next, extractFrameFeatures(landmarks), params);
  updateLabel(next, cleaned, now, params);

  let finish: FinishReason | null = null;
  switch (next.phase) {
    case 'AWAIT_SETUP':
      handleAwaitSetup(next, cleaned, now, params);
      break;
    case 'ARMED':
      handleArmed(next, cleaned, now, params);
      break;
    case 'BOW':
      finish = handleBow(next, now, params);
      break;
    case 'KNEEL':
      finish = handleKneel(next, now, params);
      break;
    case 'BOTTOM':
      finish = handleBottom(next, now, params);
      break;
    case 'RISE':
      finish = handleRise(next, now, params);
      break;
    case 'SUSPENDED':
      finish = handleSuspended(next, now, params);
      break;
  }

  let counted = false;
  let backfilled = false;
  if (finish !== null) {
    applyFinish(next, finish, now);
    counted = finish === 'completed';
    backfilled = finish === 'backfilled';
  }

  return {state: next, counted, backfilled, debug: makeDebug(next, cleaned)};
}

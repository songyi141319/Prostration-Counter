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

  switch (next.phase) {
    case 'AWAIT_SETUP':
      handleAwaitSetup(next, cleaned, now, params);
      break;
    case 'ARMED':
      handleArmed(next, cleaned, now, params);
      break;
    default:
      break;
  }

  return {state: next, counted: false, backfilled: false, debug: makeDebug(next, cleaned)};
}

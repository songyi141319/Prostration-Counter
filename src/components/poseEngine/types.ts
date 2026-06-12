import type {CountMode} from '../kowtowDetection';

export type PoseLabel = 'standing' | 'bowing' | 'kneeling' | 'prostrate' | 'transition' | 'absent';

export type FieldOfView = 'full' | 'upper';

export type SequencePhase =
  | 'AWAIT_SETUP'
  | 'ARMED'
  | 'BOW'
  | 'KNEEL'
  | 'BOTTOM'
  | 'RISE'
  | 'SUSPENDED';

export type FinishReason = 'completed' | 'backfilled' | 'rejected' | 'abandoned';

export type FrameFeatures = {
  headY: number | null;
  shoulderY: number | null;
  hipY: number | null;
  kneeY: number | null;
  shoulderWidth: number | null;
};

export type PoseBaseline = {
  headY: number;
  shoulderY: number;
  // 站立时头肩 Y 间距(shoulderY - headY),恒为正;前倾形态判定的分母
  gap: number;
  shoulderWidth: number;
  fieldOfView: FieldOfView;
};

export type PoseEngineParams = {
  mode: CountMode;
  labelConfirmFrames: number;
  setupStandingMs: number;
  bowConfirmMs: number;
  bowReturnGraceMs: number;
  standConfirmMs: number;
  backfillStandMs: number;
  minCycleMs: number;
  suspendTimeoutMs: number;
  phaseTimeoutMs: number;
  bottomTimeoutMs: number;
  absentToSuspendMs: number;
  gapBowRatio: number;
  gapUprightRatio: number;
  kneelDropK: number;
  prostrateDropK: number;
  standingBandK: number;
  jumpRejectThreshold: number;
};

export const DEFAULT_POSE_ENGINE_PARAMS: Omit<PoseEngineParams, 'mode'> = {
  labelConfirmFrames: 3,
  setupStandingMs: 2000,
  bowConfirmMs: 300,
  bowReturnGraceMs: 3000,
  standConfirmMs: 500,
  backfillStandMs: 1500,
  minCycleMs: 3000,
  suspendTimeoutMs: 60000,
  phaseTimeoutMs: 12000,
  bottomTimeoutMs: 90000,
  absentToSuspendMs: 2500,
  gapBowRatio: 0.35,
  gapUprightRatio: 0.6,
  kneelDropK: 1.0,
  prostrateDropK: 1.6,
  standingBandK: 0.45,
  jumpRejectThreshold: 0.25,
};

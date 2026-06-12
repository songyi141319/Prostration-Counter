import type {FrameFeatures, PoseBaseline, PoseEngineParams, PoseLabel} from './types';

// 门槛计算中肩宽/基线 gap 的下限,防止退化
const MIN_SCALE = 0.05;
// 无基线时,头需高于肩多少才算 standing-like(安置期采样用)
const SETUP_MIN_GAP = 0.04;

export function classifyPose(
  features: FrameFeatures,
  baseline: PoseBaseline | null,
  params: PoseEngineParams,
): PoseLabel {
  const headVisible = features.headY !== null;
  const shoulderVisible = features.shoulderY !== null;

  if (!headVisible && !shoulderVisible) {
    return 'absent';
  }

  if (baseline === null) {
    if (
      features.headY !== null &&
      features.shoulderY !== null &&
      features.shoulderY - features.headY > SETUP_MIN_GAP
    ) {
      return 'standing';
    }
    return 'transition';
  }

  const width = Math.max(baseline.shoulderWidth, MIN_SCALE);
  const baseGap = Math.max(baseline.gap, MIN_SCALE);
  const sink = features.shoulderY !== null ? features.shoulderY - baseline.shoulderY : null;

  if (features.headY === null) {
    // 头不可见、肩可见:深弯腰头出画(肩未深沉)或趴底(肩深沉)
    if (sink === null) {
      return 'transition';
    }
    if (sink >= params.prostrateDropK * width) {
      return 'prostrate';
    }
    if (sink < params.kneelDropK * width) {
      return 'bowing';
    }
    return 'transition';
  }

  if (features.shoulderY === null) {
    return 'transition';
  }

  const gap = features.shoulderY - features.headY;
  const folded = gap <= params.gapBowRatio * baseGap;
  const upright = gap >= params.gapUprightRatio * baseGap;

  if (folded) {
    return sink !== null && sink >= params.prostrateDropK * width ? 'prostrate' : 'bowing';
  }

  if (upright) {
    if (Math.abs(features.shoulderY - baseline.shoulderY) <= params.standingBandK * width) {
      return 'standing';
    }
    if (sink !== null && sink >= params.kneelDropK * width) {
      return 'kneeling';
    }
    return 'transition';
  }

  return 'transition';
}

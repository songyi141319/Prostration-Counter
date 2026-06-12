import type {LandmarkPoint} from '../kowtowDetection';
import type {FrameFeatures} from './types';

const HEAD_POINT_INDICES = [0, 2, 5, 7, 8];
const HEAD_VIS_MIN = 0.4;
const BODY_VIS_MIN = 0.5;
const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;
const LEFT_HIP = 23;
const RIGHT_HIP = 24;
const LEFT_KNEE = 25;
const RIGHT_KNEE = 26;

const EMPTY_FEATURES: FrameFeatures = {
  headY: null,
  shoulderY: null,
  hipY: null,
  kneeY: null,
  shoulderWidth: null,
};

function pairY(
  landmarks: LandmarkPoint[],
  leftIndex: number,
  rightIndex: number,
): number | null {
  const left = landmarks[leftIndex];
  const right = landmarks[rightIndex];
  const leftOk = left !== undefined && (left.visibility ?? 0) > BODY_VIS_MIN;
  const rightOk = right !== undefined && (right.visibility ?? 0) > BODY_VIS_MIN;
  if (leftOk && rightOk) {
    return (left.y + right.y) / 2;
  }
  if (leftOk) {
    return left.y;
  }
  if (rightOk) {
    return right.y;
  }
  return null;
}

export function extractFrameFeatures(
  landmarks: LandmarkPoint[] | null | undefined,
): FrameFeatures {
  if (!landmarks || landmarks.length === 0) {
    return EMPTY_FEATURES;
  }

  let weighted = 0;
  let totalWeight = 0;
  for (const index of HEAD_POINT_INDICES) {
    const point = landmarks[index];
    const vis = point?.visibility ?? 0;
    if (point && vis > HEAD_VIS_MIN) {
      weighted += point.y * vis;
      totalWeight += vis;
    }
  }

  const left = landmarks[LEFT_SHOULDER];
  const right = landmarks[RIGHT_SHOULDER];
  const shoulderWidth =
    left &&
    right &&
    (left.visibility ?? 0) > BODY_VIS_MIN &&
    (right.visibility ?? 0) > BODY_VIS_MIN
      ? Math.abs(left.x - right.x)
      : null;

  return {
    headY: totalWeight > 0 ? weighted / totalWeight : null,
    shoulderY: pairY(landmarks, LEFT_SHOULDER, RIGHT_SHOULDER),
    hipY: pairY(landmarks, LEFT_HIP, RIGHT_HIP),
    kneeY: pairY(landmarks, LEFT_KNEE, RIGHT_KNEE),
    shoulderWidth,
  };
}

export type CountMode = 'ritual' | 'prostration';
export type PerspectiveMode = 'front' | 'side';
export type MotionPhase =
  | 'READY'
  | 'DESCENDING'
  | 'KNEELING'
  | 'BOTTOM'
  | 'ASCENDING'
  | 'PROSTRATION_BOTTOM';

export type LandmarkPoint = {x: number; y: number; visibility?: number};

export type FrameSignal = {bodyY: number | null; bodyScale: number | null};

const HEAD_POINT_INDICES = [0, 2, 5, 7, 8];
const HEAD_VIS_MIN = 0.4;
const SHOULDER_VIS_MIN = 0.5;
const LEFT_SHOULDER_INDEX = 11;
const RIGHT_SHOULDER_INDEX = 12;

export function computeBodySignal(landmarks: LandmarkPoint[] | null | undefined): FrameSignal {
  if (!landmarks || landmarks.length === 0) {
    return {bodyY: null, bodyScale: null};
  }

  const left = landmarks[LEFT_SHOULDER_INDEX];
  const right = landmarks[RIGHT_SHOULDER_INDEX];
  const leftVis = left?.visibility ?? 0;
  const rightVis = right?.visibility ?? 0;
  const bodyScale =
    left && right && leftVis > SHOULDER_VIS_MIN && rightVis > SHOULDER_VIS_MIN
      ? Math.abs(left.x - right.x)
      : null;

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

  if (totalWeight === 0) {
    if (left && leftVis > SHOULDER_VIS_MIN) {
      weighted += left.y * leftVis;
      totalWeight += leftVis;
    }
    if (right && rightVis > SHOULDER_VIS_MIN) {
      weighted += right.y * rightVis;
      totalWeight += rightVis;
    }
  }

  return {
    bodyY: totalWeight > 0 ? weighted / totalWeight : null,
    bodyScale,
  };
}

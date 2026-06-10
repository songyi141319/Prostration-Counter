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

export type DetectionParams = {
  mode: CountMode;
  perspective: PerspectiveMode;
  autoCalibrationIntervalMs: number;
  stableFrameCount: number;
  stableDelta: number;
  minAmplitude: number;
  bottomDepthBias: number;
  recoveryBias: number;
  phaseTimeoutMs: number;
  dropGateK: number;
  holdFrames: number;
  lostBottomFrames: number;
  recoveryTolerance: number;
};

export type CalibrationSession = {
  startAt: number;
  until: number;
  ys: number[];
  scales: number[];
};

export type DetectionState = {
  phase: MotionPhase;
  cycleArmed: boolean;
  isBowed: boolean;
  standingFrames: number;
  descentFrames: number;
  kneelingFrames: number;
  bottomFrames: number;
  prostrationBottomFrames: number;
  risingFrames: number;
  recoveryFrames: number;
  stableFrames: number;
  smoothedBodyY: number | null;
  lastBodyY: number | null;
  minY: number;
  maxY: number;
  smoothedBodyScale: number | null;
  standingBodyY: number | null;
  baselineBodyScale: number | null;
  cycleMaxBodyY: number | null;
  occlusionBottom: boolean;
  lostFrames: number;
  lastCalibrationAt: number;
  phaseStartedAt: number;
  calibration: CalibrationSession | null;
};

export type DetectionDebug = {
  phase: MotionPhase;
  bodyY: number | null;
  bodyScale: number | null;
  amplitude: number;
  minY: number;
  maxY: number;
  drop: number | null;
  standingBodyY: number | null;
  baselineBodyScale: number | null;
  armed: boolean;
  occlusionBottom: boolean;
  lost: boolean;
};

export type DetectionStepResult = {
  state: DetectionState;
  counted: boolean;
  calibrated: boolean;
  debug: DetectionDebug;
};

export const OCCLUSION_DROP_RATIO = 0.5;
// 到底阶段属于合法的长时间停留（磕长头/祈祷），超时按普通阶段放宽 5 倍
const BOTTOM_TIMEOUT_MULTIPLIER = 5;
const AMPLITUDE_CAP = 0.6;
const BASELINE_EMA_ALPHA = 0.1;
const SCALE_SMOOTHING_ALPHA = 0.3;
export const CALIBRATION_LEAD_MS = 1500;
export const CALIBRATION_DURATION_MS = 2000;

const PERSPECTIVE_RATIOS = {
  front: {
    decay: 0.00064,
    standing: 0.3,
    bow: 0.36,
    kneel: 0.58,
    bottom: 0.1,
    rising: 0.24,
    prostrationReady: 0.42,
    prostrationBottom: 0.06,
  },
  side: {
    decay: 0.00088,
    standing: 0.35,
    bow: 0.33,
    kneel: 0.52,
    bottom: 0.13,
    rising: 0.28,
    prostrationReady: 0.36,
    prostrationBottom: 0.08,
  },
} as const;

export function createDetectionState(now: number, baseBodyY: number | null = null): DetectionState {
  return {
    phase: 'READY',
    cycleArmed: false,
    isBowed: false,
    standingFrames: 0,
    descentFrames: 0,
    kneelingFrames: 0,
    bottomFrames: 0,
    prostrationBottomFrames: 0,
    risingFrames: 0,
    recoveryFrames: 0,
    stableFrames: 0,
    smoothedBodyY: baseBodyY,
    lastBodyY: baseBodyY,
    minY: baseBodyY ?? 1,
    maxY: baseBodyY ?? 0,
    smoothedBodyScale: null,
    standingBodyY: null,
    baselineBodyScale: null,
    cycleMaxBodyY: null,
    occlusionBottom: false,
    lostFrames: 0,
    lastCalibrationAt: now,
    phaseStartedAt: now,
    calibration: null,
  };
}

export function startCalibration(state: DetectionState, now: number): DetectionState {
  const startAt = now + CALIBRATION_LEAD_MS;
  return {
    ...state,
    calibration: {startAt, until: startAt + CALIBRATION_DURATION_MS, ys: [], scales: []},
  };
}

function recalibrate(state: DetectionState, now: number, baseBodyY: number | null): DetectionState {
  return {
    ...createDetectionState(now, baseBodyY),
    smoothedBodyScale: state.smoothedBodyScale,
    standingBodyY: state.standingBodyY,
    baselineBodyScale: state.baselineBodyScale,
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function makeDebug(state: DetectionState, lost: boolean): DetectionDebug {
  const drop =
    state.cycleMaxBodyY !== null && state.standingBodyY !== null
      ? state.cycleMaxBodyY - state.standingBodyY
      : null;
  return {
    phase: state.phase,
    bodyY: state.smoothedBodyY,
    bodyScale: state.smoothedBodyScale,
    amplitude: Math.max(0, state.maxY - state.minY),
    minY: state.minY,
    maxY: state.maxY,
    drop,
    standingBodyY: state.standingBodyY,
    baselineBodyScale: state.baselineBodyScale,
    armed: state.cycleArmed,
    occlusionBottom: state.occlusionBottom,
    lost,
  };
}

function phaseTimeoutFor(phase: MotionPhase, params: DetectionParams): number {
  return phase === 'BOTTOM' || phase === 'PROSTRATION_BOTTOM'
    ? params.phaseTimeoutMs * BOTTOM_TIMEOUT_MULTIPLIER
    : params.phaseTimeoutMs;
}

function passesDropGate(state: DetectionState, params: DetectionParams): boolean {
  if (state.standingBodyY === null || state.baselineBodyScale === null) {
    return true;
  }
  if (state.cycleMaxBodyY === null) {
    return false;
  }
  const drop = state.cycleMaxBodyY - state.standingBodyY;
  const gateK = state.occlusionBottom ? params.dropGateK * OCCLUSION_DROP_RATIO : params.dropGateK;
  return drop >= gateK * state.baselineBodyScale;
}

export function advanceDetection(
  prev: DetectionState,
  signal: FrameSignal,
  now: number,
  params: DetectionParams,
): DetectionStepResult {
  const ratios = PERSPECTIVE_RATIOS[params.perspective];
  const next: DetectionState = {...prev};
  let counted = false;

  // ---- 手动校准采样：冻结状态机，只收样本 ----
  if (prev.calibration) {
    const session: CalibrationSession = {
      startAt: prev.calibration.startAt,
      until: prev.calibration.until,
      ys: [...prev.calibration.ys],
      scales: [...prev.calibration.scales],
    };
    if (now >= session.startAt) {
      if (signal.bodyY !== null) {
        session.ys.push(signal.bodyY);
      }
      if (signal.bodyScale !== null) {
        session.scales.push(signal.bodyScale);
      }
    }
    if (now < session.until) {
      next.calibration = session;
      return {state: next, counted: false, calibrated: false, debug: makeDebug(next, false)};
    }
    const base = session.ys.length > 0 ? mean(session.ys) : prev.smoothedBodyY;
    const settled = recalibrate(next, now, base);
    let calibrated = false;
    if (session.ys.length > 0) {
      settled.standingBodyY = mean(session.ys);
      calibrated = true;
    }
    if (session.scales.length > 0) {
      settled.baselineBodyScale = mean(session.scales);
    }
    settled.calibration = null;
    return {state: settled, counted: false, calibrated, debug: makeDebug(settled, false)};
  }

  // ---- 可见性软闸门 ----
  if (signal.bodyY === null) {
    next.lostFrames = prev.lostFrames + 1;
    const lost = next.lostFrames > params.holdFrames;
    if (prev.smoothedBodyY === null) {
      return {state: next, counted: false, calibrated: false, debug: makeDebug(next, lost)};
    }
    if (!lost) {
      // 短暂丢失：保持上一帧高度，状态机原地等待
      return {state: next, counted: false, calibrated: false, debug: makeDebug(next, false)};
    }
    // 完全丢失：检查「消失即到底」
    const beyondHold = next.lostFrames - params.holdFrames;
    const lostBaselineY = next.standingBodyY;
    const lostScale = next.baselineBodyScale;
    const lostCycleMax = next.cycleMaxBodyY;
    if (
      lostBaselineY !== null &&
      lostScale !== null &&
      lostCycleMax !== null &&
      beyondHold >= params.lostBottomFrames
    ) {
      const preDrop = lostCycleMax - lostBaselineY;
      const occlusionGateOk = preDrop >= params.dropGateK * OCCLUSION_DROP_RATIO * lostScale;
      if (occlusionGateOk) {
        if (params.mode === 'ritual' && (next.phase === 'DESCENDING' || next.phase === 'KNEELING')) {
          next.phase = 'BOTTOM';
          next.phaseStartedAt = now;
          next.occlusionBottom = true;
          next.isBowed = true;
        } else if (params.mode === 'prostration' && next.phase === 'READY' && next.cycleArmed) {
          next.phase = 'PROSTRATION_BOTTOM';
          next.phaseStartedAt = now;
          next.occlusionBottom = true;
          next.isBowed = true;
        }
      }
    }
    if (next.phase !== 'READY' && now - next.phaseStartedAt >= phaseTimeoutFor(next.phase, params)) {
      const reset = recalibrate(next, now, null);
      return {state: reset, counted: false, calibrated: false, debug: makeDebug(reset, true)};
    }
    return {state: next, counted: false, calibrated: false, debug: makeDebug(next, true)};
  }

  // ---- 信号平滑与 min/max 学习 ----
  const filteredBodyY =
    prev.smoothedBodyY === null ? signal.bodyY : prev.smoothedBodyY * 0.5 + signal.bodyY * 0.5;
  next.smoothedBodyY = filteredBodyY;

  if (signal.bodyScale !== null) {
    next.smoothedBodyScale =
      prev.smoothedBodyScale === null
        ? signal.bodyScale
        : prev.smoothedBodyScale * (1 - SCALE_SMOOTHING_ALPHA) +
          signal.bodyScale * SCALE_SMOOTHING_ALPHA;
  }

  const delta = prev.lastBodyY === null ? 0 : Math.abs(filteredBodyY - prev.lastBodyY);
  next.lastBodyY = filteredBodyY;
  next.stableFrames = delta < params.stableDelta ? prev.stableFrames + 1 : 0;

  let minY = Math.min(1, prev.minY + ratios.decay);
  let maxY = Math.max(0, prev.maxY - ratios.decay);
  if (filteredBodyY < minY) {
    minY = filteredBodyY;
  }
  if (filteredBodyY > maxY) {
    maxY = filteredBodyY;
  }
  if (maxY - minY > AMPLITUDE_CAP) {
    if (filteredBodyY - minY > maxY - filteredBodyY) {
      minY = maxY - AMPLITUDE_CAP;
    } else {
      maxY = minY + AMPLITUDE_CAP;
    }
  }
  next.minY = minY;
  next.maxY = maxY;
  const amplitude = maxY - minY;

  // ---- 姿态判定（有基线用绝对，无基线退相对）----
  const baselineY = next.standingBodyY;
  const scale = next.baselineBodyScale;
  const readyCeiling =
    baselineY !== null && scale !== null ? baselineY + params.recoveryTolerance * scale : null;
  const hasBaseline = readyCeiling !== null;

  const standingRel = filteredBodyY <= minY + amplitude * ratios.standing * params.recoveryBias;
  const standingPose = readyCeiling !== null ? filteredBodyY <= readyCeiling : standingRel;
  const prostrationReadyRel =
    filteredBodyY <= minY + amplitude * ratios.prostrationReady * params.recoveryBias;
  const prostrationReadyPose =
    readyCeiling !== null ? filteredBodyY <= readyCeiling : prostrationReadyRel;

  const bowingPose = filteredBodyY >= minY + amplitude * ratios.bow;
  const kneelingPose = filteredBodyY >= minY + amplitude * ratios.kneel;

  if (next.cycleArmed) {
    next.cycleMaxBodyY =
      next.cycleMaxBodyY === null ? filteredBodyY : Math.max(next.cycleMaxBodyY, filteredBodyY);
  } else {
    next.cycleMaxBodyY = null;
  }

  const drop =
    next.cycleMaxBodyY !== null && baselineY !== null ? next.cycleMaxBodyY - baselineY : null;
  const nearCycleMax =
    next.cycleMaxBodyY !== null &&
    filteredBodyY >= next.cycleMaxBodyY - Math.max(0.15 * amplitude, 0.04);
  const dropGate = scale !== null ? params.dropGateK * scale : null;
  const bottomAbs = drop !== null && dropGate !== null && drop >= dropGate && nearCycleMax;

  const bottomRel = filteredBodyY >= maxY - amplitude * ratios.bottom * params.bottomDepthBias;
  const bottomPose = hasBaseline ? bottomAbs : bottomRel;
  const prostrationBottomRel =
    filteredBodyY >= maxY - amplitude * ratios.prostrationBottom * params.bottomDepthBias;
  const prostrationBottomPose = hasBaseline ? bottomAbs : prostrationBottomRel;

  const risingRel = filteredBodyY <= maxY - amplitude * ratios.rising * params.recoveryBias;
  const risingAbs =
    next.cycleMaxBodyY !== null &&
    drop !== null &&
    filteredBodyY <= next.cycleMaxBodyY - 0.25 * Math.max(drop, 0.01);
  const risingPose = hasBaseline ? risingAbs : risingRel;

  next.standingFrames = standingPose ? prev.standingFrames + 1 : 0;
  next.descentFrames = bowingPose ? prev.descentFrames + 1 : 0;
  next.kneelingFrames = kneelingPose ? prev.kneelingFrames + 1 : 0;
  next.bottomFrames = bottomPose ? prev.bottomFrames + 1 : 0;
  next.prostrationBottomFrames = prostrationBottomPose ? prev.prostrationBottomFrames + 1 : 0;
  next.risingFrames = risingPose ? prev.risingFrames + 1 : 0;
  next.recoveryFrames = prostrationReadyPose ? prev.recoveryFrames + 1 : 0;

  // ---- 基线自动学习（READY 稳定时慢速 EMA）----
  const readyPose = params.mode === 'ritual' ? standingPose : prostrationReadyPose;
  const readyFrames = params.mode === 'ritual' ? next.standingFrames : next.recoveryFrames;
  if (next.phase === 'READY' && readyPose && readyFrames >= 3) {
    next.standingBodyY =
      next.standingBodyY === null
        ? filteredBodyY
        : next.standingBodyY * (1 - BASELINE_EMA_ALPHA) + filteredBodyY * BASELINE_EMA_ALPHA;
    if (next.smoothedBodyScale !== null) {
      next.baselineBodyScale =
        next.baselineBodyScale === null
          ? next.smoothedBodyScale
          : next.baselineBodyScale * (1 - BASELINE_EMA_ALPHA) +
            next.smoothedBodyScale * BASELINE_EMA_ALPHA;
    }
  }

  // ---- 自动校准与解卡超时 ----
  const shouldAutoCalibrate =
    now - next.lastCalibrationAt >= params.autoCalibrationIntervalMs &&
    next.stableFrames >= params.stableFrameCount &&
    readyPose &&
    next.phase === 'READY' &&
    !next.cycleArmed;
  const phaseTimedOut =
    next.phase !== 'READY' && now - next.phaseStartedAt >= phaseTimeoutFor(next.phase, params);
  if (phaseTimedOut || shouldAutoCalibrate) {
    const reset = recalibrate(next, now, filteredBodyY);
    reset.cycleArmed = readyPose;
    return {state: reset, counted: false, calibrated: false, debug: makeDebug(reset, false)};
  }

  // ---- 状态机 ----
  const transition = (phase: MotionPhase) => {
    if (next.phase !== phase) {
      next.phase = phase;
      next.phaseStartedAt = now;
    }
  };
  const finishCycle = (success: boolean) => {
    counted = success && passesDropGate(next, params);
    transition('READY');
    next.cycleArmed = false;
    next.cycleMaxBodyY = null;
    next.occlusionBottom = false;
    next.isBowed = false;
  };

  const hasRange = amplitude > params.minAmplitude;

  if (params.mode === 'prostration') {
    if (!hasBaseline && !hasRange) {
      if (next.recoveryFrames >= 2) {
        next.cycleArmed = true;
      }
      next.isBowed = false;
    } else {
      if (next.phase !== 'READY' && next.phase !== 'PROSTRATION_BOTTOM') {
        transition('READY');
      }
      if (next.phase === 'READY') {
        next.isBowed = false;
        if (next.recoveryFrames >= 2) {
          next.cycleArmed = true;
        }
        if (next.cycleArmed && next.prostrationBottomFrames >= 2 && hasRange) {
          transition('PROSTRATION_BOTTOM');
          next.isBowed = true;
        }
      } else {
        next.isBowed = true;
        if (next.recoveryFrames >= 2) {
          finishCycle(true);
        }
      }
    }
  } else if (!hasBaseline && !hasRange) {
    if (next.standingFrames >= 3) {
      next.cycleArmed = true;
    }
    next.isBowed = false;
  } else {
    switch (next.phase) {
      case 'READY':
        next.isBowed = false;
        if (next.standingFrames >= 3) {
          next.cycleArmed = true;
        }
        if (next.cycleArmed && next.descentFrames >= 2 && hasRange) {
          transition('DESCENDING');
          next.isBowed = true;
        }
        break;
      case 'DESCENDING':
        next.isBowed = true;
        if (next.kneelingFrames >= 2) {
          transition('KNEELING');
        } else if (next.standingFrames >= 2) {
          finishCycle(false);
        }
        break;
      case 'KNEELING':
        next.isBowed = true;
        if (next.bottomFrames >= 2) {
          transition('BOTTOM');
        } else if (next.standingFrames >= 2) {
          finishCycle(false);
        }
        break;
      case 'BOTTOM':
        next.isBowed = true;
        if (next.risingFrames >= 2) {
          transition('ASCENDING');
        }
        break;
      case 'ASCENDING':
        next.isBowed = true;
        if (next.standingFrames >= 2) {
          finishCycle(true);
        } else if (next.bottomFrames >= 2) {
          transition('BOTTOM');
        }
        break;
      case 'PROSTRATION_BOTTOM':
        finishCycle(false);
        break;
    }
  }

  return {state: next, counted, calibrated: false, debug: makeDebug(next, false)};
}

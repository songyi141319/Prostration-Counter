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
  cycleStartBodyY: number | null;
  cycleLeftReadyAt: number | null;
  recoveredFrames: number;
  pendingBodyY: number | null;
  pendingFrames: number;
  scaleOutlierFrames: number;
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
// —— v3 夜间鲁棒性 ——
// 单帧位移超过此值视为关键点错乱（瞬移），按信号丢失处理
const JUMP_REJECT_THRESHOLD = 0.22;
// 被拒位置若连续多帧互差在此带宽内，视为真实的新位置（断层后续上）
const JUMP_CONSISTENCY_BAND = 0.1;
const JUMP_ACCEPT_FRAMES = 3;
// 肩宽相对平滑值的合法比值区间；区间外连续多帧才接受（真实距离变化）
const SCALE_REJECT_LOW = 0.55;
const SCALE_REJECT_HIGH = 1.8;
const SCALE_ACCEPT_FRAMES = 8;
// 门槛计算中肩宽的下限，防止退化
const MIN_BODY_SCALE = 0.05;
// 起身回到本周期行程的此比例即认可回正（与绝对基线判定取或）
const RECOVERY_FRACTION = 0.7;
// 离开预备位到计数的最短时长，防噪声抖动凑出一拜
const MIN_CYCLE_MS = 600;
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
    cycleStartBodyY: null,
    cycleLeftReadyAt: null,
    recoveredFrames: 0,
    pendingBodyY: null,
    pendingFrames: 0,
    scaleOutlierFrames: 0,
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
  // 优先用本周期快照作顶部参照（全局基线可能被夜间噪声污染）
  const top = state.cycleStartBodyY ?? state.standingBodyY;
  if (top === null || state.baselineBodyScale === null) {
    return true;
  }
  if (state.cycleMaxBodyY === null) {
    return false;
  }
  const drop = state.cycleMaxBodyY - top;
  const gateScale = Math.max(state.baselineBodyScale, MIN_BODY_SCALE);
  const gateK = state.occlusionBottom ? params.dropGateK * OCCLUSION_DROP_RATIO : params.dropGateK;
  return drop >= gateK * gateScale;
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

  // ---- 跳变滤波：剔除单帧不可能的位移（夜间关键点错乱的典型形态）----
  let effectiveBodyY = signal.bodyY;
  let snapped = false;
  if (effectiveBodyY !== null && prev.smoothedBodyY !== null) {
    const jumpDistance = Math.abs(effectiveBodyY - prev.smoothedBodyY);
    if (jumpDistance > JUMP_REJECT_THRESHOLD) {
      const consistentWithPending =
        prev.pendingBodyY !== null &&
        Math.abs(effectiveBodyY - prev.pendingBodyY) <= JUMP_CONSISTENCY_BAND;
      if (consistentWithPending && prev.pendingFrames + 1 >= JUMP_ACCEPT_FRAMES) {
        // 新位置连续多帧自洽：承认为真实位置，直接续上（动作断层后的衔接）
        next.pendingBodyY = null;
        next.pendingFrames = 0;
        snapped = true;
      } else {
        next.pendingBodyY = effectiveBodyY;
        next.pendingFrames = consistentWithPending ? prev.pendingFrames + 1 : 1;
        effectiveBodyY = null;
      }
    } else {
      next.pendingBodyY = null;
      next.pendingFrames = 0;
    }
  }

  // ---- 可见性软闸门 ----
  if (effectiveBodyY === null) {
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
    const lostTopY = next.cycleStartBodyY ?? next.standingBodyY;
    const lostScale = next.baselineBodyScale;
    const lostCycleMax = next.cycleMaxBodyY;
    if (
      lostTopY !== null &&
      lostScale !== null &&
      lostCycleMax !== null &&
      beyondHold >= params.lostBottomFrames
    ) {
      const preDrop = lostCycleMax - lostTopY;
      const occlusionGateOk =
        preDrop >= params.dropGateK * OCCLUSION_DROP_RATIO * Math.max(lostScale, MIN_BODY_SCALE);
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
  // 断层续上（snapped）时跳过平滑直接采用新位置，避免数帧的拖尾假轨迹
  const filteredBodyY =
    prev.smoothedBodyY === null || snapped
      ? effectiveBodyY
      : prev.smoothedBodyY * 0.5 + effectiveBodyY * 0.5;
  next.smoothedBodyY = filteredBodyY;

  // 肩宽突变剔除：一团错乱点的肩宽会瞬间塌缩/暴涨，区间外连续多帧才接受
  if (signal.bodyScale !== null) {
    const scaleRatio =
      prev.smoothedBodyScale === null ? 1 : signal.bodyScale / prev.smoothedBodyScale;
    if (
      prev.smoothedBodyScale !== null &&
      (scaleRatio < SCALE_REJECT_LOW || scaleRatio > SCALE_REJECT_HIGH)
    ) {
      next.scaleOutlierFrames = prev.scaleOutlierFrames + 1;
      if (next.scaleOutlierFrames >= SCALE_ACCEPT_FRAMES) {
        next.smoothedBodyScale = signal.bodyScale;
        next.scaleOutlierFrames = 0;
      }
    } else {
      next.smoothedBodyScale =
        prev.smoothedBodyScale === null
          ? signal.bodyScale
          : prev.smoothedBodyScale * (1 - SCALE_SMOOTHING_ALPHA) +
            signal.bodyScale * SCALE_SMOOTHING_ALPHA;
      next.scaleOutlierFrames = 0;
    }
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
  const gateScale = scale !== null ? Math.max(scale, MIN_BODY_SCALE) : null;
  const readyCeiling =
    baselineY !== null && gateScale !== null
      ? baselineY + params.recoveryTolerance * gateScale
      : null;
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
    next.cycleStartBodyY = null;
    next.cycleLeftReadyAt = null;
  }

  // 本周期下降量优先（周期快照不受全局基线污染影响），无快照时回退全局基线
  const cycleTopY = next.cycleStartBodyY ?? baselineY;
  const drop =
    next.cycleMaxBodyY !== null && cycleTopY !== null ? next.cycleMaxBodyY - cycleTopY : null;
  const nearCycleMax =
    next.cycleMaxBodyY !== null &&
    filteredBodyY >= next.cycleMaxBodyY - Math.max(0.15 * amplitude, 0.04);
  const dropGate = gateScale !== null ? params.dropGateK * gateScale : null;
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

  // 周期快照：仅在 READY 阶段的预备位更新顶部参照；离开预备位即冻结并记录时刻。
  // 不能在中后段阶段更新，否则起身回位瞬间会先于计数把快照/时刻抹掉。
  if (next.cycleArmed && next.phase === 'READY' && readyPose) {
    if (readyFrames >= 2) {
      // 回到预备位并站稳：重新进入待拜状态
      next.cycleLeftReadyAt = null;
    }
    if (next.cycleLeftReadyAt === null) {
      next.cycleStartBodyY = filteredBodyY;
    }
  } else if (next.cycleArmed && !readyPose && next.cycleLeftReadyAt === null) {
    next.cycleLeftReadyAt = now;
  }

  // 双路回正：绝对基线带 或 回到本周期行程 70% 以上（基线被污染时的容错路径）
  const cycleRecovered =
    next.cycleMaxBodyY !== null &&
    drop !== null &&
    drop > 0.05 &&
    filteredBodyY <= next.cycleMaxBodyY - RECOVERY_FRACTION * drop;
  next.recoveredFrames = readyPose || cycleRecovered ? prev.recoveredFrames + 1 : 0;
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
    if (success) {
      // 时间维度：离开预备位到计数须达到最短时长，防噪声抖动凑出一拜
      const cycleLongEnough =
        next.cycleLeftReadyAt !== null && now - next.cycleLeftReadyAt >= MIN_CYCLE_MS;
      counted = cycleLongEnough && passesDropGate(next, params);
      // 靠比例回正计数而绝对回正未达成 = 全局基线已不可达（被夜间噪声拉偏）→ 重锚自愈
      if (counted && !readyPose) {
        next.standingBodyY = filteredBodyY;
      }
    }
    transition('READY');
    next.cycleArmed = false;
    next.cycleMaxBodyY = null;
    next.cycleStartBodyY = null;
    next.cycleLeftReadyAt = null;
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
        if (next.recoveredFrames >= 2) {
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
        if (next.recoveredFrames >= 2) {
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

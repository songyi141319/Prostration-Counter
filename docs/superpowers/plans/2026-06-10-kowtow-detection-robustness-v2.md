# 大拜计数器识别鲁棒性重构 v2 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-06-10-kowtow-detection-robustness-v2-design.md` 重构识别核心，根治「鞠躬误计 / 到底丢人漏计 / 起身早计」。

**Architecture:** 把识别核心从 `KowtowCounter.tsx` 的 `renderLoop` 抽成纯函数模块 `src/components/kowtowDetection.ts`（信号提取 `computeBodySignal` + 不可变 reducer `advanceDetection`），组件只负责取流、绘制、调用 reducer 和 UI。纯函数模块用 vitest 做单元测试（模拟逐帧序列）。

**Tech Stack:** React 19 + TypeScript 5.8 + Vite 6 + @mediapipe/tasks-vision + vitest（新增 devDependency）。

**当前工作区注意：** `src/components/KowtowCounter.tsx` 有 9 行未完成的脏改动（引用未定义的 `bodyScaleRef` 等，编译不过）。Task 4 的整段替换会覆盖它们，无需单独 revert。`public/wasm/*.js` 的改动只是换行符差异，不要提交。

---

## 背景速览（给零上下文的工程师）

- 应用是「大拜计数器」：手机摄像头 + MediaPipe Pose 检测用户磕大头/磕头动作并计数。
- 现有识别只跟踪鼻子的归一化 y 坐标（0=画面顶部，1=底部，**y 越大人越低**），阈值全部是动态学习的 min/max 幅度的百分比，并有可见性硬闸门。三类 bug 根因见设计文档第二节。
- 修复思路：多点加权高度 `bodyY` + 站立基线/肩宽绝对尺度 + 「整人消失≥N帧=到底」+ 起身判定绝对化 + 可选手动校准。
- 验证命令：`npm run lint`（即 `tsc --noEmit`）、`npm test`（本计划新增，vitest）。
- 所有 npm 命令在仓库根 `D:\CODE-workspace\CODEX\repo_songyi141319_dash` 执行。

---

### Task 1: 安装 vitest 并加 test 脚本

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装 vitest**

Run: `npm install -D vitest`
Expected: package.json devDependencies 出现 `"vitest": "^..."`，无报错。

- [ ] **Step 2: 加 test 脚本**

在 `package.json` 的 `scripts` 中（`"lint": "tsc --noEmit"` 之后）加：

```json
    "lint": "tsc --noEmit",
    "test": "vitest run"
```

- [ ] **Step 3: 验证 vitest 可运行**

Run: `npm test`
Expected: 输出 "No test files found"（退出码非 0 没关系，说明 vitest 正常启动）。

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add vitest for detection unit tests"
```

---

### Task 2: 信号提取 computeBodySignal（TDD）

**Files:**
- Create: `src/components/kowtowDetection.ts`（本任务只写类型 + `computeBodySignal`）
- Create: `src/components/__tests__/kowtowDetection.signal.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `src/components/__tests__/kowtowDetection.signal.test.ts`：

```ts
import {describe, expect, it} from 'vitest';
import {computeBodySignal, type LandmarkPoint} from '../kowtowDetection';

function emptyLandmarks(): LandmarkPoint[] {
  return Array.from({length: 33}, () => ({x: 0.5, y: 0.5, visibility: 0}));
}

describe('computeBodySignal', () => {
  it('空输入返回 null 信号', () => {
    expect(computeBodySignal(null)).toEqual({bodyY: null, bodyScale: null});
    expect(computeBodySignal([])).toEqual({bodyY: null, bodyScale: null});
  });

  it('头部点按可见度加权平均', () => {
    const landmarks = emptyLandmarks();
    landmarks[0] = {x: 0.5, y: 0.2, visibility: 0.9};
    landmarks[7] = {x: 0.45, y: 0.3, visibility: 0.6};
    landmarks[8] = {x: 0.55, y: 0.3, visibility: 0.6};
    const expected = (0.2 * 0.9 + 0.3 * 0.6 + 0.3 * 0.6) / (0.9 + 0.6 + 0.6);
    expect(computeBodySignal(landmarks).bodyY).toBeCloseTo(expected, 5);
  });

  it('可见度不高于 0.4 的头部点被排除', () => {
    const landmarks = emptyLandmarks();
    landmarks[0] = {x: 0.5, y: 0.2, visibility: 0.9};
    landmarks[2] = {x: 0.48, y: 0.9, visibility: 0.4};
    expect(computeBodySignal(landmarks).bodyY).toBeCloseTo(0.2, 5);
  });

  it('头部点全部不可见时回退到肩部', () => {
    const landmarks = emptyLandmarks();
    landmarks[11] = {x: 0.4, y: 0.45, visibility: 0.8};
    landmarks[12] = {x: 0.6, y: 0.45, visibility: 0.8};
    expect(computeBodySignal(landmarks).bodyY).toBeCloseTo(0.45, 5);
  });

  it('全部点不可见时 bodyY 为 null', () => {
    expect(computeBodySignal(emptyLandmarks()).bodyY).toBeNull();
  });

  it('双肩可见时 bodyScale = 肩宽', () => {
    const landmarks = emptyLandmarks();
    landmarks[0] = {x: 0.5, y: 0.2, visibility: 0.9};
    landmarks[11] = {x: 0.4, y: 0.45, visibility: 0.8};
    landmarks[12] = {x: 0.6, y: 0.45, visibility: 0.8};
    expect(computeBodySignal(landmarks).bodyScale).toBeCloseTo(0.2, 5);
  });

  it('单肩不可见时 bodyScale 为 null', () => {
    const landmarks = emptyLandmarks();
    landmarks[0] = {x: 0.5, y: 0.2, visibility: 0.9};
    landmarks[11] = {x: 0.4, y: 0.45, visibility: 0.8};
    landmarks[12] = {x: 0.6, y: 0.45, visibility: 0.3};
    expect(computeBodySignal(landmarks).bodyScale).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，报错为找不到模块 `../kowtowDetection`。

- [ ] **Step 3: 写实现**

创建 `src/components/kowtowDetection.ts`：

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 7 个测试全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/kowtowDetection.ts src/components/__tests__/kowtowDetection.signal.test.ts
git commit -m "feat: multi-point body signal extraction for kowtow detection"
```

---

### Task 3: 识别 reducer advanceDetection（TDD）

**Files:**
- Modify: `src/components/kowtowDetection.ts`（追加 reducer）
- Create: `src/components/__tests__/kowtowDetection.machine.test.ts`

- [ ] **Step 1: 写失败的行为测试**

创建 `src/components/__tests__/kowtowDetection.machine.test.ts`。
帧序列约定：肩宽 0.2，站立 bodyY=0.2；ritual 绝对门槛 = 1.1×0.2 = 0.22。

```ts
import {describe, expect, it} from 'vitest';
import {
  advanceDetection,
  createDetectionState,
  startCalibration,
  type DetectionParams,
  type DetectionState,
  type FrameSignal,
} from '../kowtowDetection';

const FRAME_MS = 33;

const ritualParams: DetectionParams = {
  mode: 'ritual',
  perspective: 'front',
  autoCalibrationIntervalMs: 3000,
  stableFrameCount: 4,
  stableDelta: 0.009,
  minAmplitude: 0.12,
  bottomDepthBias: 1,
  recoveryBias: 1,
  phaseTimeoutMs: 10000,
  dropGateK: 1.1,
  holdFrames: 6,
  lostBottomFrames: 4,
  recoveryTolerance: 0.35,
};

const prostrationParams: DetectionParams = {
  ...ritualParams,
  mode: 'prostration',
  minAmplitude: 0.08,
  phaseTimeoutMs: 6000,
  dropGateK: 0.55,
};

type Sim = {state: DetectionState; now: number};

function createSim(): Sim {
  return {state: createDetectionState(0), now: 0};
}

function signalAt(bodyY: number | null, bodyScale: number | null = 0.2): FrameSignal {
  return {bodyY, bodyScale};
}

function feed(sim: Sim, signal: FrameSignal, frames: number, params: DetectionParams) {
  let counted = 0;
  let calibrated = 0;
  for (let i = 0; i < frames; i += 1) {
    sim.now += FRAME_MS;
    const result = advanceDetection(sim.state, signal, sim.now, params);
    sim.state = result.state;
    if (result.counted) counted += 1;
    if (result.calibrated) calibrated += 1;
  }
  return {counted, calibrated};
}

describe('advanceDetection · 基线学习', () => {
  it('站立稳定后学到 standingBodyY 与 baselineBodyScale', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    expect(sim.state.standingBodyY).not.toBeNull();
    expect(sim.state.standingBodyY as number).toBeCloseTo(0.2, 2);
    expect(sim.state.baselineBodyScale as number).toBeCloseTo(0.2, 2);
  });
});

describe('advanceDetection · ritual 完整大拜', () => {
  it('深度足够的完整一拜计 1 次', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    const down = feed(sim, signalAt(0.85), 20, ritualParams);
    const up = feed(sim, signalAt(0.2), 20, ritualParams);
    expect(down.counted + up.counted).toBe(1);
    expect(sim.state.phase).toBe('READY');
  });

  it('连续三拜计 3 次', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    let total = 0;
    for (let i = 0; i < 3; i += 1) {
      total += feed(sim, signalAt(0.85), 20, ritualParams).counted;
      total += feed(sim, signalAt(0.2), 20, ritualParams).counted;
    }
    expect(total).toBe(3);
  });

  it('浅鞠躬（drop < K×肩宽）不计数', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    const down = feed(sim, signalAt(0.38), 15, ritualParams);
    const up = feed(sim, signalAt(0.2), 15, ritualParams);
    expect(down.counted + up.counted).toBe(0);
  });

  it('起身到一半（未回到基线附近）不提前计数', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    feed(sim, signalAt(0.85), 20, ritualParams);
    const half = feed(sim, signalAt(0.4), 20, ritualParams);
    expect(half.counted).toBe(0);
    const full = feed(sim, signalAt(0.2), 15, ritualParams);
    expect(full.counted).toBe(1);
  });
});

describe('advanceDetection · 消失即到底', () => {
  it('下行后整人丢失再回到站立，仍计 1 次', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    // 只喂 2 帧：状态机停在 KNEELING（再多会经绝对深度路径自行到 BOTTOM，测不到遮挡路径）
    feed(sim, signalAt(0.85), 2, ritualParams);
    const lostResult = feed(sim, signalAt(null, null), 14, ritualParams);
    expect(sim.state.phase).toBe('BOTTOM');
    expect(sim.state.occlusionBottom).toBe(true);
    const up = feed(sim, signalAt(0.2), 20, ritualParams);
    expect(lostResult.counted + up.counted).toBe(1);
  });

  it('站立时信号丢失不会误入到底', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    feed(sim, signalAt(null, null), 14, ritualParams);
    expect(sim.state.phase).toBe('READY');
    const back = feed(sim, signalAt(0.2), 10, ritualParams);
    expect(back.counted).toBe(0);
  });
});

describe('advanceDetection · prostration 磕头', () => {
  it('磕到底再起身计 1 次', () => {
    const sim = createSim();
    feed(sim, signalAt(0.3), 10, prostrationParams);
    const down = feed(sim, signalAt(0.6), 15, prostrationParams);
    const up = feed(sim, signalAt(0.3), 15, prostrationParams);
    expect(down.counted + up.counted).toBe(1);
  });

  it('轻微点头（drop < K×肩宽）不计数', () => {
    const sim = createSim();
    feed(sim, signalAt(0.3), 10, prostrationParams);
    const down = feed(sim, signalAt(0.36), 15, prostrationParams);
    const up = feed(sim, signalAt(0.3), 15, prostrationParams);
    expect(down.counted + up.counted).toBe(0);
  });
});

describe('advanceDetection · 校准与超时', () => {
  it('手动校准锁定基线并发出 calibrated 事件', () => {
    let sim = createSim();
    sim.state = startCalibration(sim.state, sim.now);
    const result = feed(sim, signalAt(0.25, 0.24), 120, ritualParams);
    expect(result.calibrated).toBe(1);
    expect(sim.state.standingBodyY as number).toBeCloseTo(0.25, 3);
    expect(sim.state.baselineBodyScale as number).toBeCloseTo(0.24, 3);
    expect(result.counted).toBe(0);
  });

  it('阶段超时后复位但保留基线', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    const baseline = sim.state.standingBodyY;
    feed(sim, signalAt(0.5), 320, ritualParams);
    expect(sim.state.phase).toBe('READY');
    expect(sim.state.standingBodyY).not.toBeNull();
    expect(baseline).not.toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: machine 测试全部 FAIL（`advanceDetection` 等未导出）；signal 测试仍 PASS。

- [ ] **Step 3: 实现 reducer**

在 `src/components/kowtowDetection.ts` 末尾追加（完整代码）：

```ts
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
    if (next.phase !== 'READY' && now - next.phaseStartedAt >= params.phaseTimeoutMs) {
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

  const drop = next.cycleMaxBodyY !== null && baselineY !== null ? next.cycleMaxBodyY - baselineY : null;
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
    next.phase !== 'READY' && now - next.phaseStartedAt >= params.phaseTimeoutMs;
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 全部测试 PASS（signal 7 个 + machine 10 个）。
若个别行为测试因帧数/阈值微调不过：优先核对测试序列是否给足了「2 帧确认」所需帧数，再核对实现；不要为凑测试削弱绝对门槛逻辑。

- [ ] **Step 5: lint**

Run: `npm run lint`
Expected: 0 错误（此时 KowtowCounter.tsx 仍有残缺 9 行会报错——若报错仅来自 KowtowCounter.tsx 的 `bodyScaleRef` 等未定义引用，属预期，Task 4 解决；kowtowDetection 相关必须 0 错误）。

- [ ] **Step 6: Commit**

```bash
git add src/components/kowtowDetection.ts src/components/__tests__/kowtowDetection.machine.test.ts
git commit -m "feat: detection reducer with absolute drop gate and occlusion-bottom"
```

---

### Task 4: 组件接线 + UI（KowtowCounter.tsx）

**Files:**
- Modify: `src/components/KowtowCounter.tsx`

本任务把组件里的旧识别逻辑整体替换为模块调用。共 8 处编辑，全部完成后再统一跑 lint/test。

- [ ] **Step 1: 替换 import 与本地类型**

文件顶部 `import {DrawingUtils, ...}` 之后加：

```ts
import {
  advanceDetection,
  computeBodySignal,
  createDetectionState,
  startCalibration,
  type CountMode,
  type DetectionParams,
  type DetectionState,
  type PerspectiveMode,
} from './kowtowDetection';
```

删除本地类型声明（约 20-28 行）：

```ts
type MotionPhase =
  | 'READY'
  | 'DESCENDING'
  | 'KNEELING'
  | 'BOTTOM'
  | 'ASCENDING'
  | 'PROSTRATION_BOTTOM';
type CountMode = 'ritual' | 'prostration';
type PerspectiveMode = 'front' | 'side';
```

（保留 `PreviewMode`、`SoundStyle` 等其余本地类型。）

- [ ] **Step 2: 扩展 TuningSettings 类型与默认值**

`TuningSettings` 类型末尾（`phaseTimeoutProstrationMs: number;` 之后）追加：

```ts
  ritualDropKFront: number;
  ritualDropKSide: number;
  prostrationDropKFront: number;
  prostrationDropKSide: number;
  holdFrames: number;
  lostBottomFrames: number;
  recoveryTolerance: number;
```

`DEFAULT_TUNING_SETTINGS` 末尾（`phaseTimeoutProstrationMs: 6000,` 之后）追加：

```ts
  ritualDropKFront: 1.1,
  ritualDropKSide: 0.9,
  prostrationDropKFront: 0.55,
  prostrationDropKSide: 0.5,
  holdFrames: 6,
  lostBottomFrames: 4,
  recoveryTolerance: 0.35,
```

- [ ] **Step 3: TUNING_SECTIONS 增加两个分区**

在 `TUNING_SECTIONS` 数组的「解卡」分区对象之后追加两个分区：

```ts
  {
    title: '绝对深度门槛',
    hint: '以肩宽为尺子衡量“要下降多深才算一次有效动作”，鞠躬等浅动作达不到就不会计数。',
    fields: [
      {
        key: 'ritualDropKFront',
        label: '正拍大拜深度系数',
        min: 0.5,
        max: 2.5,
        step: 0.05,
        description: '完整礼拜模式下，头部下降深度与肩宽的最小比值。',
        effect: '调小更容易计数；调大更严格、误计更少。',
      },
      {
        key: 'ritualDropKSide',
        label: '侧拍大拜深度系数',
        min: 0.4,
        max: 2.5,
        step: 0.05,
        description: '侧拍完整礼拜的深度比值要求。',
        effect: '调小更灵敏；调大更严格。',
      },
      {
        key: 'prostrationDropKFront',
        label: '正拍磕头深度系数',
        min: 0.2,
        max: 1.5,
        step: 0.05,
        description: '磕头模式下，头部下降深度与肩宽的最小比值。',
        effect: '调小更灵敏；调大点头不会被算进去。',
      },
      {
        key: 'prostrationDropKSide',
        label: '侧拍磕头深度系数',
        min: 0.2,
        max: 1.5,
        step: 0.05,
        description: '侧拍磕头的深度比值要求。',
        effect: '调小更灵敏；调大更严格。',
      },
    ],
  },
  {
    title: '遮挡与丢失',
    hint: '近镜头趴到底时人会出画面，这里控制“消失多久算到底”以及信号短暂丢失的容忍度。',
    fields: [
      {
        key: 'holdFrames',
        label: '信号保持帧数',
        min: 2,
        max: 20,
        step: 1,
        description: '人体关键点短暂丢失时，沿用上一帧高度的最大帧数。',
        effect: '调大抗闪烁更强；调大过头会延迟“消失判到底”。',
      },
      {
        key: 'lostBottomFrames',
        label: '消失判到底帧数',
        min: 2,
        max: 15,
        step: 1,
        description: '已确认下行后，整个人持续消失多少帧就直接判定“已到底”。',
        effect: '调小漏计更少；调大更保守。',
      },
      {
        key: 'recoveryTolerance',
        label: '回正容差系数',
        min: 0.15,
        max: 0.8,
        step: 0.05,
        description: '判定“已回到站立/跪坐基线”时允许的高度误差（相对肩宽）。',
        effect: '调大更容易判回正；调小必须起得更到位。',
      },
    ],
  },
```

- [ ] **Step 4: 替换运动追踪 refs**

删除以下 refs（约 259-274 行）：

```ts
  const lastCalibrationAtRef = useRef(0);
  const phaseStartedAtRef = useRef(0);
  const stableFramesRef = useRef(0);
  const lastFilteredNoseYRef = useRef<number | null>(null);
  const motionPhaseRef = useRef<MotionPhase>('READY');
  const cycleArmedRef = useRef(false);
  const standingFramesRef = useRef(0);
  const descentFramesRef = useRef(0);
  const kneelingFramesRef = useRef(0);
  const bottomFramesRef = useRef(0);
  const prostrationBottomFramesRef = useRef(0);
  const risingFramesRef = useRef(0);
  const recoveryFramesRef = useRef(0);
  const smoothedNoseYRef = useRef<number | null>(null);
  const minNoseYRef = useRef(1.0);
  const maxNoseYRef = useRef(0.0);
```

在原位置加：

```ts
  const detectionStateRef = useRef<DetectionState>(createDetectionState(0));
```

（保留 `lastVideoTimeRef`、`previousCountRef`、`lastOrientationRef`、`rotatedCanvasRef`、`isBowedRef`、`requestRef`。）

在 `const [showDebug, setShowDebug] = useState(false);` 之后加：

```ts
  const [isCalibrating, setIsCalibrating] = useState(false);
```

- [ ] **Step 5: 重写 recalibrateMotionTracking 并新增软重置**

整体替换原 `recalibrateMotionTracking`（约 485-503 行）：

```ts
  const recalibrateMotionTracking = useCallback(
    (baseBodyY?: number, preserveBaselines = false) => {
      const prevState = detectionStateRef.current;
      const fresh = createDetectionState(performance.now(), baseBodyY ?? null);
      detectionStateRef.current = preserveBaselines
        ? {
            ...fresh,
            standingBodyY: prevState.standingBodyY,
            baselineBodyScale: prevState.baselineBodyScale,
            smoothedBodyScale: prevState.smoothedBodyScale,
          }
        : fresh;
      setIsCalibrating(false);
      updateBowed(false);
    },
    [updateBowed],
  );
```

在 `resetMotionTracking`（保持不变）之后新增软重置版本（暂停/继续计数时保留已校准基线，镜头位置没变基线仍有效）：

```ts
  const softResetMotionTracking = useCallback(() => {
    recalibrateMotionTracking(undefined, true);
    lastVideoTimeRef.current = -1;
    clearOverlay();
  }, [clearOverlay, recalibrateMotionTracking]);
```

并把 `handleToggleCounting` 内的两处 `resetMotionTracking()` 调用都改为 `softResetMotionTracking()`（模式/视角切换、摄像头启停、调参等仍用全量 `resetMotionTracking`）：

```ts
  const handleToggleCounting = () => {
    if (!isRunning) {
      return;
    }

    if (isCounting) {
      setIsCounting(false);
      softResetMotionTracking();
      return;
    }

    void ensureAudioContext();
    softResetMotionTracking();
    setIsCounting(true);
  };
```

- [ ] **Step 6: 重写 renderLoop 的识别段**

替换 `renderLoop` 中从 `if (!isCounting) {`（绘制骨架代码块之后，约 710 行）到状态机结尾 `} else if (isCounting) { updateBowed(false); }`（约 989 行）的整段。替换前的结构是：

```ts
        if (results.landmarks?.length) {
          const drawingUtils = new DrawingUtils(context);
          ...drawLandmarks/drawConnectors...

          if (!isCounting) { ... return; }
          const landmarks = results.landmarks[0];
          ...旧的鼻子追踪 + 阈值 + 状态机（含残缺的 bodyScaleRef 引用）...
        } else if (isCounting) {
          updateBowed(false);
        }
```

替换后（绘制部分保留不动，识别段全部换掉）：

```ts
        if (results.landmarks?.length) {
          const drawingUtils = new DrawingUtils(context);

          for (const landmark of results.landmarks) {
            drawingUtils.drawLandmarks(landmark, {
              radius: (data) => DrawingUtils.lerp(data.from!.z, -0.15, 0.1, 5, 1),
              color: '#34d399',
              lineWidth: 2,
            });
            drawingUtils.drawConnectors(landmark, PoseLandmarker.POSE_CONNECTIONS, {
              color: '#ffffff',
              lineWidth: 2,
            });
          }
        }

        if (isCounting || detectionStateRef.current.calibration) {
          const now = performance.now();
          const signal = computeBodySignal(results.landmarks?.[0] ?? null);
          const detectionParams: DetectionParams = {
            mode: countMode,
            perspective: perspectiveMode,
            autoCalibrationIntervalMs: tuning.autoCalibrationIntervalMs,
            stableFrameCount: tuning.stableFrameCount,
            stableDelta:
              perspectiveMode === 'side' ? tuning.sideStableDelta : tuning.frontStableDelta,
            minAmplitude:
              countMode === 'ritual'
                ? perspectiveMode === 'side'
                  ? tuning.ritualMinAmplitudeSide
                  : tuning.ritualMinAmplitudeFront
                : perspectiveMode === 'side'
                  ? tuning.prostrationMinAmplitudeSide
                  : tuning.prostrationMinAmplitudeFront,
            bottomDepthBias:
              countMode === 'ritual'
                ? tuning.ritualBottomDepthBias
                : tuning.prostrationBottomDepthBias,
            recoveryBias: tuning.recoveryBias,
            phaseTimeoutMs:
              countMode === 'ritual' ? tuning.phaseTimeoutRitualMs : tuning.phaseTimeoutProstrationMs,
            dropGateK:
              countMode === 'ritual'
                ? perspectiveMode === 'side'
                  ? tuning.ritualDropKSide
                  : tuning.ritualDropKFront
                : perspectiveMode === 'side'
                  ? tuning.prostrationDropKSide
                  : tuning.prostrationDropKFront,
            holdFrames: tuning.holdFrames,
            lostBottomFrames: tuning.lostBottomFrames,
            recoveryTolerance: tuning.recoveryTolerance,
          };

          const result = advanceDetection(detectionStateRef.current, signal, now, detectionParams);
          detectionStateRef.current = result.state;

          if (result.counted) {
            setCount((current) => current + 1);
          }
          if (result.calibrated) {
            setIsCalibrating(false);
            void playCountTickTone();
          }
          updateBowed(result.state.isBowed);

          if (showDebug && context) {
            const d = result.debug;
            const fmt = (value: number | null) => (value === null ? '--' : value.toFixed(3));
            context.save();
            context.font = `${Math.round(canvas.width * 0.032)}px monospace`;
            context.fillStyle = 'rgba(0,0,0,0.6)';
            context.fillRect(0, canvas.height - canvas.width * 0.28, canvas.width, canvas.width * 0.28);
            context.fillStyle = '#34d399';
            const lh = canvas.width * 0.038;
            const bx = canvas.width * 0.02;
            let by = canvas.height - canvas.width * 0.26;
            const lines = [
              `Phase: ${d.phase}  Armed: ${d.armed}`,
              `BodyY: ${fmt(d.bodyY)}  Scale: ${fmt(d.bodyScale)}`,
              `Base: ${fmt(d.standingBodyY)}  BaseScale: ${fmt(d.baselineBodyScale)}  Drop: ${fmt(d.drop)}`,
              `Min: ${fmt(d.minY)}  Max: ${fmt(d.maxY)}  Amp: ${fmt(d.amplitude)}`,
              `Lost: ${d.lost}  OcclusionBottom: ${d.occlusionBottom}`,
            ];
            for (const line of lines) {
              context.fillText(line, bx, by);
              by += lh;
            }
            context.restore();
          }
        }
```

同时把 `renderLoop` 的 useCallback 依赖数组改为：

```ts
  }, [countMode, isCounting, isRunning, perspectiveMode, playCountTickTone, previewMode, showDebug, tuning, updateBowed]);
```

（`recalibrateMotionTracking` 不再在循环里使用，移出依赖。）

- [ ] **Step 7: 手动校准入口**

在 `handleToggleCounting` 函数之后加：

```ts
  const handleStartCalibration = () => {
    if (!isRunning) {
      return;
    }

    void ensureAudioContext();
    detectionStateRef.current = startCalibration(detectionStateRef.current, performance.now());
    setIsCalibrating(true);
    setIsSettingsOpen(false);
  };
```

设置弹窗中「立即重新校准」按钮（`onClick={resetMotionTracking}` 那个）之后并排追加：

```tsx
                  <button
                    type="button"
                    onClick={handleStartCalibration}
                    disabled={!isRunning}
                    className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm font-semibold text-amber-100 transition-colors active:scale-95 disabled:opacity-40"
                  >
                    校准站立基线（站好 2 秒）
                  </button>
```

摄像头画面区角标区（`<div className="absolute left-3 top-3 z-20 flex flex-wrap gap-2">` 内最后一个角标之后）追加：

```tsx
                  {isCalibrating && (
                    <div className="rounded-full border border-amber-400/50 bg-amber-400/20 px-3 py-1 text-xs font-semibold text-amber-200">
                      校准中，请站好不动…
                    </div>
                  )}
```

- [ ] **Step 8: 验证编译与测试**

Run: `npm run lint`
Expected: 0 错误（残缺 9 行已被替换段覆盖）。

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 9: Commit**

```bash
git add src/components/KowtowCounter.tsx
git commit -m "fix: rewire kowtow counter to robust detection module with manual calibration"
```

---

### Task 5: 收尾验证

- [ ] **Step 1: 全量验证**

Run: `npm run lint`，再 `npm test`，再 `npm run build`
Expected: 三者全部成功（build 需要网络下载资源，若 `tsx download.ts` 因网络失败，单跑 `npx vite build` 验证打包）。

- [ ] **Step 2: 确认工作区干净度**

Run: `git status --short`
Expected: 仅剩 `public/wasm/*.js` 的换行符噪音（不提交）。如有其他未提交文件，检查是否遗漏。

- [ ] **Step 3: 手机/浏览器实测清单（需要用户配合，不阻塞合并）**

`npm run dev` 后用摄像头实测，开启「显示调试信息」：

1. 正拍 + 完整礼拜：完整大拜每次必计；趴底出画面不漏计（Debug 看 OcclusionBottom: true）。
2. 正拍 + 完整礼拜：只鞠躬 10 次 → 计数为 0。
3. 起身过程中数字不提前跳，回到站直才 +1。
4. 磕头模式：磕到底起身必计；轻微点头不计。
5. 侧拍模式重复 1、2。
6. 设置 → 校准站立基线：站好后听到木鱼音，Debug 的 Base 值更新。
7. 连续 20 拜不卡阶段；换站位后 3 秒内恢复正常。
```

# 智能姿态序列引擎实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增可与经典引擎自由切换的智能姿态序列引擎,通过多维姿态构型分类 + 序列状态机根治"放手机误计"与"单独弯腰误计",支持前缀补计且结构性防双计。

**Architecture:** 三层纯函数管线(特征提取 → 姿态分类 → 序列状态机),放在 `src/components/poseEngine/` 子目录,每帧由 `KowtowCounter.tsx` 的 renderLoop 调用,接口风格与经典引擎 `advanceDetection` 对齐。经典引擎代码零改动。

**Tech Stack:** TypeScript + React(现有)、MediaPipe Pose 33 关键点(现有)、vitest(现有,命令 `npm test`)、tsc(命令 `npm run lint`)。

**Spec:** `docs/superpowers/specs/2026-06-12-pose-sequence-engine-design.md`(必读,含两个 bug 的根因分析与全部设计决策)。

**仓库事实(执行前须知):**
- 仓库根:`D:\CODE-workspace\CODEX\repo_songyi141319_dash`,直接在 main 分支工作。
- 经典引擎:`src/components/kowtowDetection.ts`(导出 `LandmarkPoint`、`CountMode` 等类型,新引擎复用)。
- UI:`src/components/KowtowCounter.tsx`(1773 行,大文件是既有惯例,本计划只做增量插入,不重构)。
- 测试惯例:`src/components/__tests__/*.test.ts`,中文 describe,Sim/feed/ramp 帧驱动模式,FRAME_MS=33。
- 现有 tuning 无 localStorage 持久化 → 引擎选择同样只用 useState,不做持久化(YAGNI)。
- 工作区可能有无关未提交改动(public/wasm/*、docs/icon-candidates/)——**提交时只 add 本计划涉及的文件,绝不 `git add -A`**。

**MediaPipe 关键点索引(本计划用到):** 头部 0/2/5/7/8(鼻、左右眼、左右耳),左肩 11,右肩 12,左髋 23,右髋 24,左膝 25,右膝 26。y 归一化:0=画面顶,1=画面底。

---

## 核心算法约定(全部任务共用,执行者必读)

**为什么"竖直形态 + 整体下沉"能区分弯腰与下跪(spec §6):**
- 弯腰(问讯 70–90°):躯干绕髋旋转 → 头肩 Y 间距(gap = shoulderY − headY)被压缩到≈0 甚至为负(头顶朝镜头)。肩也会大幅下降,**所以肩高度不能单独定性,形态(gap)才能**。
- 下跪:躯干保持竖直(gap 正常),但整个身体下降一截 → 肩 Y 相对站立基线大幅下沉(sink ≥ 1.0×肩宽)。
- 弯腰动作**永远不会**产生"gap 正常 + 大幅下沉"的组合 → 永远不会被分类为 kneeling → 没有 KNEEL 阶段就永远不会计数。这是问题 2 的结构性根治。

**安置期(spec §7):** 点开始后必须"无基线 standing-like 形态连续 2s"才建立基线并武装。摆放手机期间的晃动/遮挡/乱跳信号只会不断打断采样,永远凑不出连续 2s → 结构性根治问题 1。

**周期唯一出口(spec §9):** 周期终结只经由 `applyFinish(state, reason, now)`,reason ∈ completed/backfilled/rejected/abandoned;同一周期物理上只能终结一次 → 结构性防双计。

**默认参数(types.ts 中定义,全计划引用同一份):**

| 参数 | 值 | 含义 |
|---|---|---|
| labelConfirmFrames | 3 | 标签防抖:连续 3 帧一致才确认 |
| setupStandingMs | 2000 | 安置期需稳定站立时长 |
| bowConfirmMs | 300 | 前倾形态确认时长(进 BOW) |
| bowReturnGraceMs | 3000 | 弯腰后回直的宽限窗(窗内下跪→继续) |
| standConfirmMs | 500 | 正常计数出口的站立确认时长 |
| backfillStandMs | 1500 | 补计出口的站立确认时长(更严) |
| minCycleMs | 3000 | 周期最短时长(prostration 模式用 1200) |
| suspendTimeoutMs | 60000 | 挂起最长等待 |
| phaseTimeoutMs | 12000 | BOW/KNEEL/RISE 阶段超时 |
| bottomTimeoutMs | 90000 | BOTTOM 阶段超时(磕长头放宽) |
| absentToSuspendMs | 2500 | KNEEL/RISE 阶段失踪多久转挂起 |
| gapBowRatio | 0.35 | gap ≤ 0.35×基线 gap → 前倾形态 |
| gapUprightRatio | 0.6 | gap ≥ 0.6×基线 gap → 竖直形态 |
| kneelDropK | 1.0 | 下沉 ≥ 1.0×肩宽 → 跪级下沉 |
| prostrateDropK | 1.6 | 下沉 ≥ 1.6×肩宽 → 趴底级下沉 |
| standingBandK | 0.45 | 肩 Y 距基线 ≤ 0.45×肩宽 → 站立带 |
| jumpRejectThreshold | 0.25 | 单帧跳变剔除阈值 |

---

### Task 1: 类型与默认参数(poseEngine/types.ts + index.ts)

**Files:**
- Create: `src/components/poseEngine/types.ts`
- Create: `src/components/poseEngine/index.ts`

- [ ] **Step 1: 创建 types.ts**

```ts
// src/components/poseEngine/types.ts
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
```

- [ ] **Step 2: 创建 index.ts(barrel,后续任务逐步补导出)**

```ts
// src/components/poseEngine/index.ts
export * from './types';
```

- [ ] **Step 3: 类型检查**

Run: `npm run lint`
Expected: 通过(无输出错误)

- [ ] **Step 4: Commit**

```bash
git add src/components/poseEngine/types.ts src/components/poseEngine/index.ts
git commit -m "feat: pose engine types and default params"
```

---

### Task 2: 特征提取器(poseEngine/features.ts)

**Files:**
- Create: `src/components/poseEngine/features.ts`
- Test: `src/components/__tests__/poseEngine.features.test.ts`
- Modify: `src/components/poseEngine/index.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/components/__tests__/poseEngine.features.test.ts
import {describe, expect, it} from 'vitest';
import type {LandmarkPoint} from '../kowtowDetection';
import {extractFrameFeatures} from '../poseEngine/features';

function emptyLandmarks(): LandmarkPoint[] {
  return Array.from({length: 33}, () => ({x: 0, y: 0, visibility: 0}));
}

describe('extractFrameFeatures', () => {
  it('空输入返回全 null', () => {
    expect(extractFrameFeatures(null)).toEqual({
      headY: null,
      shoulderY: null,
      hipY: null,
      kneeY: null,
      shoulderWidth: null,
    });
    expect(extractFrameFeatures([])).toEqual(extractFrameFeatures(null));
  });

  it('头部取可见点的加权平均,低可见度点被忽略', () => {
    const lm = emptyLandmarks();
    lm[0] = {x: 0.5, y: 0.2, visibility: 0.9};
    lm[2] = {x: 0.5, y: 0.3, visibility: 0.9};
    lm[5] = {x: 0.5, y: 0.9, visibility: 0.1}; // 低于 0.4,忽略
    const f = extractFrameFeatures(lm);
    expect(f.headY).toBeCloseTo(0.25, 5);
  });

  it('肩/髋/膝取双点中点,单点可见时取单点,全不可见为 null', () => {
    const lm = emptyLandmarks();
    lm[11] = {x: 0.4, y: 0.3, visibility: 0.9};
    lm[12] = {x: 0.6, y: 0.4, visibility: 0.9};
    lm[23] = {x: 0.45, y: 0.6, visibility: 0.9}; // 右髋不可见
    const f = extractFrameFeatures(lm);
    expect(f.shoulderY).toBeCloseTo(0.35, 5);
    expect(f.hipY).toBeCloseTo(0.6, 5);
    expect(f.kneeY).toBeNull();
  });

  it('肩宽需双肩都可见,取 x 距离', () => {
    const lm = emptyLandmarks();
    lm[11] = {x: 0.4, y: 0.3, visibility: 0.9};
    lm[12] = {x: 0.6, y: 0.3, visibility: 0.9};
    expect(extractFrameFeatures(lm).shoulderWidth).toBeCloseTo(0.2, 5);
    lm[12] = {x: 0.6, y: 0.3, visibility: 0.2};
    expect(extractFrameFeatures(lm).shoulderWidth).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- poseEngine.features`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 features.ts**

```ts
// src/components/poseEngine/features.ts
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
```

- [ ] **Step 4: index.ts 增加导出**

```ts
// src/components/poseEngine/index.ts
export * from './types';
export {extractFrameFeatures} from './features';
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test -- poseEngine.features`
Expected: PASS(4 个用例)

- [ ] **Step 6: Commit**

```bash
git add src/components/poseEngine/features.ts src/components/poseEngine/index.ts src/components/__tests__/poseEngine.features.test.ts
git commit -m "feat: pose engine frame feature extraction"
```

---

### Task 3: 姿态分类器(poseEngine/classifier.ts)

**Files:**
- Create: `src/components/poseEngine/classifier.ts`
- Test: `src/components/__tests__/poseEngine.classifier.test.ts`
- Modify: `src/components/poseEngine/index.ts`

- [ ] **Step 1: 写失败测试**

测试用统一基线:站立 head 0.2 / shoulder 0.35 / gap 0.15 / 肩宽 0.2。
关键断言:弯腰(gap 压缩)→ bowing;竖直形态+下沉 ≥1×肩宽 → kneeling;前倾+下沉 ≥1.6×肩宽 → prostrate;头不可见的降级路径。

```ts
// src/components/__tests__/poseEngine.classifier.test.ts
import {describe, expect, it} from 'vitest';
import {classifyPose} from '../poseEngine/classifier';
import {DEFAULT_POSE_ENGINE_PARAMS, type PoseBaseline, type PoseEngineParams} from '../poseEngine/types';

const params: PoseEngineParams = {mode: 'ritual', ...DEFAULT_POSE_ENGINE_PARAMS};

const baseline: PoseBaseline = {
  headY: 0.2,
  shoulderY: 0.35,
  gap: 0.15,
  shoulderWidth: 0.2,
  fieldOfView: 'upper',
};

function features(partial: {head?: number; shoulder?: number}) {
  return {
    headY: partial.head ?? null,
    shoulderY: partial.shoulder ?? null,
    hipY: null,
    kneeY: null,
    shoulderWidth: null,
  };
}

describe('classifyPose · 无基线(安置期)', () => {
  it('头肩可见且头明显高于肩 → standing,否则 transition/absent', () => {
    expect(classifyPose(features({head: 0.2, shoulder: 0.35}), null, params)).toBe('standing');
    expect(classifyPose(features({head: 0.5, shoulder: 0.5}), null, params)).toBe('transition');
    expect(classifyPose(features({}), null, params)).toBe('absent');
  });
});

describe('classifyPose · 有基线', () => {
  it('站立带内的竖直形态 → standing', () => {
    expect(classifyPose(features({head: 0.22, shoulder: 0.37}), baseline, params)).toBe('standing');
  });

  it('前倾形态(gap 压缩/为负)且下沉未达趴底级 → bowing(弯腰 70-90° 肩也大降的场景)', () => {
    // 深弯腰:头肩几乎重叠,肩沉 0.15(< 1.6×0.2)
    expect(classifyPose(features({head: 0.52, shoulder: 0.5}), baseline, params)).toBe('bowing');
    // 头低于肩(gap 为负)
    expect(classifyPose(features({head: 0.55, shoulder: 0.5}), baseline, params)).toBe('bowing');
  });

  it('竖直形态 + 整体下沉 ≥ 1×肩宽 → kneeling(弯腰永远到不了这个组合)', () => {
    expect(classifyPose(features({head: 0.45, shoulder: 0.6}), baseline, params)).toBe('kneeling');
  });

  it('前倾形态 + 下沉 ≥ 1.6×肩宽 → prostrate', () => {
    expect(classifyPose(features({head: 0.78, shoulder: 0.72}), baseline, params)).toBe('prostrate');
  });

  it('头不可见降级:肩沉达趴底级 → prostrate;肩接近站立高度 → bowing(深弯腰头出画)', () => {
    expect(classifyPose(features({shoulder: 0.72}), baseline, params)).toBe('prostrate');
    expect(classifyPose(features({shoulder: 0.4}), baseline, params)).toBe('bowing');
  });

  it('头肩全不可见 → absent;中间地带 → transition', () => {
    expect(classifyPose(features({}), baseline, params)).toBe('absent');
    // gap 0.065 介于 0.35×0.15=0.0525 与 0.6×0.15=0.09 之间 → transition
    expect(classifyPose(features({head: 0.36, shoulder: 0.425}), baseline, params)).toBe('transition');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- poseEngine.classifier`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 classifier.ts**

```ts
// src/components/poseEngine/classifier.ts
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
```

- [ ] **Step 4: index.ts 增加导出**

```ts
// src/components/poseEngine/index.ts
export * from './types';
export {extractFrameFeatures} from './features';
export {classifyPose} from './classifier';
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test -- poseEngine.classifier`
Expected: PASS(7 个用例)

- [ ] **Step 6: Commit**

```bash
git add src/components/poseEngine/classifier.ts src/components/poseEngine/index.ts src/components/__tests__/poseEngine.classifier.test.ts
git commit -m "feat: pose classifier with fold/upright configuration logic"
```

---

### Task 4: 状态机骨架——输入清洗、防抖、安置期、武装(poseEngine/machine.ts)

**Files:**
- Create: `src/components/poseEngine/machine.ts`
- Test: `src/components/__tests__/poseEngine.machine.test.ts`
- Modify: `src/components/poseEngine/index.ts`

- [ ] **Step 1: 写失败测试(含全计划共用的测试 helper,后续任务向此文件追加)**

```ts
// src/components/__tests__/poseEngine.machine.test.ts
import {describe, expect, it} from 'vitest';
import type {LandmarkPoint} from '../kowtowDetection';
import {advancePoseSequence, createPoseEngineState, type PoseEngineState} from '../poseEngine/machine';
import {DEFAULT_POSE_ENGINE_PARAMS, type PoseEngineParams} from '../poseEngine/types';

const FRAME_MS = 33;

const ritualParams: PoseEngineParams = {mode: 'ritual', ...DEFAULT_POSE_ENGINE_PARAMS};
const prostrationParams: PoseEngineParams = {
  mode: 'prostration',
  ...DEFAULT_POSE_ENGINE_PARAMS,
  minCycleMs: 1200,
};

// —— 合成姿态(上半身视野,基线 gap 0.15、肩宽 0.2)——
type PoseSpec = {head?: number; shoulder?: number; hip?: number; knee?: number; width?: number};

const STAND: PoseSpec = {head: 0.2, shoulder: 0.35};
const BOW: PoseSpec = {head: 0.52, shoulder: 0.5};
const KNEEL: PoseSpec = {head: 0.45, shoulder: 0.6};
const PROSTRATE: PoseSpec = {head: 0.78, shoulder: 0.72};
// 全身视野版本(髋/膝可见)
const STAND_FULL: PoseSpec = {head: 0.15, shoulder: 0.27, hip: 0.55, knee: 0.8, width: 0.15};
const BOW_FULL: PoseSpec = {head: 0.42, shoulder: 0.4, hip: 0.55, knee: 0.8, width: 0.15};
const KNEEL_FULL: PoseSpec = {head: 0.4, shoulder: 0.52, hip: 0.62, knee: 0.8, width: 0.15};
// 跪坐基线(磕头数模式)
const SIT: PoseSpec = {head: 0.35, shoulder: 0.5};
const SIT_BOTTOM: PoseSpec = {head: 0.8, shoulder: 0.75};

function makeLandmarks(spec: PoseSpec): LandmarkPoint[] {
  const lm: LandmarkPoint[] = Array.from({length: 33}, () => ({x: 0, y: 0, visibility: 0}));
  const width = spec.width ?? 0.2;
  if (spec.head !== undefined) {
    for (const i of [0, 2, 5, 7, 8]) {
      lm[i] = {x: 0.5, y: spec.head, visibility: 0.9};
    }
  }
  if (spec.shoulder !== undefined) {
    lm[11] = {x: 0.5 - width / 2, y: spec.shoulder, visibility: 0.9};
    lm[12] = {x: 0.5 + width / 2, y: spec.shoulder, visibility: 0.9};
  }
  if (spec.hip !== undefined) {
    lm[23] = {x: 0.45, y: spec.hip, visibility: 0.9};
    lm[24] = {x: 0.55, y: spec.hip, visibility: 0.9};
  }
  if (spec.knee !== undefined) {
    lm[25] = {x: 0.45, y: spec.knee, visibility: 0.9};
    lm[26] = {x: 0.55, y: spec.knee, visibility: 0.9};
  }
  return lm;
}

type Sim = {state: PoseEngineState; now: number; counted: number; backfilled: number};

function createSim(): Sim {
  return {state: createPoseEngineState(0), now: 0, counted: 0, backfilled: 0};
}

function feed(sim: Sim, spec: PoseSpec | null, frames: number, params: PoseEngineParams) {
  for (let i = 0; i < frames; i += 1) {
    sim.now += FRAME_MS;
    const result = advancePoseSequence(
      sim.state,
      spec ? makeLandmarks(spec) : null,
      sim.now,
      params,
    );
    sim.state = result.state;
    if (result.counted) sim.counted += 1;
    if (result.backfilled) sim.backfilled += 1;
  }
}

// head/shoulder 线性渐变喂帧(贴近真实连续运动)
function rampPose(sim: Sim, from: PoseSpec, to: PoseSpec, frames: number, params: PoseEngineParams) {
  for (let i = 1; i <= frames; i += 1) {
    const t = i / frames;
    const lerp = (a?: number, b?: number) =>
      a !== undefined && b !== undefined ? a + (b - a) * t : b ?? a;
    feed(
      sim,
      {
        head: lerp(from.head, to.head),
        shoulder: lerp(from.shoulder, to.shoulder),
        hip: lerp(from.hip, to.hip),
        knee: lerp(from.knee, to.knee),
        width: to.width ?? from.width,
      },
      1,
      params,
    );
  }
}

// 站稳并完成安置(70 帧 ≈ 2.3s > setupStandingMs)
function setup(sim: Sim, pose: PoseSpec, params: PoseEngineParams) {
  feed(sim, pose, 70, params);
}

describe('advancePoseSequence · 安置期', () => {
  it('稳定站立约 2 秒后建立基线并武装', () => {
    const sim = createSim();
    setup(sim, STAND, ritualParams);
    expect(sim.state.phase).toBe('ARMED');
    expect(sim.state.baseline).not.toBeNull();
    expect(sim.state.baseline?.shoulderY).toBeCloseTo(0.35, 2);
    expect(sim.state.baseline?.fieldOfView).toBe('upper');
    expect(sim.counted).toBe(0);
  });

  it('全身可见时视野判定为 full', () => {
    const sim = createSim();
    setup(sim, STAND_FULL, ritualParams);
    expect(sim.state.phase).toBe('ARMED');
    expect(sim.state.baseline?.fieldOfView).toBe('full');
  });

  it('摆放手机的乱信号(晃动/遮挡/跳变交替)永远不会武装、不会计数', () => {
    const sim = createSim();
    for (let round = 0; round < 10; round += 1) {
      feed(sim, {head: 0.3, shoulder: 0.45}, 5, ritualParams);
      feed(sim, null, 3, ritualParams);
      feed(sim, {head: 0.7, shoulder: 0.6}, 4, ritualParams);
      feed(sim, {head: 0.5, shoulder: 0.5}, 4, ritualParams);
    }
    expect(sim.state.phase).toBe('AWAIT_SETUP');
    expect(sim.counted).toBe(0);
    expect(sim.backfilled).toBe(0);
  });

  it('放好手机后人站定:武装但绝不因摆放期信号产生计数', () => {
    const sim = createSim();
    // 摆放期乱信号
    for (let round = 0; round < 6; round += 1) {
      feed(sim, {head: 0.6, shoulder: 0.55}, 4, ritualParams);
      feed(sim, null, 4, ritualParams);
    }
    // 人走到位站定
    feed(sim, STAND, 90, ritualParams);
    expect(sim.state.phase).toBe('ARMED');
    expect(sim.counted).toBe(0);
    expect(sim.backfilled).toBe(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- poseEngine.machine`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 machine.ts 骨架**

```ts
// src/components/poseEngine/machine.ts
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
  if (probe !== null && reference !== null && Math.abs(probe - reference) > params.jumpRejectThreshold) {
    next.jumpRejectStreak += 1;
    if (next.jumpRejectStreak < JUMP_ACCEPT_STREAK) {
      // 单帧不可能的位移:按本帧不可见处理(夜间关键点错乱的典型形态)
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
```

- [ ] **Step 4: index.ts 增加导出**

```ts
// src/components/poseEngine/index.ts
export * from './types';
export {extractFrameFeatures} from './features';
export {classifyPose} from './classifier';
export {advancePoseSequence, createPoseEngineState} from './machine';
export type {PoseEngineState, PoseEngineStepResult, PoseEngineDebug} from './machine';
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test -- poseEngine.machine`
Expected: PASS(4 个用例)。注意第 3/4 个用例正是问题 1 的回归测试。

- [ ] **Step 6: Commit**

```bash
git add src/components/poseEngine/machine.ts src/components/poseEngine/index.ts src/components/__tests__/poseEngine.machine.test.ts
git commit -m "feat: pose sequence machine skeleton with setup grace period"
```

---

### Task 5: ritual 完整序列计数路径(BOW/KNEEL/BOTTOM/RISE + 唯一出口)

**Files:**
- Modify: `src/components/poseEngine/machine.ts`
- Test: `src/components/__tests__/poseEngine.machine.test.ts`(追加)

- [ ] **Step 1: 追加失败测试**

```ts
// 追加到 poseEngine.machine.test.ts
// 一次标准完整大拜:弯腰→跪→磕头→起身(总时长 ≈ 3.6s > minCycleMs)
function fullRitualCycle(sim: Sim, params: PoseEngineParams) {
  rampPose(sim, STAND, BOW, 12, params);
  feed(sim, BOW, 12, params);
  rampPose(sim, BOW, KNEEL, 10, params);
  feed(sim, KNEEL, 12, params);
  rampPose(sim, KNEEL, PROSTRATE, 10, params);
  feed(sim, PROSTRATE, 35, params);
  rampPose(sim, PROSTRATE, STAND, 15, params);
  feed(sim, STAND, 25, params);
}

describe('advancePoseSequence · ritual 完整序列', () => {
  it('标准完整一拜计 1 次,周期出口回到 ARMED', () => {
    const sim = createSim();
    setup(sim, STAND, ritualParams);
    fullRitualCycle(sim, ritualParams);
    expect(sim.counted).toBe(1);
    expect(sim.backfilled).toBe(0);
    expect(sim.state.phase).toBe('ARMED');
    expect(sim.state.lastFinishReason).toBe('completed');
  });

  it('连续三拜计 3 次', () => {
    const sim = createSim();
    setup(sim, STAND, ritualParams);
    for (let i = 0; i < 3; i += 1) {
      fullRitualCycle(sim, ritualParams);
    }
    expect(sim.counted).toBe(3);
    expect(sim.backfilled).toBe(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- poseEngine.machine`
Expected: 新增 2 用例 FAIL(BOW 等阶段未实现,counted 恒 0)

- [ ] **Step 3: 实现序列 handlers 与唯一出口**

在 machine.ts 中新增以下函数(放在 handleArmed 之后):

```ts
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
```

替换 `advancePoseSequence` 中的 switch 及返回段为:

```ts
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
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- poseEngine.machine`
Expected: 全部 PASS(6 个用例)

- [ ] **Step 5: Commit**

```bash
git add src/components/poseEngine/machine.ts src/components/__tests__/poseEngine.machine.test.ts
git commit -m "feat: ritual sequence counting path with single-exit cycle"
```

---

### Task 6: 拒计路径——单独弯腰、回直宽限、跪而不磕

**Files:**
- Test: `src/components/__tests__/poseEngine.machine.test.ts`(追加;实现已在 Task 5 完成,本任务验证拒计行为并修正发现的问题)

- [ ] **Step 1: 追加测试**

```ts
// 追加到 poseEngine.machine.test.ts
describe('advancePoseSequence · 拒计(宁漏勿误)', () => {
  it('单独弯腰问讯(弯下→停留→直接回站)不计数 —— 问题 2 回归', () => {
    const sim = createSim();
    setup(sim, STAND, ritualParams);
    rampPose(sim, STAND, BOW, 12, ritualParams);
    feed(sim, BOW, 30, ritualParams); // 深弯腰停留约 1s
    rampPose(sim, BOW, STAND, 12, ritualParams);
    feed(sim, STAND, 130, ritualParams); // 回站超过宽限窗 3s
    expect(sim.counted).toBe(0);
    expect(sim.backfilled).toBe(0);
    expect(sim.state.phase).toBe('ARMED');
    expect(sim.state.lastFinishReason).toBe('rejected');
  });

  it('连续多次单独弯腰均不计数', () => {
    const sim = createSim();
    setup(sim, STAND, ritualParams);
    for (let i = 0; i < 3; i += 1) {
      rampPose(sim, STAND, BOW, 12, ritualParams);
      feed(sim, BOW, 20, ritualParams);
      rampPose(sim, BOW, STAND, 12, ritualParams);
      feed(sim, STAND, 130, ritualParams);
    }
    expect(sim.counted).toBe(0);
  });

  it('问讯后回直,宽限窗内下跪 → 序列继续,完整一拜计 1(仪轨流程)', () => {
    const sim = createSim();
    setup(sim, STAND, ritualParams);
    rampPose(sim, STAND, BOW, 12, ritualParams);
    feed(sim, BOW, 15, ritualParams);
    rampPose(sim, BOW, STAND, 10, ritualParams);
    feed(sim, STAND, 45, ritualParams); // 回直约 1.5s < 3s 宽限
    rampPose(sim, STAND, KNEEL, 10, ritualParams);
    feed(sim, KNEEL, 12, ritualParams);
    rampPose(sim, KNEEL, PROSTRATE, 10, ritualParams);
    feed(sim, PROSTRATE, 35, ritualParams);
    rampPose(sim, PROSTRATE, STAND, 15, ritualParams);
    feed(sim, STAND, 25, ritualParams);
    expect(sim.counted).toBe(1);
    expect(sim.backfilled).toBe(0);
  });

  it('跪下后未磕头直接起身 → 拒计', () => {
    const sim = createSim();
    setup(sim, STAND, ritualParams);
    rampPose(sim, STAND, BOW, 12, ritualParams);
    feed(sim, BOW, 12, ritualParams);
    rampPose(sim, BOW, KNEEL, 10, ritualParams);
    feed(sim, KNEEL, 20, ritualParams);
    rampPose(sim, KNEEL, STAND, 12, ritualParams);
    feed(sim, STAND, 30, ritualParams);
    expect(sim.counted).toBe(0);
    expect(sim.state.lastFinishReason).toBe('rejected');
  });
});
```

- [ ] **Step 2: 运行**

Run: `npm test -- poseEngine.machine`
Expected: PASS。若有用例失败,按"标签时序"排查:打印 `sim.state.label`/`sim.state.phase` 跟踪转移,常见原因是 ramp 帧数太少导致防抖未确认——修实现或调整测试帧数都必须以"行为符合 spec"为准,不得为凑绿改断言语义。

- [ ] **Step 3: Commit**

```bash
git add src/components/__tests__/poseEngine.machine.test.ts
git commit -m "test: rejection paths - lone bow, grace window, kneel-abort"
```

---

### Task 7: 挂起与补计——失焦补回、不补的边界、防双计专项

**Files:**
- Test: `src/components/__tests__/poseEngine.machine.test.ts`(追加;实现已在 Task 5 完成)

- [ ] **Step 1: 追加测试**

```ts
// 追加到 poseEngine.machine.test.ts
describe('advancePoseSequence · 挂起与补计', () => {
  it('全身视野:跪后失焦 → 挂起 → 回站 1.5s → 补计 1(用户核心诉求)', () => {
    const sim = createSim();
    setup(sim, STAND_FULL, ritualParams);
    rampPose(sim, STAND_FULL, BOW_FULL, 12, ritualParams);
    feed(sim, BOW_FULL, 12, ritualParams);
    rampPose(sim, BOW_FULL, KNEEL_FULL, 10, ritualParams);
    feed(sim, KNEEL_FULL, 12, ritualParams);
    feed(sim, null, 90, ritualParams); // 失焦约 3s > absentToSuspendMs
    expect(sim.state.phase).toBe('SUSPENDED');
    feed(sim, STAND_FULL, 60, ritualParams); // 重新站定约 2s > backfillStandMs
    expect(sim.backfilled).toBe(1);
    expect(sim.counted).toBe(0);
    expect(sim.counted + sim.backfilled).toBe(1); // 防双计:总增量恰 1
    expect(sim.state.phase).toBe('ARMED');
  });

  it('弯腰后消失、无任何下跪证据 → 放弃,不补计(宁漏勿误)', () => {
    const sim = createSim();
    setup(sim, STAND, ritualParams);
    rampPose(sim, STAND, BOW, 12, ritualParams);
    feed(sim, BOW, 12, ritualParams);
    feed(sim, null, 400, ritualParams); // 消失约 13.2s > phaseTimeoutMs
    expect(sim.state.phase).toBe('AWAIT_SETUP');
    expect(sim.state.lastFinishReason).toBe('abandoned');
    feed(sim, STAND, 100, ritualParams); // 回来站好:只重新武装,不补计
    expect(sim.counted).toBe(0);
    expect(sim.backfilled).toBe(0);
  });

  it('挂起超时 60s 无人 → 放弃,回安置期', () => {
    const sim = createSim();
    setup(sim, STAND_FULL, ritualParams);
    rampPose(sim, STAND_FULL, BOW_FULL, 12, ritualParams);
    feed(sim, BOW_FULL, 12, ritualParams);
    rampPose(sim, BOW_FULL, KNEEL_FULL, 10, ritualParams);
    feed(sim, KNEEL_FULL, 12, ritualParams);
    feed(sim, null, 90, ritualParams);
    expect(sim.state.phase).toBe('SUSPENDED');
    feed(sim, null, 1900, ritualParams); // 约 63s > suspendTimeoutMs
    expect(sim.state.phase).toBe('AWAIT_SETUP');
    expect(sim.counted).toBe(0);
    expect(sim.backfilled).toBe(0);
  });

  it('补计后立刻可以正常开始并完成下一拜(周期隔离)', () => {
    const sim = createSim();
    setup(sim, STAND_FULL, ritualParams);
    rampPose(sim, STAND_FULL, BOW_FULL, 12, ritualParams);
    feed(sim, BOW_FULL, 12, ritualParams);
    rampPose(sim, BOW_FULL, KNEEL_FULL, 10, ritualParams);
    feed(sim, KNEEL_FULL, 12, ritualParams);
    feed(sim, null, 90, ritualParams);
    feed(sim, STAND_FULL, 60, ritualParams);
    expect(sim.backfilled).toBe(1);
    // 下一拜走正常路径
    rampPose(sim, STAND_FULL, BOW_FULL, 12, ritualParams);
    feed(sim, BOW_FULL, 12, ritualParams);
    rampPose(sim, BOW_FULL, KNEEL_FULL, 10, ritualParams);
    feed(sim, KNEEL_FULL, 12, ritualParams);
    rampPose(sim, KNEEL_FULL, PROSTRATE, 10, ritualParams);
    feed(sim, PROSTRATE, 35, ritualParams);
    rampPose(sim, PROSTRATE, STAND_FULL, 15, ritualParams);
    feed(sim, STAND_FULL, 25, ritualParams);
    expect(sim.counted + sim.backfilled).toBe(2);
  });
});
```

- [ ] **Step 2: 运行**

Run: `npm test -- poseEngine.machine`
Expected: PASS。注意:KNEEL_FULL→PROSTRATE 的 ramp 中 hip/knee 字段会因 PROSTRATE 未定义这些字段而消失,这是符合真实(趴下时髋膝出画/混乱)的。

- [ ] **Step 3: Commit**

```bash
git add src/components/__tests__/poseEngine.machine.test.ts
git commit -m "test: suspension and backfill paths with double-count guard"
```

---

### Task 8: 上半身视野的趴底消失签名与长趴底

**Files:**
- Test: `src/components/__tests__/poseEngine.machine.test.ts`(追加;实现已在 Task 5 的 handleKneel/handleBottom 完成)

- [ ] **Step 1: 追加测试**

```ts
// 追加到 poseEngine.machine.test.ts
describe('advancePoseSequence · 上半身视野与长趴底', () => {
  it('上半身视野:跪后消失 → 遮挡到底 → 重现起身 → 正常计 1(非补计,且总增量恰 1)', () => {
    const sim = createSim();
    setup(sim, STAND, ritualParams); // upper 视野
    rampPose(sim, STAND, BOW, 12, ritualParams);
    feed(sim, BOW, 12, ritualParams);
    rampPose(sim, BOW, KNEEL, 10, ritualParams);
    feed(sim, KNEEL, 12, ritualParams);
    feed(sim, null, 40, ritualParams); // 磕头出画约 1.3s
    expect(sim.state.phase).toBe('BOTTOM');
    feed(sim, KNEEL, 10, ritualParams); // 重现为跪姿(起身途中)
    rampPose(sim, KNEEL, STAND, 12, ritualParams);
    feed(sim, STAND, 25, ritualParams);
    expect(sim.counted).toBe(1);
    expect(sim.backfilled).toBe(0);
    expect(sim.counted + sim.backfilled).toBe(1);
  });

  it('磕长头:趴底消失 60s(< bottomTimeout 90s)后起身 → 正常计 1', () => {
    const sim = createSim();
    setup(sim, STAND, ritualParams);
    rampPose(sim, STAND, BOW, 12, ritualParams);
    feed(sim, BOW, 12, ritualParams);
    rampPose(sim, BOW, KNEEL, 10, ritualParams);
    feed(sim, KNEEL, 12, ritualParams);
    feed(sim, null, 1800, ritualParams); // 趴底约 59.4s
    expect(sim.state.phase).toBe('BOTTOM');
    feed(sim, STAND, 30, ritualParams); // 直接重现为站立
    expect(sim.counted).toBe(1);
    expect(sim.backfilled).toBe(0);
  });
});
```

- [ ] **Step 2: 运行**

Run: `npm test -- poseEngine.machine`
Expected: PASS。第 1 个用例同时是防双计专项:occluded BOTTOM 正常路径计数后,挂起补计不可能再次发生(周期已终结)。
注意:长失焦后重现会触发跳变剔除(连续拒 5 帧后接受新位置),测试中重现后的喂帧数已留足余量。

- [ ] **Step 3: Commit**

```bash
git add src/components/__tests__/poseEngine.machine.test.ts
git commit -m "test: occluded bottom signature and long prostration hold"
```

---

### Task 9: 磕头数(prostration)模式

**Files:**
- Test: `src/components/__tests__/poseEngine.machine.test.ts`(追加;实现已在 Task 5 的 handleArmed prostration 分支完成)

- [ ] **Step 1: 追加测试**

```ts
// 追加到 poseEngine.machine.test.ts
// 磕头数模式的一次叩首:跪坐 → 俯身触地 → 回跪坐
function prostrationCycle(sim: Sim) {
  rampPose(sim, SIT, SIT_BOTTOM, 10, prostrationParams);
  feed(sim, SIT_BOTTOM, 25, prostrationParams);
  rampPose(sim, SIT_BOTTOM, SIT, 10, prostrationParams);
  feed(sim, SIT, 30, prostrationParams);
}

describe('advancePoseSequence · 磕头数模式', () => {
  it('跪坐基线建立后,一次俯身叩首计 1', () => {
    const sim = createSim();
    setup(sim, SIT, prostrationParams);
    expect(sim.state.phase).toBe('ARMED');
    prostrationCycle(sim);
    expect(sim.counted).toBe(1);
  });

  it('连续三叩计 3', () => {
    const sim = createSim();
    setup(sim, SIT, prostrationParams);
    for (let i = 0; i < 3; i += 1) {
      prostrationCycle(sim);
    }
    expect(sim.counted).toBe(3);
  });

  it('叩首中失焦 → 重新坐稳 → 补计 1,总增量恰 1', () => {
    const sim = createSim();
    setup(sim, SIT, prostrationParams);
    rampPose(sim, SIT, SIT_BOTTOM, 10, prostrationParams);
    feed(sim, SIT_BOTTOM, 15, prostrationParams);
    feed(sim, null, 2750, prostrationParams); // 失焦约 91s > bottomTimeout → SUSPENDED
    expect(sim.state.phase).toBe('SUSPENDED');
    feed(sim, SIT, 60, prostrationParams);
    expect(sim.counted + sim.backfilled).toBe(1);
  });
});
```

- [ ] **Step 2: 运行**

Run: `npm test -- poseEngine.machine`
Expected: PASS。说明:磕头数模式下 SIT_BOTTOM(gap 为负、下沉 0.25 < 1.6×0.2)分类为 bowing,经 handleArmed 的 prostration 分支确认进 BOTTOM;回坐(standing 标签)经 handleBottom→RISE→completed,minCycleMs=1200 由参数覆盖。

- [ ] **Step 3: Commit**

```bash
git add src/components/__tests__/poseEngine.machine.test.ts
git commit -m "test: prostration mode counting and backfill"
```

---

### Task 10: UI 接入——引擎切换、智能引擎调用、阶段显示、补计提示

**Files:**
- Modify: `src/components/KowtowCounter.tsx`

执行提示:用 Grep 定位锚点行号(行号会随编辑漂移,以内容锚点为准)。改动共 7 处,全部是增量插入或局部替换,不重排既有代码。

- [ ] **Step 1: 新增 import(文件顶部,现有 kowtowDetection import 之后)**

找到 `from './kowtowDetection'` 的 import 块,在其后新增:

```tsx
import {
  advancePoseSequence,
  createPoseEngineState,
  DEFAULT_POSE_ENGINE_PARAMS,
  type PoseEngineParams,
  type PoseEngineState,
  type SequencePhase,
} from './poseEngine';
```

- [ ] **Step 2: 模块级常量(COUNT_MODE_OPTIONS 定义附近,约 74-81 行)**

在 `PERSPECTIVE_MODE_OPTIONS` 定义之后新增:

```tsx
type EngineKind = 'smart' | 'classic';

const ENGINE_OPTIONS: Array<{hint: string; label: string; value: EngineKind}> = [
  {value: 'smart', label: '智能引擎', hint: '姿态序列验证,误计接近零(推荐)'},
  {value: 'classic', label: '经典引擎', hint: '深度门槛算法,兼容旧行为'},
];

const RITUAL_POSE_PARAMS: PoseEngineParams = {mode: 'ritual', ...DEFAULT_POSE_ENGINE_PARAMS};
const PROSTRATION_POSE_PARAMS: PoseEngineParams = {
  mode: 'prostration',
  ...DEFAULT_POSE_ENGINE_PARAMS,
  minCycleMs: 1200,
};

const ENGINE_PHASE_TEXT: Record<SequencePhase, string> = {
  AWAIT_SETUP: '请站到画面中保持站立',
  ARMED: '已就绪 · 站立',
  BOW: '弯腰',
  KNEEL: '跪下',
  BOTTOM: '磕头',
  RISE: '起身',
  SUSPENDED: '画面中断 · 起身站立可补计',
};

const ENGINE_BOWED_PHASES = new Set<SequencePhase>(['BOW', 'KNEEL', 'BOTTOM', 'RISE']);
```

(磕头数模式下 AWAIT_SETUP 文案语义为"保持跪坐",在 Step 6 的 badge 渲染处按 countMode 调整,见下。)

- [ ] **Step 3: 组件内新增 state/ref(detectionStateRef 声明附近,约 350 行)**

在 `detectionStateRef` 声明之后新增:

```tsx
  const poseStateRef = useRef<PoseEngineState>(createPoseEngineState(0));
```

在 `const [tuning, setTuning] = useState...`(约 380 行)之后新增:

```tsx
  const [engine, setEngine] = useState<EngineKind>('smart');
  const [enginePhase, setEnginePhase] = useState<SequencePhase>('AWAIT_SETUP');
  const [backfillNotice, setBackfillNotice] = useState(false);
```

- [ ] **Step 4: 引擎重置与切换 handler(handleToggleCounting 附近,约 1026 行)**

修改 `handleToggleCounting`,在 `setIsCounting(true)` 之前加一行重置:

```tsx
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
    poseStateRef.current = createPoseEngineState(performance.now());
    setEnginePhase('AWAIT_SETUP');
    setIsCounting(true);
  };
```

在其后新增切换 handler:

```tsx
  const handleEngineChange = (nextEngine: EngineKind) => {
    if (engine === nextEngine) {
      return;
    }
    setEngine(nextEngine);
    poseStateRef.current = createPoseEngineState(performance.now());
    setEnginePhase('AWAIT_SETUP');
    resetMotionTracking();
  };
```

- [ ] **Step 5: renderLoop 智能引擎分支(约 836-912 行)**

将 `if (isCounting || detectionStateRef.current.calibration) {` 包裹的整段检测逻辑改为:

```tsx
        if (engine === 'smart' && isCounting) {
          const now = performance.now();
          const poseParams = countMode === 'ritual' ? RITUAL_POSE_PARAMS : PROSTRATION_POSE_PARAMS;
          const prevPhase = poseStateRef.current.phase;
          const result = advancePoseSequence(
            poseStateRef.current,
            results.landmarks?.[0] ?? null,
            now,
            poseParams,
          );
          poseStateRef.current = result.state;

          if (result.counted || result.backfilled) {
            setCount((current) => current + 1);
          }
          if (result.backfilled) {
            setBackfillNotice(true);
            window.setTimeout(() => setBackfillNotice(false), 3000);
          }
          if (result.state.phase !== prevPhase) {
            setEnginePhase(result.state.phase);
          }
          updateBowed(ENGINE_BOWED_PHASES.has(result.state.phase));

          if (showDebug && context) {
            const d = result.debug;
            const fmt = (value: number | null) => (value === null ? '--' : value.toFixed(3));
            context.save();
            context.font = `${Math.round(canvas.width * 0.032)}px monospace`;
            context.fillStyle = 'rgba(0,0,0,0.6)';
            context.fillRect(0, canvas.height - canvas.width * 0.22, canvas.width, canvas.width * 0.22);
            context.fillStyle = '#34d399';
            const lh = canvas.width * 0.038;
            const bx = canvas.width * 0.02;
            let by = canvas.height - canvas.width * 0.2;
            const lines = [
              `Phase: ${d.phase}  Label: ${d.label}  FoV: ${d.fieldOfView ?? '--'}`,
              `HeadY: ${fmt(d.headY)}  ShoulderY: ${fmt(d.shoulderY)}`,
              `Gap: ${fmt(d.gap)}  Sink: ${fmt(d.sink)}  Base: ${fmt(d.baselineShoulderY)}`,
              `LastFinish: ${d.lastFinishReason ?? '--'}`,
            ];
            for (const line of lines) {
              context.fillText(line, bx, by);
              by += lh;
            }
            context.restore();
          }
        } else if (isCounting || detectionStateRef.current.calibration) {
          // —— 经典引擎:以下为原有逻辑,原样保留 ——
          const now = performance.now();
          const signal = computeBodySignal(results.landmarks?.[0] ?? null);
          // ……(原 detectionParams 构造、advanceDetection 调用、debug 绘制,全部不动)
        }
```

注意:`else if` 分支内是**现有代码原样保留**,只是包进了分支;不要删改其中任何一行。renderLoop 的 useCallback 依赖数组需追加 `engine`。

- [ ] **Step 6: JSX——引擎选择区块、阶段 badge、补计提示**

(a) 找到「拍摄角度」区块(`PERSPECTIVE_MODE_OPTIONS.map` 渲染处),在该区块**之前**插入同样式的引擎选择区块:

```tsx
          <div className="rounded-2xl border border-stone-700/50 bg-stone-800/60 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-200">
              <Crosshair className="h-4 w-4 text-emerald-300" />
              计数引擎
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {ENGINE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleEngineChange(option.value)}
                  className={`rounded-xl border px-4 py-3 text-left transition-all ${
                    engine === option.value
                      ? 'border-emerald-400/60 bg-emerald-500/10 text-emerald-200'
                      : 'border-stone-700 bg-stone-900 text-stone-300'
                  }`}
                >
                  <div className="text-sm font-bold">{option.label}</div>
                  <div className="mt-1 text-xs text-stone-400">{option.hint}</div>
                </button>
              ))}
            </div>
          </div>
```

(b) 在摄像头画面容器(`<canvas ref={canvasRef}` 所在的相对定位容器)内追加阶段 badge 与补计提示(canvas 元素之后):

```tsx
                  {engine === 'smart' && isCounting ? (
                    <div className="absolute left-3 top-3 z-20 rounded-full bg-stone-950/80 px-3 py-1.5 text-xs font-semibold text-emerald-300">
                      {enginePhase === 'AWAIT_SETUP' && countMode === 'prostration'
                        ? '请在画面中保持跪坐'
                        : ENGINE_PHASE_TEXT[enginePhase]}
                    </div>
                  ) : null}
                  {backfillNotice ? (
                    <div className="absolute right-3 top-3 z-20 rounded-full bg-amber-500/90 px-3 py-1.5 text-xs font-bold text-stone-950">
                      +1(补)
                    </div>
                  ) : null}
```

(c) 「手动校准」按钮是经典引擎功能,智能引擎下隐藏:将该按钮(`handleStartCalibration` 的 button)包裹为:

```tsx
              {engine === 'classic' ? (
                <button
                  type="button"
                  onClick={handleStartCalibration}
                  disabled={!isRunning}
                  className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-amber-400/30 bg-amber-400/10 px-6 py-4 text-lg font-bold text-amber-200 transition-all active:scale-95 disabled:border-stone-700 disabled:bg-stone-900 disabled:text-stone-500"
                >
                  <Crosshair className="h-6 w-6" />
                  手动校准
                </button>
              ) : null}
```

并把按钮组下方说明文案(约 1297-1299 行)改为按引擎区分:

```tsx
            <p className="mt-3 text-xs leading-relaxed text-stone-400">
              {engine === 'smart'
                ? '先开启摄像头,再点击"开始计数",然后站到画面中保持站立约 2 秒,看到"已就绪"后开始礼拜。摆放手机期间不会误计。'
                : '先开启摄像头,再点击"开始计数"。识别不准时点"手动校准",在镜头前站好(磕头模式保持跪坐)约 3 秒,听到木鱼音即校准完成。'}
            </p>
```

- [ ] **Step 7: 类型检查与全量测试**

Run: `npm run lint && npm test`
Expected: 均 PASS。常见错误:renderLoop 依赖数组遗漏 `engine`(react-hooks 规则);`Crosshair` 图标已在文件中 import(经典校准按钮在用),无需新增。

- [ ] **Step 8: Commit**

```bash
git add src/components/KowtowCounter.tsx
git commit -m "feat: smart engine integration with engine switcher, phase badge, backfill notice"
```

---

### Task 11: 全量验证与收尾

**Files:** 无新增(验证与可能的小修)

- [ ] **Step 1: 全量测试与类型检查**

Run: `npm test && npm run lint`
Expected: 全部 PASS(原有 kowtowDetection 测试 + 新增 poseEngine 测试)

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 3: 真机手测清单(向用户报告,由用户执行)**

打包 APK(参考 memory:JDK `C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot`,SDK `C:\opus\android-sdk`,`npm run build` + `npx cap sync android` + `android\gradlew.bat assembleDebug`),用户验证:
1. 开始计数 → 弯腰放手机到地上 → 手拿开 → **不应产生任何计数**(问题 1)
2. 智能引擎 + 完整礼拜:单独弯腰问讯 → **不计数**(问题 2)
3. 完整大拜一次 → 计 1;连续多拜逐次 +1
4. 磕头时人出画 → 起身站好 → 计数 +1(正常或"+1(补)")且只 +1
5. 切到经典引擎 → 行为与旧版一致

- [ ] **Step 4: 最终提交(如有修正)**

```bash
git add <仅本次修正的文件>
git commit -m "fix: post-verification adjustments for pose sequence engine"
```

---

## 风险与已知边界(执行者与用户须知)

1. **阈值常量是工程初值**:gapBowRatio/kneelDropK 等数值基于几何推导与合成测试,真机视角可能需要微调。调整入口集中在 `DEFAULT_POSE_ENGINE_PARAMS` 一处。
2. **"宁漏勿误"的代价**:序列中任何阶段识别不连贯都可能拒计/放弃;补计机制只兜"已确认下跪后失焦"这一类(用户确认的高发场景)。
3. **磕头数模式的安置期**是"稳定跪坐 2 秒"(跪坐时头肩 gap 同样为正,standing-like 判定天然兼容),UI 文案已区分。
4. **经典引擎完全不动**,任何智能引擎问题都可即时切回。

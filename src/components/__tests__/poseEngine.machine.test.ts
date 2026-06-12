import {describe, expect, it} from 'vitest';
import type {LandmarkPoint} from '../kowtowDetection';
import {
  advancePoseSequence,
  createPoseEngineState,
  type PoseEngineState,
} from '../poseEngine/machine';
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
function rampPose(
  sim: Sim,
  from: PoseSpec,
  to: PoseSpec,
  frames: number,
  params: PoseEngineParams,
) {
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

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
    const sim = createSim();
    sim.state = startCalibration(sim.state, sim.now);
    const result = feed(sim, signalAt(0.25, 0.24), 120, ritualParams);
    expect(result.calibrated).toBe(1);
    expect(sim.state.standingBodyY as number).toBeCloseTo(0.25, 3);
    expect(sim.state.baselineBodyScale as number).toBeCloseTo(0.24, 3);
    expect(result.counted).toBe(0);
  });

  it('中途阶段卡住超时后复位但保留基线', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    const baseline = sim.state.standingBodyY;
    // 0.4 的下降量（0.2）不足绝对门槛（0.22），状态机停在中途阶段 → 按普通超时复位
    feed(sim, signalAt(0.4), 320, ritualParams);
    expect(sim.state.phase).toBe('READY');
    expect(sim.state.standingBodyY).not.toBeNull();
    expect(baseline).not.toBeNull();
  });

  it('磕头在底部停留超过普通超时再起身，仍计 1 次', () => {
    const sim = createSim();
    feed(sim, signalAt(0.3), 10, prostrationParams);
    // 250 帧 ≈ 8.25 秒 > 6 秒普通超时；底部阶段超时已放宽，不应复位
    feed(sim, signalAt(0.6), 250, prostrationParams);
    expect(sim.state.phase).toBe('PROSTRATION_BOTTOM');
    const up = feed(sim, signalAt(0.3), 15, prostrationParams);
    expect(up.counted).toBe(1);
  });

  it('大拜在底部丢失信号超过普通超时再起身，仍计 1 次', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    feed(sim, signalAt(0.85), 2, ritualParams);
    // 底部整人丢失 380 帧 ≈ 12.5 秒 > 10 秒普通超时；底部阶段（含遮挡到底）不应复位
    feed(sim, signalAt(null, null), 380, ritualParams);
    expect(sim.state.phase).toBe('BOTTOM');
    const up = feed(sim, signalAt(0.2), 20, ritualParams);
    expect(up.counted).toBe(1);
  });
});

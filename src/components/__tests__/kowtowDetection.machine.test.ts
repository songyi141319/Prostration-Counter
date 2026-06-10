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

// 线性渐变喂帧：贴近真实连续运动（瞬移帧会被跳变滤波拦截，属预期行为）
function ramp(sim: Sim, from: number, to: number, frames: number, params: DetectionParams) {
  let counted = 0;
  for (let i = 1; i <= frames; i += 1) {
    const y = from + ((to - from) * i) / frames;
    counted += feed(sim, signalAt(y), 1, params).counted;
  }
  return {counted};
}

// 一次完整磕头周期：预备位 → 渐降到底 → 停留 → 渐升回预备位 → 停稳
function prostrationCycle(sim: Sim, top: number, bottom: number, params: DetectionParams) {
  let counted = 0;
  counted += ramp(sim, top, bottom, 10, params).counted;
  counted += feed(sim, signalAt(bottom), 8, params).counted;
  counted += ramp(sim, bottom, top, 10, params).counted;
  counted += feed(sim, signalAt(top), 10, params).counted;
  return counted;
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
    let counted = 0;
    counted += ramp(sim, 0.2, 0.85, 10, ritualParams).counted;
    counted += feed(sim, signalAt(0.85), 8, ritualParams).counted;
    counted += ramp(sim, 0.85, 0.2, 10, ritualParams).counted;
    counted += feed(sim, signalAt(0.2), 10, ritualParams).counted;
    expect(counted).toBe(1);
    expect(sim.state.phase).toBe('READY');
  });

  it('连续三拜计 3 次', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    let total = 0;
    for (let i = 0; i < 3; i += 1) {
      total += ramp(sim, 0.2, 0.85, 10, ritualParams).counted;
      total += feed(sim, signalAt(0.85), 6, ritualParams).counted;
      total += ramp(sim, 0.85, 0.2, 10, ritualParams).counted;
      total += feed(sim, signalAt(0.2), 10, ritualParams).counted;
    }
    expect(total).toBe(3);
  });

  it('浅鞠躬（drop < K×肩宽）不计数', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    let counted = 0;
    counted += ramp(sim, 0.2, 0.38, 8, ritualParams).counted;
    counted += feed(sim, signalAt(0.38), 8, ritualParams).counted;
    counted += ramp(sim, 0.38, 0.2, 8, ritualParams).counted;
    counted += feed(sim, signalAt(0.2), 8, ritualParams).counted;
    expect(counted).toBe(0);
  });

  it('起身到一半（不足回正行程）不提前计数', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    ramp(sim, 0.2, 0.85, 10, ritualParams);
    feed(sim, signalAt(0.85), 8, ritualParams);
    let half = 0;
    half += ramp(sim, 0.85, 0.45, 8, ritualParams).counted;
    half += feed(sim, signalAt(0.45), 20, ritualParams).counted;
    expect(half).toBe(0);
    let full = 0;
    full += ramp(sim, 0.45, 0.2, 6, ritualParams).counted;
    full += feed(sim, signalAt(0.2), 10, ritualParams).counted;
    expect(full).toBe(1);
  });
});

describe('advanceDetection · 消失即到底', () => {
  it('下行后整人丢失再回到站立，仍计 1 次', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    // 降到 0.42（深度不足以经绝对路径到 BOTTOM）后整人消失
    ramp(sim, 0.2, 0.42, 6, ritualParams);
    feed(sim, signalAt(null, null), 14, ritualParams);
    expect(sim.state.phase).toBe('BOTTOM');
    expect(sim.state.occlusionBottom).toBe(true);
    let counted = 0;
    counted += feed(sim, signalAt(0.2), 20, ritualParams).counted;
    expect(counted).toBe(1);
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
    expect(prostrationCycle(sim, 0.3, 0.6, prostrationParams)).toBe(1);
  });

  it('连续五次磕头计 5 次', () => {
    const sim = createSim();
    feed(sim, signalAt(0.3), 10, prostrationParams);
    let total = 0;
    for (let i = 0; i < 5; i += 1) {
      total += prostrationCycle(sim, 0.3, 0.6, prostrationParams);
    }
    expect(total).toBe(5);
  });

  it('轻微点头（drop < K×肩宽）不计数', () => {
    const sim = createSim();
    feed(sim, signalAt(0.3), 10, prostrationParams);
    expect(prostrationCycle(sim, 0.3, 0.36, prostrationParams)).toBe(0);
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
    // 0.4 的下降量（0.2）不足绝对门槛（0.22），状态机停在中途阶段 → 按普通超时复位
    ramp(sim, 0.2, 0.4, 6, ritualParams);
    feed(sim, signalAt(0.4), 320, ritualParams);
    expect(sim.state.phase).toBe('READY');
    expect(sim.state.standingBodyY).not.toBeNull();
  });

  it('磕头在底部停留超过普通超时再起身，仍计 1 次', () => {
    const sim = createSim();
    feed(sim, signalAt(0.3), 10, prostrationParams);
    ramp(sim, 0.3, 0.6, 10, prostrationParams);
    // 250 帧 ≈ 8.25 秒 > 6 秒普通超时；底部阶段超时已放宽，不应复位
    feed(sim, signalAt(0.6), 250, prostrationParams);
    expect(sim.state.phase).toBe('PROSTRATION_BOTTOM');
    let counted = 0;
    counted += ramp(sim, 0.6, 0.3, 10, prostrationParams).counted;
    counted += feed(sim, signalAt(0.3), 10, prostrationParams).counted;
    expect(counted).toBe(1);
  });

  it('大拜在底部丢失信号超过普通超时再起身，仍计 1 次', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    ramp(sim, 0.2, 0.42, 6, ritualParams);
    // 底部整人丢失 380 帧 ≈ 12.5 秒 > 10 秒普通超时；底部阶段（含遮挡到底）不应复位
    feed(sim, signalAt(null, null), 380, ritualParams);
    expect(sim.state.phase).toBe('BOTTOM');
    const up = feed(sim, signalAt(0.2), 20, ritualParams);
    expect(up.counted).toBe(1);
  });
});

describe('advanceDetection · 夜间鲁棒性（v3 三层防线）', () => {
  it('单帧瞬移（关键点错乱）被剔除，不触发任何阶段', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    feed(sim, signalAt(0.9), 1, ritualParams);
    const after = feed(sim, signalAt(0.2), 10, ritualParams);
    expect(after.counted).toBe(0);
    expect(sim.state.phase).toBe('READY');
    expect(sim.state.smoothedBodyY as number).toBeCloseTo(0.2, 1);
  });

  it('持续自洽的新位置 3 帧后被接受（断层后续上）', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2), 10, ritualParams);
    feed(sim, signalAt(0.6), 12, ritualParams);
    expect(sim.state.smoothedBodyY as number).toBeCloseTo(0.6, 1);
  });

  it('肩宽瞬间塌缩（一团点）被拒收，平滑肩宽不受污染', () => {
    const sim = createSim();
    feed(sim, signalAt(0.2, 0.2), 10, ritualParams);
    feed(sim, signalAt(0.2, 0.03), 5, ritualParams);
    expect(sim.state.smoothedBodyScale as number).toBeCloseTo(0.2, 1);
  });

  it('基线被垃圾帧拉偏后：当拜靠周期快照计数，并自愈基线，下一拜也正常', () => {
    const sim = createSim();
    feed(sim, signalAt(0.3), 10, prostrationParams);
    // 模拟夜间垃圾帧把全局基线拉到不可达的高位
    sim.state = {...sim.state, standingBodyY: 0.05};
    const first = prostrationCycle(sim, 0.3, 0.6, prostrationParams);
    expect(first).toBe(1);
    // 计数时刻应已重锚基线到真实预备位附近
    expect(sim.state.standingBodyY as number).toBeGreaterThan(0.2);
    const second = prostrationCycle(sim, 0.3, 0.6, prostrationParams);
    expect(second).toBe(1);
  });

  it('快速噪声抖动不会凑出一次计数（最短周期时长约束）', () => {
    const sim = createSim();
    feed(sim, signalAt(0.3), 10, prostrationParams);
    // 8 帧内完成的"下-上"抖动 ≈ 264ms < 600ms 最短周期
    let counted = 0;
    counted += ramp(sim, 0.3, 0.6, 4, prostrationParams).counted;
    counted += ramp(sim, 0.6, 0.3, 4, prostrationParams).counted;
    counted += feed(sim, signalAt(0.3), 4, prostrationParams).counted;
    expect(counted).toBe(0);
  });
});

import {describe, expect, it} from 'vitest';
import {classifyPose} from '../poseEngine/classifier';
import {
  DEFAULT_POSE_ENGINE_PARAMS,
  type PoseBaseline,
  type PoseEngineParams,
} from '../poseEngine/types';

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

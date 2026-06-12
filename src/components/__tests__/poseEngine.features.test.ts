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

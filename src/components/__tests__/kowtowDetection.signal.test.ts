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

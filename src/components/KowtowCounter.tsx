import {
  Activity,
  BellRing,
  Camera,
  CameraOff,
  Eye,
  EyeOff,
  Info,
  Pause,
  Play,
  RefreshCw,
  Settings,
  Smartphone,
  Volume2,
  X,
} from 'lucide-react';
import {useCallback, useEffect, useRef, useState, type ChangeEvent} from 'react';
import {DrawingUtils, FilesetResolver, PoseLandmarker} from '@mediapipe/tasks-vision';

type MotionPhase =
  | 'READY'
  | 'DESCENDING'
  | 'KNEELING'
  | 'BOTTOM'
  | 'ASCENDING'
  | 'PROSTRATION_BOTTOM';
type CountMode = 'ritual' | 'prostration';
type PerspectiveMode = 'front' | 'side';
type PreviewMode = 'camera' | 'skeleton';
type SoundStyle = 'soft' | 'short' | 'obvious' | 'long' | 'custom';
type ToneNote = {
  delay: number;
  duration: number;
  frequency: number;
  gain: number;
  oscillator: OscillatorType;
};
type TuningSettings = {
  autoCalibrationIntervalMs: number;
  stableFrameCount: number;
  frontStableDelta: number;
  sideStableDelta: number;
  ritualMinAmplitudeFront: number;
  ritualMinAmplitudeSide: number;
  prostrationMinAmplitudeFront: number;
  prostrationMinAmplitudeSide: number;
  ritualBottomDepthBias: number;
  prostrationBottomDepthBias: number;
  recoveryBias: number;
  phaseTimeoutRitualMs: number;
  phaseTimeoutProstrationMs: number;
};
type TuningField = {
  description: string;
  effect: string;
  key: keyof TuningSettings;
  label: string;
  max: number;
  min: number;
  step: number;
};

const PRESET_TARGETS = [0, 36, 72, 108] as const;
const PRESET_TARGET_SET = new Set<number>(PRESET_TARGETS);
const COUNT_MODE_OPTIONS: Array<{hint: string; label: string; value: CountMode}> = [
  {value: 'ritual', label: '完整礼拜', hint: '站立到磕头再回站立'},
  {value: 'prostration', label: '磕头数', hint: '头部触底后起身记 1 次'},
];
const PERSPECTIVE_MODE_OPTIONS: Array<{hint: string; label: string; value: PerspectiveMode}> = [
  {value: 'front', label: '正拍模式', hint: '手机放在正前方'},
  {value: 'side', label: '侧拍模式', hint: '手机放在身体侧边'},
];
const SOUND_STYLE_OPTIONS: Array<{hint: string; label: string; value: SoundStyle}> = [
  {value: 'soft', label: '轻柔', hint: '柔和单声'},
  {value: 'short', label: '短促', hint: '短而清楚'},
  {value: 'obvious', label: '明显', hint: '双响完成音'},
  {value: 'long', label: '长音', hint: '持续更久'},
  {value: 'custom', label: '自定义', hint: '自设频率节奏'},
];
const DEFAULT_TUNING_SETTINGS: TuningSettings = {
  autoCalibrationIntervalMs: 3000,
  stableFrameCount: 4,
  frontStableDelta: 0.009,
  sideStableDelta: 0.012,
  ritualMinAmplitudeFront: 0.12,
  ritualMinAmplitudeSide: 0.1,
  prostrationMinAmplitudeFront: 0.08,
  prostrationMinAmplitudeSide: 0.06,
  ritualBottomDepthBias: 1,
  prostrationBottomDepthBias: 1,
  recoveryBias: 1,
  phaseTimeoutRitualMs: 10000,
  phaseTimeoutProstrationMs: 6000,
};
const TUNING_SECTIONS: Array<{hint: string; title: string; fields: TuningField[]}> = [
  {
    title: '自动校准',
    hint: '用于解决手机位置、跪垫位置、站位轻微变化后识别慢慢变偏的问题。',
    fields: [
      {
        key: 'autoCalibrationIntervalMs',
        label: '自动校准间隔(ms)',
        min: 1000,
        max: 10000,
        step: 100,
        description: '系统在稳定姿态下，间隔多久自动重学一次当前位置。',
        effect: '调小会更快适应位置变化；调大会更稳，但适应会变慢。',
      },
      {
        key: 'stableFrameCount',
        label: '稳定帧数',
        min: 2,
        max: 12,
        step: 1,
        description: '连续多少帧足够稳定，系统才会触发自动校准。',
        effect: '调小更容易校准；调大更稳，但需要停得更稳。',
      },
      {
        key: 'frontStableDelta',
        label: '正拍稳定阈值',
        min: 0.003,
        max: 0.03,
        step: 0.001,
        description: '正拍时，相邻两帧头部变化小于这个值就算稳定。',
        effect: '调大更容易判定稳定；调小更严格。',
      },
      {
        key: 'sideStableDelta',
        label: '侧拍稳定阈值',
        min: 0.003,
        max: 0.03,
        step: 0.001,
        description: '侧拍时的稳定阈值，通常比正拍稍大。',
        effect: '调大更容易稳定；调小更严格。',
      },
    ],
  },
  {
    title: '动作幅度',
    hint: '用于控制“动作做得多深才开始算有效”。',
    fields: [
      {
        key: 'ritualMinAmplitudeFront',
        label: '正拍大拜最小幅度',
        min: 0.08,
        max: 0.4,
        step: 0.01,
        description: '完整礼拜模式下，正拍需要至少多大的头部上下位移才开始计数。',
        effect: '调小更容易触发；调大更严格，误判更少。',
      },
      {
        key: 'ritualMinAmplitudeSide',
        label: '侧拍大拜最小幅度',
        min: 0.08,
        max: 0.4,
        step: 0.01,
        description: '完整礼拜模式下，侧拍需要至少多大的动作幅度。',
        effect: '调小侧拍更容易识别；调大更严格。',
      },
      {
        key: 'prostrationMinAmplitudeFront',
        label: '正拍磕头最小幅度',
        min: 0.05,
        max: 0.3,
        step: 0.01,
        description: '磕头模式下，正拍至少要有多大幅度才开始计数。',
        effect: '调小近距离前置镜头更容易识别；调大更严格。',
      },
      {
        key: 'prostrationMinAmplitudeSide',
        label: '侧拍磕头最小幅度',
        min: 0.05,
        max: 0.3,
        step: 0.01,
        description: '磕头模式下，侧拍至少要有多大幅度才开始计数。',
        effect: '调小更灵敏；调大更严格。',
      },
    ],
  },
  {
    title: '到底与起身',
    hint: '用于调整到底深度判定和回正判定。',
    fields: [
      {
        key: 'ritualBottomDepthBias',
        label: '大拜到底宽松度',
        min: 0.6,
        max: 1.6,
        step: 0.05,
        description: '完整礼拜模式下，到底判定的宽松程度。',
        effect: '调大会更容易算到底；调小必须更深才算。',
      },
      {
        key: 'prostrationBottomDepthBias',
        label: '磕头到底宽松度',
        min: 0.6,
        max: 1.6,
        step: 0.05,
        description: '磕头模式下，到底判定的宽松程度。',
        effect: '调大会更容易算头已触底；调小会更严格。',
      },
      {
        key: 'recoveryBias',
        label: '起身恢复宽松度',
        min: 0.7,
        max: 1.4,
        step: 0.05,
        description: '回到上方时，系统判定“已起身/已回正”的宽松程度。',
        effect: '调大会更容易算回正；调小必须起得更高。',
      },
    ],
  },
  {
    title: '解卡',
    hint: '用于解决连续计数多次后卡在某个阶段不再继续的问题。',
    fields: [
      {
        key: 'phaseTimeoutRitualMs',
        label: '大拜解卡超时(ms)',
        min: 2000,
        max: 12000,
        step: 100,
        description: '完整礼拜模式下，某个阶段停留太久后自动复位的时间。',
        effect: '调小会更快解卡；调大会给慢动作更多时间。',
      },
      {
        key: 'phaseTimeoutProstrationMs',
        label: '磕头解卡超时(ms)',
        min: 1500,
        max: 8000,
        step: 100,
        description: '磕头模式下，某个阶段停留太久后自动复位的时间。',
        effect: '调小卡住时恢复更快；调大节奏慢时更不容易被重置。',
      },
    ],
  },
];

function getViewportSize() {
  if (typeof window === 'undefined') {
    return {width: 0, height: 0};
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

export default function KowtowCounter() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const requestRef = useRef<number>();
  const lastVideoTimeRef = useRef(-1);
  const previousCountRef = useRef(0);
  const lastOrientationRef = useRef(false);
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
  const rotatedCanvasRef = useRef<OffscreenCanvas | null>(null);
  const isBowedRef = useRef(false);

  const [viewport, setViewport] = useState(getViewportSize);
  const [count, setCount] = useState(0);
  const [countMode, setCountMode] = useState<CountMode>('ritual');
  const [perspectiveMode, setPerspectiveMode] = useState<PerspectiveMode>('front');
  const [targetCount, setTargetCount] = useState(0);
  const [customTargetInput, setCustomTargetInput] = useState('');
  const [previewMode, setPreviewMode] = useState<PreviewMode>('camera');
  const [isBowed, setIsBowed] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isCounting, setIsCounting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reminderError, setReminderError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [soundStyle, setSoundStyle] = useState<SoundStyle>('obvious');
  const [customToneFrequency, setCustomToneFrequency] = useState('1046');
  const [customToneDuration, setCustomToneDuration] = useState('240');
  const [customToneRepeats, setCustomToneRepeats] = useState('2');
  const [customToneGap, setCustomToneGap] = useState('160');
  const [playCountTickSound, setPlayCountTickSound] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [tuning, setTuning] = useState<TuningSettings>(DEFAULT_TUNING_SETTINGS);

  const isLandscapeViewport = viewport.width > viewport.height;
  const isCompactLandscape = isLandscapeViewport && viewport.height > 0 && viewport.height < 620;
  const targetReached = targetCount > 0 && count >= targetCount;
  const remainingToTarget = targetCount > 0 ? Math.max(targetCount - count, 0) : null;
  const isCustomTarget = targetCount > 0 && !PRESET_TARGET_SET.has(targetCount);

  const updateViewport = useCallback(() => {
    setViewport(getViewportSize());
  }, []);

  useEffect(() => {
    updateViewport();
    window.addEventListener('resize', updateViewport);
    window.addEventListener('orientationchange', updateViewport);

    return () => {
      window.removeEventListener('resize', updateViewport);
      window.removeEventListener('orientationchange', updateViewport);
    };
  }, [updateViewport]);

  const ensureAudioContext = useCallback(async () => {
    if (typeof window === 'undefined') {
      return null;
    }

    const AudioContextClass =
      window.AudioContext ||
      (window as Window & {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;

    if (!AudioContextClass) {
      return null;
    }

    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      audioContextRef.current = new AudioContextClass();
    }

    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }

    return audioContextRef.current;
  }, []);

  const getCompletionToneNotes = useCallback((): ToneNote[] => {
    if (soundStyle === 'soft') {
      return [{frequency: 740, duration: 0.18, delay: 0, oscillator: 'sine', gain: 0.28}];
    }

    if (soundStyle === 'short') {
      return [{frequency: 988, duration: 0.12, delay: 0, oscillator: 'triangle', gain: 0.75}];
    }

    if (soundStyle === 'long') {
      return [
        {frequency: 784, duration: 0.24, delay: 0, oscillator: 'triangle', gain: 0.7},
        {frequency: 1046, duration: 0.4, delay: 0.26, oscillator: 'triangle', gain: 0.85},
      ];
    }

    if (soundStyle === 'custom') {
      const frequency = Math.min(Math.max(Number.parseInt(customToneFrequency, 10) || 1046, 220), 2000);
      const durationMs = Math.min(Math.max(Number.parseInt(customToneDuration, 10) || 240, 80), 1500);
      const repeats = Math.min(Math.max(Number.parseInt(customToneRepeats, 10) || 2, 1), 6);
      const gapMs = Math.min(Math.max(Number.parseInt(customToneGap, 10) || 160, 40), 1500);

      return Array.from({length: repeats}, (_, index) => ({
        frequency,
        duration: durationMs / 1000,
        delay: index * ((durationMs + gapMs) / 1000),
        oscillator: 'triangle' as const,
        gain: 0.85,
      }));
    }

    return [
      {frequency: 880, duration: 0.14, delay: 0, oscillator: 'triangle', gain: 0.75},
      {frequency: 1174, duration: 0.24, delay: 0.16, oscillator: 'triangle', gain: 0.95},
    ];
  }, [customToneDuration, customToneFrequency, customToneGap, customToneRepeats, soundStyle]);

  const playCompletionTone = useCallback(async () => {
    const audioContext = await ensureAudioContext();
    if (!audioContext) {
      return;
    }

    const startAt = audioContext.currentTime;
    const notes = getCompletionToneNotes();
    const endAt =
      notes.reduce((latest, note) => Math.max(latest, note.delay + note.duration), 0) + 0.12;
    const masterGain = audioContext.createGain();
    masterGain.gain.setValueAtTime(0.0001, startAt);
    masterGain.gain.exponentialRampToValueAtTime(0.36, startAt + 0.02);
    masterGain.gain.exponentialRampToValueAtTime(0.0001, startAt + endAt);
    masterGain.connect(audioContext.destination);

    notes.forEach(({delay, duration, frequency, gain: noteGain, oscillator: oscillatorType}) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const noteStart = startAt + delay;
      const noteEnd = noteStart + duration;

      oscillator.type = oscillatorType;
      oscillator.frequency.setValueAtTime(frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(noteGain, noteStart + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);

      oscillator.connect(gain);
      gain.connect(masterGain);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd);
    });
  }, [ensureAudioContext, getCompletionToneNotes]);

  const playCountTickTone = useCallback(async () => {
    const audioContext = await ensureAudioContext();
    if (!audioContext) {
      return;
    }

    const startAt = audioContext.currentTime;
    const masterGain = audioContext.createGain();
    masterGain.gain.setValueAtTime(0.0001, startAt);
    masterGain.gain.exponentialRampToValueAtTime(0.55, startAt + 0.008);
    masterGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.18);
    masterGain.connect(audioContext.destination);

    const lowOscillator = audioContext.createOscillator();
    const lowGain = audioContext.createGain();
    const lowFilter = audioContext.createBiquadFilter();
    lowFilter.type = 'bandpass';
    lowFilter.frequency.setValueAtTime(520, startAt);
    lowFilter.Q.setValueAtTime(8, startAt);
    lowOscillator.type = 'triangle';
    lowOscillator.frequency.setValueAtTime(240, startAt);
    lowOscillator.frequency.exponentialRampToValueAtTime(170, startAt + 0.12);
    lowGain.gain.setValueAtTime(0.0001, startAt);
    lowGain.gain.exponentialRampToValueAtTime(0.9, startAt + 0.006);
    lowGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.14);
    lowOscillator.connect(lowFilter);
    lowFilter.connect(lowGain);
    lowGain.connect(masterGain);
    lowOscillator.start(startAt);
    lowOscillator.stop(startAt + 0.15);

    const highOscillator = audioContext.createOscillator();
    const highGain = audioContext.createGain();
    const highFilter = audioContext.createBiquadFilter();
    highFilter.type = 'bandpass';
    highFilter.frequency.setValueAtTime(1100, startAt);
    highFilter.Q.setValueAtTime(10, startAt);
    highOscillator.type = 'sine';
    highOscillator.frequency.setValueAtTime(820, startAt);
    highOscillator.frequency.exponentialRampToValueAtTime(560, startAt + 0.08);
    highGain.gain.setValueAtTime(0.0001, startAt);
    highGain.gain.exponentialRampToValueAtTime(0.35, startAt + 0.004);
    highGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.1);
    highOscillator.connect(highFilter);
    highFilter.connect(highGain);
    highGain.connect(masterGain);
    highOscillator.start(startAt);
    highOscillator.stop(startAt + 0.11);
  }, [ensureAudioContext]);

  const clearOverlay = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (canvas && context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  const updateBowed = useCallback((value: boolean) => {
    if (isBowedRef.current !== value) {
      isBowedRef.current = value;
      setIsBowed(value);
    }
  }, []);

  const recalibrateMotionTracking = useCallback((baseNoseY?: number) => {
    motionPhaseRef.current = 'READY';
    cycleArmedRef.current = false;
    standingFramesRef.current = 0;
    descentFramesRef.current = 0;
    kneelingFramesRef.current = 0;
    bottomFramesRef.current = 0;
    prostrationBottomFramesRef.current = 0;
    risingFramesRef.current = 0;
    recoveryFramesRef.current = 0;
    stableFramesRef.current = 0;
    lastFilteredNoseYRef.current = baseNoseY ?? null;
    smoothedNoseYRef.current = baseNoseY ?? null;
    minNoseYRef.current = typeof baseNoseY === 'number' ? baseNoseY : 1.0;
    maxNoseYRef.current = typeof baseNoseY === 'number' ? baseNoseY : 0.0;
    lastCalibrationAtRef.current = performance.now();
    phaseStartedAtRef.current = lastCalibrationAtRef.current;
    updateBowed(false);
  }, []);

  const resetMotionTracking = useCallback(() => {
    recalibrateMotionTracking();
    lastVideoTimeRef.current = -1;
    clearOverlay();
  }, [clearOverlay, recalibrateMotionTracking]);

  const stopMediaTracks = useCallback(() => {
    const video = videoRef.current;
    if (!video?.srcObject) {
      return;
    }

    const stream = video.srcObject as MediaStream;
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }, []);

  const getVideoConstraints = useCallback(
    (deviceId: string): MediaTrackConstraints => {
      if (deviceId) {
        return {deviceId: {exact: deviceId}};
      }
      return {facingMode: 'user'};
    },
    [],
  );

  const refreshDevices = useCallback(async (activeOnly = false) => {
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = allDevices.filter((device) => device.kind === 'videoinput');
    setDevices(videoDevices);

    if (!activeOnly && videoDevices.length > 0) {
      setSelectedDeviceId((current) => current || videoDevices[0].deviceId);
    }
  }, []);

  useEffect(() => {
    let active = true;

    const initModel = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks('/wasm');
        const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: '/models/pose_landmarker_lite.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numPoses: 1,
        });

        if (!active) {
          poseLandmarker.close();
          return;
        }

        poseLandmarkerRef.current = poseLandmarker;
        setIsReady(true);
      } catch (modelError) {
        if (active) {
          console.error(modelError);
          setError('AI 模型加载失败，请检查安装包资源是否完整。');
        }
      }
    };

    initModel();
    void refreshDevices();
    lastOrientationRef.current = window.innerWidth > window.innerHeight;

    return () => {
      active = false;
      stopMediaTracks();
      if (poseLandmarkerRef.current) {
        poseLandmarkerRef.current.close();
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        void audioContextRef.current.close();
      }
    };
  }, [refreshDevices, stopMediaTracks]);

  const startCameraWithId = useCallback(
    async (deviceId: string, resumeCounting = false) => {
      const video = videoRef.current;
      if (!video) {
        return;
      }

      setError(null);
      setIsCounting(false);
      resetMotionTracking();
      stopMediaTracks();
      await ensureAudioContext();

      try {
        const metadataLoaded = new Promise<void>((resolve) => {
          video.onloadedmetadata = () => {
            resolve();
          };
        });

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: getVideoConstraints(deviceId),
        });

        video.srcObject = stream;
        await metadataLoaded;
        await video.play();
        setIsRunning(true);
        setIsCounting(resumeCounting);
        await refreshDevices(true);
      } catch (cameraError) {
        console.error(cameraError);
        setError('无法访问摄像头，请确认权限已授予，或切换其他摄像头重试。');
        setIsRunning(false);
        setIsCounting(false);
        }
    },
    [ensureAudioContext, getVideoConstraints, refreshDevices, resetMotionTracking, stopMediaTracks],
  );

  const stopCamera = useCallback(() => {
    stopMediaTracks();
    setIsCounting(false);
    resetMotionTracking();
    setIsRunning(false);
  }, [resetMotionTracking, stopMediaTracks]);

  const renderLoop = useCallback(() => {
    if (!isRunning || !videoRef.current || !canvasRef.current || !poseLandmarkerRef.current) {
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');

    if (video.currentTime !== lastVideoTimeRef.current && video.readyState >= 2) {
      lastVideoTimeRef.current = video.currentTime;

      const isLandscapeStream = video.videoWidth > video.videoHeight;
      const frameW = isLandscapeStream ? video.videoHeight : video.videoWidth;
      const frameH = isLandscapeStream ? video.videoWidth : video.videoHeight;

      if (canvas.width !== frameW || canvas.height !== frameH) {
        canvas.width = frameW;
        canvas.height = frameH;
      }

      let detectionSource: OffscreenCanvas | HTMLVideoElement = video;

      if (isLandscapeStream) {
        if (
          !rotatedCanvasRef.current ||
          rotatedCanvasRef.current.width !== frameW ||
          rotatedCanvasRef.current.height !== frameH
        ) {
          rotatedCanvasRef.current = new OffscreenCanvas(frameW, frameH);
        }
        const offCtx = rotatedCanvasRef.current.getContext('2d');
        if (!offCtx) {
          requestRef.current = requestAnimationFrame(renderLoop);
          return;
        }
        offCtx.clearRect(0, 0, frameW, frameH);
        offCtx.save();
        offCtx.translate(0, frameH);
        offCtx.rotate(-Math.PI / 2);
        offCtx.drawImage(video, 0, 0);
        offCtx.restore();
        detectionSource = rotatedCanvasRef.current;
      }

      const results = poseLandmarkerRef.current.detectForVideo(detectionSource, performance.now());

      if (context) {
        context.clearRect(0, 0, canvas.width, canvas.height);

        if (previewMode === 'camera' && isLandscapeStream && rotatedCanvasRef.current) {
          context.drawImage(rotatedCanvasRef.current, 0, 0);
        } else if (previewMode === 'camera' && !isLandscapeStream) {
          context.drawImage(video, 0, 0);
        } else if (previewMode !== 'camera') {
          context.fillStyle = '#0c0a09';
          context.fillRect(0, 0, canvas.width, canvas.height);
        }

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

          if (!isCounting) {
            requestRef.current = requestAnimationFrame(renderLoop);
            return;
          }

          const landmarks = results.landmarks[0];
          const nose = landmarks[0];
          const leftShoulder = landmarks[11];
          const rightShoulder = landmarks[12];

          const noseVis = nose?.visibility ?? 0;
          const lShoulderVis = leftShoulder?.visibility ?? 0;
          const rShoulderVis = rightShoulder?.visibility ?? 0;
          const landmarkReliable = noseVis > 0.5 && (lShoulderVis > 0.5 || rShoulderVis > 0.5);

          if (nose && leftShoulder && rightShoulder && landmarkReliable) {
            const now = performance.now();
            const leftShoulderVisibility = leftShoulder.visibility ?? 0;
            const rightShoulderVisibility = rightShoulder.visibility ?? 0;
            const dominantShoulder =
              leftShoulderVisibility >= rightShoulderVisibility ? leftShoulder : rightShoulder;
            const shoulderY =
              perspectiveMode === 'side'
                ? dominantShoulder.y
                : (leftShoulder.y + rightShoulder.y) / 2;
            const filteredNoseY =
              smoothedNoseYRef.current === null
                ? nose.y
                : smoothedNoseYRef.current * 0.5 + nose.y * 0.5;

            smoothedNoseYRef.current = filteredNoseY;
            const noseDelta =
              lastFilteredNoseYRef.current === null
                ? 0
                : Math.abs(filteredNoseY - lastFilteredNoseYRef.current);
            lastFilteredNoseYRef.current = filteredNoseY;
            stableFramesRef.current =
              noseDelta <
              (perspectiveMode === 'side' ? tuning.sideStableDelta : tuning.frontStableDelta)
                ? stableFramesRef.current + 1
                : 0;

            minNoseYRef.current = Math.min(
              1.0,
              minNoseYRef.current + (perspectiveMode === 'side' ? 0.00022 : 0.00016),
            );
            maxNoseYRef.current = Math.max(
              0.0,
              maxNoseYRef.current - (perspectiveMode === 'side' ? 0.00022 : 0.00016),
            );

            if (filteredNoseY < minNoseYRef.current) {
              minNoseYRef.current = filteredNoseY;
            }
            if (filteredNoseY > maxNoseYRef.current) {
              maxNoseYRef.current = filteredNoseY;
            }

            const amplitude = maxNoseYRef.current - minNoseYRef.current;
            const hasRitualRange =
              amplitude >
              (perspectiveMode === 'side'
                ? tuning.ritualMinAmplitudeSide
                : tuning.ritualMinAmplitudeFront);
            const hasProstrationRange =
              amplitude >
              (perspectiveMode === 'side'
                ? tuning.prostrationMinAmplitudeSide
                : tuning.prostrationMinAmplitudeFront);
            const standingThreshold =
              minNoseYRef.current +
              amplitude *
                (perspectiveMode === 'side'
                  ? 0.35 * tuning.recoveryBias
                  : 0.3 * tuning.recoveryBias);
            const bowThreshold =
              minNoseYRef.current + amplitude * (perspectiveMode === 'side' ? 0.33 : 0.36);
            const kneelingThreshold =
              minNoseYRef.current + amplitude * (perspectiveMode === 'side' ? 0.52 : 0.58);
            const bottomThreshold =
              maxNoseYRef.current -
              amplitude *
                (perspectiveMode === 'side'
                  ? 0.13 * tuning.ritualBottomDepthBias
                  : 0.1 * tuning.ritualBottomDepthBias);
            const risingThreshold =
              maxNoseYRef.current -
              amplitude *
                (perspectiveMode === 'side'
                  ? 0.28 * tuning.recoveryBias
                  : 0.24 * tuning.recoveryBias);
            const prostrationReadyThreshold =
              minNoseYRef.current +
              amplitude *
                (perspectiveMode === 'side'
                  ? 0.36 * tuning.recoveryBias
                  : 0.42 * tuning.recoveryBias);
            const prostrationBottomThreshold =
              maxNoseYRef.current -
              amplitude *
                (perspectiveMode === 'side'
                  ? 0.08 * tuning.prostrationBottomDepthBias
                  : 0.06 * tuning.prostrationBottomDepthBias);
            const standingPose = filteredNoseY <= standingThreshold;
            const bowingPose = filteredNoseY >= bowThreshold;
            const kneelingPose = filteredNoseY >= kneelingThreshold;
            const bottomPose = filteredNoseY >= bottomThreshold;
            const risingPose = filteredNoseY <= risingThreshold;
            const prostrationReadyPose = filteredNoseY <= prostrationReadyThreshold;
            const prostrationBottomPose = filteredNoseY >= prostrationBottomThreshold;

            standingFramesRef.current = standingPose ? standingFramesRef.current + 1 : 0;
            descentFramesRef.current = bowingPose ? descentFramesRef.current + 1 : 0;
            kneelingFramesRef.current = kneelingPose ? kneelingFramesRef.current + 1 : 0;
            bottomFramesRef.current = bottomPose ? bottomFramesRef.current + 1 : 0;
            prostrationBottomFramesRef.current = prostrationBottomPose
              ? prostrationBottomFramesRef.current + 1
              : 0;
            risingFramesRef.current = risingPose ? risingFramesRef.current + 1 : 0;
            recoveryFramesRef.current = prostrationReadyPose ? recoveryFramesRef.current + 1 : 0;
            const readyPose = countMode === 'ritual' ? standingPose : prostrationReadyPose;
            const shouldAutoCalibrate =
              now - lastCalibrationAtRef.current >= tuning.autoCalibrationIntervalMs &&
              stableFramesRef.current >= tuning.stableFrameCount &&
              readyPose &&
              motionPhaseRef.current === 'READY' &&
              !cycleArmedRef.current;
            const phaseTimedOut =
              motionPhaseRef.current !== 'READY' &&
              now - phaseStartedAtRef.current >=
                (countMode === 'ritual'
                  ? tuning.phaseTimeoutRitualMs
                  : tuning.phaseTimeoutProstrationMs);
            const transitionPhase = (nextPhase: MotionPhase) => {
              if (motionPhaseRef.current !== nextPhase) {
                motionPhaseRef.current = nextPhase;
                phaseStartedAtRef.current = now;
              }
            };

            if (showDebug && context) {
              context.save();
              context.font = `${Math.round(canvas.width * 0.032)}px monospace`;
              context.fillStyle = 'rgba(0,0,0,0.6)';
              context.fillRect(0, canvas.height - canvas.width * 0.28, canvas.width, canvas.width * 0.28);
              context.fillStyle = '#34d399';
              const lh = canvas.width * 0.038;
              const bx = canvas.width * 0.02;
              let by = canvas.height - canvas.width * 0.26;
              const lines = [
                `Phase: ${motionPhaseRef.current}`,
                `NoseY: ${filteredNoseY.toFixed(3)}  ShoulderY: ${shoulderY.toFixed(3)}`,
                `Min: ${minNoseYRef.current.toFixed(3)}  Max: ${maxNoseYRef.current.toFixed(3)}  Amp: ${amplitude.toFixed(3)}`,
                `Standing: ${standingPose}  Bowing: ${bowingPose}  Bottom: ${bottomPose}`,
                `Armed: ${cycleArmedRef.current}  Reliable: ${landmarkReliable}`,
                `StandF: ${standingFramesRef.current}  BottomF: ${bottomFramesRef.current}  RiseF: ${risingFramesRef.current}`,
              ];
              for (const line of lines) {
                context.fillText(line, bx, by);
                by += lh;
              }
              context.restore();
            }

            if (phaseTimedOut || shouldAutoCalibrate) {
              recalibrateMotionTracking(filteredNoseY);
              cycleArmedRef.current = readyPose;
            } else if (countMode === 'prostration') {
              if (!hasProstrationRange) {
                if (recoveryFramesRef.current >= 2) {
                  cycleArmedRef.current = true;
                }
                updateBowed(false);
              } else {
                if (
                  motionPhaseRef.current !== 'READY' &&
                  motionPhaseRef.current !== 'PROSTRATION_BOTTOM'
                ) {
                  transitionPhase('READY');
                }

                switch (motionPhaseRef.current) {
                  case 'READY':
                    updateBowed(false);
                    if (recoveryFramesRef.current >= 2) {
                      cycleArmedRef.current = true;
                    }

                    if (cycleArmedRef.current && prostrationBottomFramesRef.current >= 2) {
                      transitionPhase('PROSTRATION_BOTTOM');
                      updateBowed(true);
                    }
                    break;
                  case 'PROSTRATION_BOTTOM':
                    updateBowed(true);
                    if (recoveryFramesRef.current >= 2) {
                      transitionPhase('READY');
                      cycleArmedRef.current = false;
                      updateBowed(false);
                      setCount((current) => current + 1);
                    }
                    break;
                  default:
                    transitionPhase('READY');
                    updateBowed(false);
                    break;
                }
              }
            } else if (!hasRitualRange) {
              if (standingFramesRef.current >= 3) {
                cycleArmedRef.current = true;
              }
              updateBowed(false);
            } else {
              switch (motionPhaseRef.current) {
                case 'READY':
                  updateBowed(false);
                  if (standingFramesRef.current >= 3) {
                    cycleArmedRef.current = true;
                  }

                  if (cycleArmedRef.current && descentFramesRef.current >= 2) {
                    transitionPhase('DESCENDING');
                    updateBowed(true);
                  }
                  break;
                case 'DESCENDING':
                  updateBowed(true);
                  if (kneelingFramesRef.current >= 2) {
                    transitionPhase('KNEELING');
                  } else if (standingFramesRef.current >= 2) {
                    transitionPhase('READY');
                    updateBowed(false);
                  }
                  break;
                case 'KNEELING':
                  updateBowed(true);
                  if (bottomFramesRef.current >= 2) {
                    transitionPhase('BOTTOM');
                  } else if (standingFramesRef.current >= 2) {
                    transitionPhase('READY');
                    updateBowed(false);
                  }
                  break;
                case 'BOTTOM':
                  updateBowed(true);
                  if (risingFramesRef.current >= 2) {
                    transitionPhase('ASCENDING');
                  }
                  break;
                case 'ASCENDING':
                  updateBowed(true);
                  if (standingFramesRef.current >= 2) {
                    transitionPhase('READY');
                    cycleArmedRef.current = false;
                    updateBowed(false);
                    setCount((current) => current + 1);
                  } else if (bottomFramesRef.current >= 2) {
                    transitionPhase('BOTTOM');
                  }
                  break;
                case 'PROSTRATION_BOTTOM':
                  transitionPhase('READY');
                  updateBowed(false);
                  break;
              }
            }
          }
        } else if (isCounting) {
          updateBowed(false);
        }
      }
    }

    requestRef.current = requestAnimationFrame(renderLoop);
  }, [countMode, isCounting, isRunning, perspectiveMode, previewMode, recalibrateMotionTracking, tuning]);

  useEffect(() => {
    if (isRunning) {
      requestRef.current = requestAnimationFrame(renderLoop);
    } else if (requestRef.current) {
      cancelAnimationFrame(requestRef.current);
    }

    return () => {
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }
    };
  }, [isRunning, renderLoop]);

  useEffect(() => {
    const previousCount = previousCountRef.current;

    if (count > previousCount && playCountTickSound) {
      void playCountTickTone();
    }

    if (targetCount > 0 && previousCount < targetCount && count >= targetCount) {
      const completionDelay = count > previousCount && playCountTickSound ? 160 : 0;
      window.setTimeout(() => {
        void playCompletionTone();
      }, completionDelay);
    }

    previousCountRef.current = count;
  }, [count, playCompletionTone, playCountTickSound, playCountTickTone, targetCount]);

  useEffect(() => {
    if (!isRunning) {
      lastOrientationRef.current = isLandscapeViewport;
      return;
    }

    if (lastOrientationRef.current === isLandscapeViewport) {
      return;
    }

    lastOrientationRef.current = isLandscapeViewport;
    void startCameraWithId(selectedDeviceId, isCounting);
  }, [isCounting, isLandscapeViewport, isRunning, selectedDeviceId, startCameraWithId]);

  const applyTargetCount = useCallback(
    (value: number) => {
      previousCountRef.current = count;
      setTargetCount(value);
      setReminderError(null);
      if (value > 0 && !PRESET_TARGET_SET.has(value)) {
        setCustomTargetInput(String(value));
      }
      void ensureAudioContext();
    },
    [count, ensureAudioContext],
  );

  const startCamera = () => {
    void startCameraWithId(selectedDeviceId);
  };

  const handleDeviceChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextDeviceId = event.target.value;
    setSelectedDeviceId(nextDeviceId);

    if (isRunning) {
      void startCameraWithId(nextDeviceId, isCounting);
    }
  };

  const handleCountModeChange = (nextMode: CountMode) => {
    if (countMode === nextMode) {
      return;
    }

    setCountMode(nextMode);
    resetMotionTracking();
  };

  const handlePerspectiveModeChange = (nextMode: PerspectiveMode) => {
    if (perspectiveMode === nextMode) {
      return;
    }

    setPerspectiveMode(nextMode);
    resetMotionTracking();
  };

  const handleTuningChange = (key: keyof TuningSettings, value: number) => {
    if (!Number.isFinite(value)) {
      return;
    }

    setTuning((current) => ({
      ...current,
      [key]: value,
    }));
    resetMotionTracking();
  };

  const resetTuningSettings = () => {
    setTuning(DEFAULT_TUNING_SETTINGS);
    resetMotionTracking();
  };

  const handleToggleCounting = () => {
    if (!isRunning) {
      return;
    }

    if (isCounting) {
      setIsCounting(false);
      resetMotionTracking();
      return;
    }

    void ensureAudioContext();
    resetMotionTracking();
    setIsCounting(true);
  };

  const applyCustomTarget = () => {
    const parsedTarget = Number.parseInt(customTargetInput, 10);
    if (!Number.isInteger(parsedTarget) || parsedTarget < 1) {
      setReminderError('自定义提醒次数请输入大于 0 的整数。');
      return;
    }

    applyTargetCount(parsedTarget);
  };

  const resetCount = () => {
    previousCountRef.current = 0;
    setCount(0);
    resetMotionTracking();
  };

  const statusText = !isCounting ? '待开始' : isBowed ? '动作中' : '计数中';
  const previewBadgeText = previewMode === 'camera' ? '显示原画面' : '仅显示骨架';
  const countModeBadgeText = countMode === 'ritual' ? '完整礼拜' : '磕头数';
  const perspectiveModeBadgeText = perspectiveMode === 'front' ? '正拍模式' : '侧拍模式';
  const cameraStageClassName = isCompactLandscape
    ? 'w-full min-h-[56vh] rounded-2xl border border-stone-700/50 bg-stone-950 shadow-inner overflow-hidden relative'
    : 'w-full aspect-[9/16] min-h-[62vh] max-h-[78vh] rounded-2xl border border-stone-700/50 bg-stone-950 shadow-inner overflow-hidden relative';
  const previewLayerStyle = {
    width: '100%',
    height: '100%',
    transform: 'translate(-50%, -50%) scaleX(-1)',
    transformOrigin: 'center center' as const,
  };

  return (
    <div
      className={
        isCompactLandscape
          ? 'min-h-screen bg-stone-900 px-4 py-4 text-stone-100'
          : 'min-h-screen bg-stone-900 px-4 py-8 text-stone-100'
      }
    >
      <div className={isCompactLandscape ? 'mx-auto max-w-5xl space-y-4' : 'mx-auto max-w-5xl space-y-8'}>
        <div className={isCompactLandscape ? 'space-y-1 text-center' : 'space-y-2 text-center'}>
          <h1
            className={
              isCompactLandscape
                ? 'text-3xl font-bold tracking-tight text-emerald-400'
                : 'text-4xl font-bold tracking-tight text-emerald-400 md:text-5xl'
            }
          >
            大拜计数器
          </h1>
          <p className={isCompactLandscape ? 'text-sm text-stone-400' : 'text-lg text-stone-400'}>
            基于本地姿态识别的礼拜计数工具
          </p>
        </div>

        <div
          className={
            isCompactLandscape
              ? 'rounded-3xl border border-stone-700/50 bg-stone-800 p-4 shadow-2xl'
              : 'rounded-3xl border border-stone-700/50 bg-stone-800 p-6 shadow-2xl md:p-8'
          }
        >
          <div className={isCompactLandscape ? 'flex flex-row gap-4' : 'flex flex-col gap-8'}>
            <div
              className={
                isCompactLandscape
                  ? 'flex w-[18rem] max-w-[42vw] flex-shrink-0 flex-col justify-between gap-4'
                  : 'flex w-full flex-col items-center gap-4'
              }
            >
              <div className={isCompactLandscape ? 'space-y-4' : 'space-y-4 text-center'}>
                <div className="space-y-2">
                  <div
                    className={
                      isCompactLandscape
                        ? 'text-6xl font-black leading-none tracking-tighter text-white tabular-nums'
                        : 'text-8xl font-black leading-none tracking-tighter text-white tabular-nums md:text-[12rem]'
                    }
                  >
                    {count}
                  </div>
                  <div className="flex items-center justify-center gap-2 text-sm font-medium uppercase tracking-[0.3em] text-stone-400">
                    <Activity className="h-5 w-5 text-emerald-500" />
                    已完成
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-2">
                  <div
                    className={`rounded-full border px-4 py-2 text-sm font-bold transition-colors ${
                      isBowed
                        ? 'border-emerald-500/30 bg-emerald-500/20 text-emerald-300'
                        : 'border-stone-600/60 bg-stone-700/60 text-stone-300'
                    }`}
                  >
                    {statusText}
                  </div>

                  <div
                    className={`rounded-full border px-4 py-2 text-sm font-semibold ${
                      targetCount === 0
                        ? 'border-stone-600/60 bg-stone-700/60 text-stone-300'
                        : targetReached
                          ? 'border-amber-400/30 bg-amber-400/15 text-amber-200'
                          : 'border-sky-400/30 bg-sky-400/15 text-sky-200'
                    }`}
                  >
                    {targetCount === 0
                      ? '提醒关闭'
                      : targetReached
                        ? `${targetCount} 拜已提醒`
                        : `还差 ${remainingToTarget} 拜`}
                  </div>
                </div>
              </div>
            </div>

            <div
              className={
                isCompactLandscape
                  ? 'flex min-w-0 flex-1 flex-col gap-4'
                  : 'flex w-full min-w-0 flex-col items-center gap-4'
              }
            >
              <div className={cameraStageClassName}>
                {!isReady && !error && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-stone-400">
                    <div className="h-8 w-8 animate-spin rounded-full border-4 border-emerald-500 border-t-transparent" />
                    <p>正在加载 AI 模型...</p>
                  </div>
                )}

                {error && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-950/20 p-6 text-center text-red-400">
                    <Info className="mb-2 h-10 w-10" />
                    <p>{error}</p>
                  </div>
                )}

                {!isRunning && isReady && !error && (
                  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-stone-900/80 text-stone-400 backdrop-blur-sm">
                    <CameraOff className="mb-4 h-12 w-12 opacity-50" />
                    <p>摄像头已关闭</p>
                  </div>
                )}

                <div className="absolute left-3 top-3 z-20 flex flex-wrap gap-2">
                  <div className="rounded-full border border-stone-700/70 bg-stone-950/75 px-3 py-1 text-xs font-semibold text-stone-200">
                    {previewBadgeText}
                  </div>
                  <div className="rounded-full border border-stone-700/70 bg-stone-950/75 px-3 py-1 text-xs font-semibold text-stone-200">
                    {countModeBadgeText}
                  </div>
                  <div className="rounded-full border border-stone-700/70 bg-stone-950/75 px-3 py-1 text-xs font-semibold text-stone-200">
                    {perspectiveModeBadgeText}
                  </div>
                  {targetCount > 0 && (
                    <div className="rounded-full border border-stone-700/70 bg-stone-950/75 px-3 py-1 text-xs font-semibold text-stone-200">
                      目标提醒 {targetCount} 拜
                    </div>
                  )}
                </div>

                <div
                  className="pointer-events-none absolute left-1/2 top-1/2 overflow-hidden"
                  style={previewLayerStyle}
                >
                  <video
                    ref={videoRef}
                    className="absolute inset-0 h-0 w-0 opacity-0"
                    muted
                    playsInline
                  />
                  <canvas
                    ref={canvasRef}
                    className="absolute inset-0 z-10 h-full w-full object-contain"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-stone-700/50 bg-stone-800/60 p-4">
            <div className="flex flex-col gap-3 md:flex-row">
              <button
                type="button"
                onClick={handleToggleCounting}
                disabled={!isRunning}
                className={`flex flex-1 items-center justify-center gap-2 rounded-2xl px-6 py-4 text-lg font-bold transition-all active:scale-95 disabled:bg-stone-700 disabled:from-stone-700 disabled:text-stone-500 disabled:to-stone-700 ${
                  isCounting
                    ? 'border border-orange-400/30 bg-orange-500/15 text-orange-200'
                    : 'bg-gradient-to-r from-orange-500 to-red-500 text-white shadow-lg shadow-orange-950/30'
                }`}
              >
                {isCounting ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6" />}
                {isCounting ? '暂停计数' : '开始计数'}
              </button>

              {!isRunning ? (
                <button
                  type="button"
                  onClick={startCamera}
                  disabled={!isReady}
                  className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-6 py-4 text-lg font-bold text-white shadow-lg shadow-emerald-900/20 transition-all active:scale-95 disabled:bg-stone-700 disabled:text-stone-500"
                >
                  <Camera className="h-6 w-6" />
                  开启摄像头
                </button>
              ) : (
                <button
                  type="button"
                  onClick={stopCamera}
                  className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-red-500/20 bg-red-500/10 px-6 py-4 text-lg font-bold text-red-400 transition-all active:scale-95"
                >
                  <CameraOff className="h-6 w-6" />
                  关闭摄像头
                </button>
              )}

              <button
                type="button"
                onClick={resetCount}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-stone-700 bg-stone-900 px-6 py-4 text-lg font-bold text-stone-200 transition-all active:scale-95"
              >
                <RefreshCw className="h-6 w-6" />
                计数清零
              </button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-stone-400">
              先开启摄像头，再点击“开始计数”。计数逻辑已恢复为原版动态幅度判断：完整站立到到底再回站立，才记 1 次。
            </p>
          </div>

          <div className="rounded-2xl border border-stone-700/50 bg-stone-800/60 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-200">
              <Camera className="h-4 w-4 text-sky-300" />
              拍摄角度
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {PERSPECTIVE_MODE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handlePerspectiveModeChange(option.value)}
                  className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                    perspectiveMode === option.value
                      ? 'border-sky-400 bg-sky-400/15 text-sky-100'
                      : 'border-stone-700 bg-stone-900 text-stone-200'
                  }`}
                >
                  <div className="text-sm font-semibold">{option.label}</div>
                  <div className="mt-1 text-xs text-stone-400">{option.hint}</div>
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-stone-400">
              空间不够、手机只能摆在身体侧边时，切到“侧拍模式”。这个模式会用更适合侧面视角的阈值和自动校准策略。
            </p>
          </div>

          <div className="rounded-2xl border border-stone-700/50 bg-stone-800/60 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-200">
              <Activity className="h-4 w-4 text-emerald-400" />
              计数模式
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {COUNT_MODE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleCountModeChange(option.value)}
                  className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                    countMode === option.value
                      ? 'border-emerald-400 bg-emerald-400/15 text-emerald-100'
                      : 'border-stone-700 bg-stone-900 text-stone-200'
                  }`}
                >
                  <div className="text-sm font-semibold">{option.label}</div>
                  <div className="mt-1 text-xs text-stone-400">{option.hint}</div>
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-stone-400">
              前置镜头取景偏大、人像拍不全时，可以切到“磕头数”模式。这个模式只在头部磕到底后再起身时记 1 次，弯腰鞠躬不会计数。
            </p>
          </div>

          <div className="rounded-2xl border border-stone-700/50 bg-stone-800/60 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-200">
              <Settings className="h-4 w-4 text-stone-400" />
              摄像头选择
            </div>
            <select
              value={selectedDeviceId}
              onChange={handleDeviceChange}
              className="w-full rounded-xl border border-stone-700 bg-stone-900 px-4 py-3 text-sm text-stone-100 outline-none"
            >
              {devices.length === 0 && <option value="">默认摄像头</option>}
              {devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `摄像头 ${index + 1}`}
                </option>
              ))}
            </select>
            <p className="mt-3 text-xs leading-relaxed text-stone-400">
              这个板块已放到“开启摄像头 / 开始计数”下面，切换摄像头时会自动重新取流。
            </p>
          </div>

          <div className="rounded-2xl border border-stone-700/50 bg-stone-800/60 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-200">
              {previewMode === 'camera' ? (
                <Eye className="h-4 w-4 text-stone-400" />
              ) : (
                <EyeOff className="h-4 w-4 text-stone-400" />
              )}
              画面显示
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setPreviewMode('camera')}
                className={`flex-1 rounded-xl px-4 py-3 text-sm font-semibold transition-colors ${
                  previewMode === 'camera'
                    ? 'bg-emerald-500 text-stone-950'
                    : 'border border-stone-700 bg-stone-900 text-stone-200'
                }`}
              >
                显示原画面
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode('skeleton')}
                className={`flex-1 rounded-xl px-4 py-3 text-sm font-semibold transition-colors ${
                  previewMode === 'skeleton'
                    ? 'bg-emerald-500 text-stone-950'
                    : 'border border-stone-700 bg-stone-900 text-stone-200'
                }`}
              >
                仅显示骨架
              </button>
            </div>
            <button
              type="button"
              onClick={() => setShowDebug((prev) => !prev)}
              className={`mt-3 w-full rounded-xl px-4 py-3 text-sm font-semibold transition-colors ${
                showDebug
                  ? 'bg-amber-500 text-stone-950'
                  : 'border border-stone-700 bg-stone-900 text-stone-200'
              }`}
            >
              {showDebug ? '关闭调试信息' : '显示调试信息'}
            </button>
          </div>

          <div className="rounded-2xl border border-stone-700/50 bg-stone-800/60 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-200">
              <BellRing className="h-4 w-4 text-amber-300" />
              完成提醒
            </div>
            <div className="flex flex-wrap gap-3">
              {PRESET_TARGETS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => applyTargetCount(option)}
                  className={`rounded-xl px-4 py-3 text-sm font-semibold transition-colors ${
                    targetCount === option
                      ? 'bg-amber-400 text-stone-950'
                      : 'border border-stone-700 bg-stone-900 text-stone-200'
                  }`}
                >
                  {option === 0 ? '不提醒' : `${option} 拜`}
                </button>
              ))}
            </div>

            <div className="mt-3 flex flex-col gap-3 md:flex-row">
              <input
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={customTargetInput}
                onChange={(event) => setCustomTargetInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    applyCustomTarget();
                  }
                }}
                placeholder="自定义提醒次数，例如 5 或 21"
                className={`flex-1 rounded-xl border px-4 py-3 text-sm text-stone-100 outline-none ${
                  isCustomTarget ? 'border-amber-400 bg-stone-900' : 'border-stone-700 bg-stone-900'
                }`}
              />
              <button
                type="button"
                onClick={applyCustomTarget}
                className={`rounded-xl px-5 py-3 text-sm font-semibold transition-colors ${
                  isCustomTarget
                    ? 'bg-amber-400 text-stone-950'
                    : 'border border-stone-700 bg-stone-900 text-stone-200'
                }`}
              >
                设为自定义提醒
              </button>
            </div>

            {reminderError && <p className="mt-3 text-sm text-red-400">{reminderError}</p>}

            <p className="mt-3 text-xs leading-relaxed text-stone-400">
              预设支持 36 拜、72 拜、108 拜，也可以自定义次数，方便直接测试提醒音。
            </p>
          </div>

          <div className="rounded-2xl border border-stone-700/50 bg-stone-800/60 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-200">
              <Volume2 className="h-4 w-4 text-sky-300" />
              提示音选择
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {SOUND_STYLE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setSoundStyle(option.value)}
                  className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                    soundStyle === option.value
                      ? 'border-sky-400 bg-sky-400/15 text-sky-100'
                      : 'border-stone-700 bg-stone-900 text-stone-200'
                  }`}
                >
                  <div className="text-sm font-semibold">{option.label}</div>
                  <div className="mt-1 text-xs text-stone-400">{option.hint}</div>
                </button>
              ))}
            </div>

            {soundStyle === 'custom' && (
              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <label className="space-y-2 text-sm text-stone-300">
                  <span className="block text-xs text-stone-400">频率 Hz</span>
                  <input
                    type="number"
                    min="220"
                    max="2000"
                    step="1"
                    inputMode="numeric"
                    value={customToneFrequency}
                    onChange={(event) => setCustomToneFrequency(event.target.value)}
                    className="w-full rounded-xl border border-stone-700 bg-stone-900 px-4 py-3 text-sm text-stone-100 outline-none"
                  />
                </label>

                <label className="space-y-2 text-sm text-stone-300">
                  <span className="block text-xs text-stone-400">时长 ms</span>
                  <input
                    type="number"
                    min="80"
                    max="1500"
                    step="10"
                    inputMode="numeric"
                    value={customToneDuration}
                    onChange={(event) => setCustomToneDuration(event.target.value)}
                    className="w-full rounded-xl border border-stone-700 bg-stone-900 px-4 py-3 text-sm text-stone-100 outline-none"
                  />
                </label>

                <label className="space-y-2 text-sm text-stone-300">
                  <span className="block text-xs text-stone-400">重复次数</span>
                  <input
                    type="number"
                    min="1"
                    max="6"
                    step="1"
                    inputMode="numeric"
                    value={customToneRepeats}
                    onChange={(event) => setCustomToneRepeats(event.target.value)}
                    className="w-full rounded-xl border border-stone-700 bg-stone-900 px-4 py-3 text-sm text-stone-100 outline-none"
                  />
                </label>

                <label className="space-y-2 text-sm text-stone-300">
                  <span className="block text-xs text-stone-400">间隔 ms</span>
                  <input
                    type="number"
                    min="40"
                    max="1500"
                    step="10"
                    inputMode="numeric"
                    value={customToneGap}
                    onChange={(event) => setCustomToneGap(event.target.value)}
                    className="w-full rounded-xl border border-stone-700 bg-stone-900 px-4 py-3 text-sm text-stone-100 outline-none"
                  />
                </label>
              </div>
            )}

            <button
              type="button"
              onClick={() => void playCompletionTone()}
              className="mt-4 rounded-xl border border-sky-400/30 bg-sky-400/10 px-5 py-3 text-sm font-semibold text-sky-100 transition-colors active:scale-95"
            >
              试听当前提示音
            </button>

            <p className="mt-3 text-xs leading-relaxed text-stone-400">
              这里提供轻柔、短促、明显、长音四种预设，也支持自定义频率、时长、重复次数和间隔，方便你直接在手机上调到更醒目的完成提醒。
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-stone-700/50 bg-stone-800/60 p-4">
          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-stone-600 bg-stone-900 px-5 py-4 text-base font-semibold text-stone-100 transition-colors active:scale-95"
          >
            <Settings className="h-5 w-5 text-emerald-400" />
            打开参数设置
          </button>
          <p className="mt-3 text-xs leading-relaxed text-stone-400">
            自动校准、动作幅度、到底判定、解卡超时、每次计数木鱼音效，都在这里集中调节。
          </p>
        </div>

        <div className="rounded-2xl border border-stone-700/50 bg-stone-800/60 p-4 text-sm text-stone-300">
          <div className="mb-2 flex items-center gap-2 font-semibold text-stone-100">
            <Smartphone className="h-4 w-4 text-emerald-400" />
            横屏支持
          </div>
          <p className="leading-relaxed text-stone-400">
            横过手机时会自动切到更宽的取景比例，前置摄像头更容易完整拍到上半身。说明卡现在放到底部，不再占用视频显示区域。
          </p>
        </div>

        <div className="rounded-2xl border border-stone-700/50 bg-stone-800/50 p-6 text-sm leading-relaxed text-stone-400">
          <h3 className="mb-2 flex items-center gap-2 font-bold text-stone-200">
            <Info className="h-4 w-4" />
            使用说明
          </h3>
          <ul className="list-disc space-y-1 pl-5">
            <li>佛家的大拜是“合十站立 → 鞠躬 → 跪下磕头 → 再起身站立”的完整往返，系统会按这个完整过程记数。</li>
            <li>第一拜会帮助系统学习你的最高点和最低点，之后的动态阈值会更稳定。</li>
            <li>开始计数前请先打开摄像头；如果想重新校准动作，暂停计数后再次开始即可。</li>
            <li>鞠躬、弯腰、跪立、半起身这些中间动作只会被当成过程，不会单独计数。</li>
            <li>所有姿态处理都在设备本地完成，不会上传视频内容。</li>
          </ul>
        </div>

        {isSettingsOpen && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-stone-950/80 p-3 backdrop-blur-sm md:items-center md:p-6">
            <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-stone-700 bg-stone-900 shadow-2xl">
              <div className="flex items-start justify-between gap-4 border-b border-stone-800 px-5 py-4">
                <div className="space-y-1">
                  <h3 className="text-lg font-bold text-stone-100">参数设置</h3>
                  <p className="text-sm text-stone-400">
                    这里可以调整自动校准、动作阈值、解卡时间和每次计数的木鱼音效。修改后会立即生效。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(false)}
                  className="rounded-xl border border-stone-700 bg-stone-800 p-2 text-stone-300 transition-colors active:scale-95"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-5 overflow-y-auto px-5 py-5">
                <div className="rounded-2xl border border-stone-800 bg-stone-950/60 p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <label className="flex items-start gap-3 text-sm text-stone-200">
                      <input
                        type="checkbox"
                        checked={playCountTickSound}
                        onChange={(event) => setPlayCountTickSound(event.target.checked)}
                        className="mt-1 h-4 w-4 rounded border-stone-600 bg-stone-900 text-emerald-500"
                      />
                      <span>
                        <span className="block font-semibold text-stone-100">每次计数播放木鱼音</span>
                        <span className="mt-1 block text-xs leading-relaxed text-stone-400">
                          默认开启。每加 1 次计数就敲一声木鱼；关闭后只保留完成提醒音。
                        </span>
                      </span>
                    </label>

                    <button
                      type="button"
                      onClick={() => void playCountTickTone()}
                      className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-sm font-semibold text-emerald-100 transition-colors active:scale-95"
                    >
                      试听木鱼音
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-3 md:flex-row">
                  <button
                    type="button"
                    onClick={resetTuningSettings}
                    className="rounded-xl border border-stone-700 bg-stone-800 px-4 py-3 text-sm font-semibold text-stone-100 transition-colors active:scale-95"
                  >
                    恢复默认参数
                  </button>
                  <button
                    type="button"
                    onClick={resetMotionTracking}
                    className="rounded-xl border border-sky-400/30 bg-sky-400/10 px-4 py-3 text-sm font-semibold text-sky-100 transition-colors active:scale-95"
                  >
                    立即重新校准
                  </button>
                </div>

                {TUNING_SECTIONS.map((section) => (
                  <div
                    key={section.title}
                    className="rounded-2xl border border-stone-800 bg-stone-950/60 p-4"
                  >
                    <div className="mb-4 space-y-1">
                      <h4 className="text-sm font-bold text-stone-100">{section.title}</h4>
                      <p className="text-xs leading-relaxed text-stone-400">{section.hint}</p>
                    </div>

                    <div className="space-y-4">
                      {section.fields.map((field) => (
                        <label
                          key={field.key}
                          className="block rounded-2xl border border-stone-800 bg-stone-900/70 p-4"
                        >
                          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                            <div className="space-y-1 md:max-w-[70%]">
                              <div className="text-sm font-semibold text-stone-100">{field.label}</div>
                              <div className="text-xs leading-relaxed text-stone-400">
                                {field.description}
                              </div>
                              <div className="text-xs leading-relaxed text-stone-500">
                                {field.effect}
                              </div>
                            </div>

                            <div className="md:w-40">
                              <input
                                type="number"
                                min={field.min}
                                max={field.max}
                                step={field.step}
                                value={tuning[field.key]}
                                onChange={(event) =>
                                  handleTuningChange(field.key, Number.parseFloat(event.target.value))
                                }
                                className="w-full rounded-xl border border-stone-700 bg-stone-950 px-4 py-3 text-sm text-stone-100 outline-none"
                              />
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}

                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-xs leading-relaxed text-amber-100">
                  <div className="mb-2 font-semibold">调整建议</div>
                  <p>竖版识别不到：先把“自动校准间隔”调小，或把当前拍摄角度下的“最小幅度”调小一点。</p>
                  <p className="mt-2">次数多了后变钝：优先调小“自动校准间隔”，或调小“稳定帧数”；如果会卡住，再调小“解卡超时”。</p>
                  <p className="mt-2">浅动作也被算进去：把对应模式的“最小幅度”调大，或把“到底宽松度”调小。</p>
                  <p className="mt-2">已经明显到底但不计数：把“到底宽松度”调大，或把“起身恢复宽松度”稍微调大。</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

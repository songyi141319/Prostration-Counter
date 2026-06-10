# 大拜计数器 · 识别鲁棒性重构设计

日期：2026-06-08
模块：`src/components/KowtowCounter.tsx`（`renderLoop` 识别核心）
目标：解决「不灵敏 / 镜头拍不全就漏计 / 起好几遍不识别 / 只鞠躬就误计」。
适用范围：正拍 + 侧拍、完整礼拜(ritual) + 磕头数(prostration) 全覆盖，既灵敏又准。

## 一、现状识别流程

```
MediaPipe PoseLandmarker(lite, 单人)
 → 每帧取 nose(0) / leftShoulder(11) / rightShoulder(12)
 → 可靠性硬闸门: noseVis>0.5 && (lShoulderVis>0.5 || rShoulderVis>0.5)
 → 只追踪 nose.y, 平滑(0.5/0.5)
 → 动态学习 min/max → amplitude = max-min
 → 全部阈值 = min + amplitude × 比例系数
 → 状态机 READY→DESCENDING→KNEELING→BOTTOM→ASCENDING → count+1
   (prostration: READY→PROSTRATION_BOTTOM→READY → count+1)
```

## 二、根因（4 个）

1. **单点鼻子依赖。** 到底低头时鼻子出画面/可见度骤降，硬闸门把整帧识别冻结，状态机到不了 BOTTOM → 漏计（「起好几遍不识别」）。
2. **纯相对幅度自适应。** 阈值全是 amplitude 的百分比；做过一次大动作后大幅度被长期「记住」，之后小鞠躬套在大框架里也能走完状态机 → 误计（「鞠躬就识别」）。
3. **到底判定过苛。** 到底要求 noseY 逼近全局 max，但到底瞬间鼻子常不可见，max 更新不到位，凑不够 2 帧 → 判不到到底。
4. **标定漂移慢。** min/max 每帧仅回归 0.00016（约 1/min），换位置后越来越偏。

## 三、设计（方案 A：多点鲁棒追踪 + 几何绝对下限）

仍使用 lite 模型，不增加性能负担。改动集中在 `renderLoop` 的信号提取与判定层。

### 1. 综合高度信号 bodyY（替代单点 nose.y）
- 头部点集：nose(0)、left/right eye(2,5)、left/right ear(7,8)。
- 肩部点集：leftShoulder(11)、rightShoulder(12)。
- `bodyY = Σ(point.y × vis) / Σ(vis)`，仅纳入 vis 高于下限(0.4)的点。
- 头部点全失时回退到肩部点；保证「到底低头丢鼻子」仍有眼/耳/肩提供高度。

### 2. 身体尺度归一化 bodyScale（提供绝对门槛）
- `bodyScale = 肩宽 |L.x - R.x|`（x 方向受俯仰影响小，最稳）。可见时辅以肩-髋(23/24)纵距取较大者。
- READY 稳定时记录站立基线 `standingBodyY` 与基线 `bodyScale`。
- **绝对下限闸门**：本周期最低位相对站立基线的下降量 `drop = bottomBodyY - standingBodyY`，要求 `drop ≥ K_mode_perspective × baselineBodyScale` 才认定为有效大拜/磕头。小鞠躬 drop 不达标，直接不计 → 根治误计。
- 系数 K 暴露到调参面板（替换/补充现有「最小幅度」项），给出经验默认值，正拍 ritual≈1.1、侧拍 ritual≈0.9、磕头相应略低。

### 3. 可靠性软闸门
- 计算 bodyY 只要「头部任一点 vis>0.4 或 任一肩 vis>0.5」即可，用可见子集算。
- 全部不可见：保持上一帧 bodyY 最多 holdFrames(默认 6) 帧；超出才判 lost 并冻结。
- DESCENDING/KNEELING 之后若可见度骤降（典型到底遮挡），视为「接近到底」的强信号，临时下调到底门槛，避免被遮挡吞掉到底帧。

### 4. 到底判定改造
- 到底条件由「逼近全局 max」改为：`drop ≥ K×bodyScale`（绝对）AND bodyY 处于本周期相对低位（接近本周期 maxBodyY 即可，配合软闸门）。
- 不再强依赖 max 被精确更新到位。

### 5. 衰减加快 + 幅度封顶
- min/max 每帧回归速率提高约 4×（正拍 0.00064、侧拍 0.00088 量级），amplitude 记忆缩到数秒。
- amplitude 设软上限，单次异常大动作不长期污染后续判定。

### 6. 状态机
- 保留 READY→DESCENDING→KNEELING→BOTTOM→ASCENDING / prostration 两态结构（已验证可用）。
- 仅替换其驱动信号（nose.y→bodyY）与到底/起身阈值来源（相对→相对+绝对双闸门）。
- 解卡超时逻辑保留。

## 四、参数与面板
- 现有 `ritual/prostration MinAmplitude*` 改造为基于 bodyScale 的绝对系数 K（语义更直观：相对身高的下降比例）。
- 新增 `holdFrames`（软闸门保持帧）、`occlusionBottomBoost`（遮挡到底加成）。
- 其余自动校准 / 解卡项保留。
- 全部给安全默认值，开箱即用，不依赖用户手动调。

## 五、验证方式
- `npm run lint`（tsc --noEmit）通过。
- 浏览器 `npm run dev` 用摄像头实测四种组合（正/侧 × 礼拜/磕头）：
  - 完整大拜每次必计、到底丢鼻子不漏计；
  - 半截鞠躬不计；
  - 连续多拜不卡阶段；
  - 换位置后短时间内自适应回正。
- 开启 Debug 叠层核对 Phase / bodyY / drop / bodyScale。

## 六、不做（YAGNI）
- 不升级模型（lite 足够）。
- 不重写 UI 结构、不动音效/目标提醒逻辑。
- 不引入持久化/多人识别。

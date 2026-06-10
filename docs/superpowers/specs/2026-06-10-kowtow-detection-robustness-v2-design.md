# 大拜计数器 · 识别鲁棒性重构设计 v2

日期：2026-06-10（定稿，取代 2026-06-08 版本：沿用其骨架，新增三项强化）
模块：`src/components/KowtowCounter.tsx`（`renderLoop` 识别核心）
目标：解决「不灵敏 / 镜头近拍不全就漏计 / 起好几遍不识别 / 只鞠躬就误计」。
适用范围：正拍 + 侧拍、完整礼拜(ritual) + 磕头数(prostration) 全覆盖；误计与漏计同等重要，不偏向任一边。

## 一、使用场景（本轮确认）

- 手机放正前方较近处，站立时画面里只有上半身（头+肩+胸）。
- 藏式大礼拜与跪拜磕头两种动作都做，两种模式都要准。
- 趴到最低点时人可能部分或全部出画面——这是常态，不是异常。
- 校准方式：默认全自动适应，设置中提供可选的手动「重新校准」。

## 二、病灶定位（对照现有代码）

1. **误计（鞠躬就计数）**：全部阈值是已学习 min/max 幅度的百分比，无绝对尺度。
   近镜头下鞠躬的归一化位移很大，轻松越过最小幅度门槛后，鞠躬自身行程就被
   当作全程范围，下行/跪/到底/起身阈值全落在鞠躬行程内，状态机被走完 → 计数。
2. **漏计（起好几遍不识别）**：只看鼻子且有硬闸门（noseVis>0.5 才处理）。
   趴底时鼻子出画面 → 整帧丢弃、计数器冻结，状态机停在 KNEELING；起身后看到
   站姿直接复位回 READY，整拜作废。
3. **早计（一起来就计数）**：起身判定也是相对阈值（min + 30%幅度），幅度被污染
   压缩后刚抬头就越线 → 提前计数。

## 三、设计

仍使用 lite 模型，不增加性能负担。改动集中在 `renderLoop` 的信号提取与判定层。

### 沿用 06-08 骨架

#### 1. 综合高度信号 bodyY（替代单点 nose.y）
- 头部点集：nose(0)、left/right eye(2,5)、left/right ear(7,8)，vis>0.4 纳入。
- `bodyY = Σ(point.y × vis) / Σ(vis)`。
- 头部点全失时回退到肩部点（11/12，vis>0.5）；保证到底低头丢鼻子仍有信号。

#### 2. 身体尺度 bodyScale 与站立基线
- `bodyScale = 肩宽 |L.x − R.x|`（双肩 vis>0.5 时更新，x 向受俯仰影响最小）。
- READY 且站立稳定（standingFrames≥3）时持续慢速更新 `standingBodyY` 基线与
  `baselineBodyScale`（EMA）。
- 工作区现存 9 行残缺改动（引用未定义 ref）属于此条的未完成实现，本次补全。

#### 3. 绝对下限门槛（根治误计）
- 每周期记录最低位 `cycleMaxBodyY`，计数前校验
  `drop = cycleMaxBodyY − standingBodyY ≥ K × baselineBodyScale`。
- K 按模式×视角共 4 个，进调参面板，默认值（经验起点，实测可调）：
  ritual front 1.1 / side 0.9；prostration front 0.55 / side 0.5。
- 校验不过：静默丢弃该周期并复位，不计数。
- 无基线（冷启动）时回退现有相对幅度门槛。

#### 4. 可见性软闸门
- 部分点丢失用可见子集计算 bodyY。
- 全部不可见：保持上一帧 bodyY 最多 holdFrames（默认 6）帧；超出判 trackingLost。

#### 5. 衰减加快 + 幅度封顶
- min/max 每帧回归速率提高约 4×（正拍 0.00064、侧拍 0.00088 量级）。
- amplitude 设软上限，单次异常大动作不长期污染相对回退路径。

### 本轮三项强化

#### 6. 「消失即到底」一等信号（根治漏计）
- 状态机处于 DESCENDING/KNEELING（或 prostration 已 armed 且已确认下行）时，
  若 trackingLost 持续 ≥ lostBottomFrames（默认 4），直接进入 BOTTOM
  （标记 occlusionBottom）。近镜头趴到底人本来就该消失。
- 重新可见后正常走 ASCENDING → 计数。
- occlusionBottom 周期的绝对门槛改用「消失前已下降量 ≥ K_occ × baselineBodyScale」
  校验（K_occ 较小，默认 0.5×K），且要求下行阶段已确认——防漏计同时不给鞠躬开后门
  （鞠躬不会导致整人消失）。

#### 7. 起身判定绝对化（根治早计）
- 有基线时：「已回正」= `bodyY ≤ standingBodyY + recoveryTolerance × bodyScale`
  （默认 0.35×），替代「min + 30%幅度」相对线。
- prostration 模式的回正判定同理绝对化。
- 无基线时回退相对判定（冷启动兼容）。

#### 8. 可选手动校准
- 默认全自动（条目 2 的慢速 EMA）。
- 设置面板新增「重新校准」按钮：点击后提示站好，采样 2 秒锁定
  standingBodyY/baselineBodyScale，完成响提示音。不强制使用。

### 状态机
- 保留 READY→DESCENDING→KNEELING→BOTTOM→ASCENDING / prostration 两态结构。
- BOTTOM 进入条件增加 occlusion 一路；计数时刻统一过绝对门槛校验。
- 解卡超时逻辑保留。

## 四、参数与面板
- 新增：绝对门槛系数 K ×4（语义：相对肩宽的下降比例）、holdFrames、
  lostBottomFrames、recoveryTolerance。
- 现有自动校准/解卡/到底宽松度等项保留；相对幅度项保留作冷启动回退。
- 全部给安全默认值，开箱即用。

## 五、验证方式
- `npm run lint`（tsc --noEmit）通过。
- Debug 叠层新增 bodyY / drop / bodyScale / occlusion 状态显示。
- 浏览器 `npm run dev` 摄像头实测四组合（正/侧 × 礼拜/磕头）：
  - 完整大拜每次必计、到底丢人不漏计；
  - 半截鞠躬不计；
  - 起身瞬间不提前计；
  - 连续多拜不卡阶段；换位置后短时间自适应回正；手动校准立即生效。

## 六、不做（YAGNI）
- 不升级模型（lite 足够）。
- 不重写 UI 结构、不动音效/目标提醒逻辑。
- 不引入持久化/多人识别/轨迹回放重写。

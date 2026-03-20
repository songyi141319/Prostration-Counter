<div align="center">

# 🙏 大拜计数器 | Prostration Counter

**基于 AI 姿态识别的智能礼拜计数器**

*Real-time AI-powered prostration counting for Buddhist practice*

[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![MediaPipe](https://img.shields.io/badge/MediaPipe-Pose-4285F4?logo=google&logoColor=white)](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
[![Capacitor](https://img.shields.io/badge/Capacitor-7.6-119EFF?logo=capacitor&logoColor=white)](https://capacitorjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[功能特性](#-功能特性) · [快速开始](#-快速开始) · [Android 构建](#-android-构建) · [技术架构](#-技术架构) · [常见问题](#-常见问题)

</div>

---

## 📖 简介

大拜计数器是一款**完全离线运行**的 AI 计数工具，专为佛教礼拜修行设计。通过前置摄像头实时捕捉画面，利用 Google MediaPipe PoseLandmarker 进行骨骼关键点检测，自动识别并计数大拜（五体投地）动作——**无需联网，所有 AI 推理在本地完成，隐私安全。**

> **为什么做这个？** 传统的念珠或手动计数器需要中断修行动作来操作，影响专注。这个工具让你放下手机就能自动计数，专注于礼拜本身。

---

## ✨ 功能特性

### 核心功能

| 功能 | 说明 |
|------|------|
| 🤖 **AI 姿态识别** | 基于 MediaPipe PoseLandmarker，实时检测 33 个人体关键点 |
| 📱 **纯离线运行** | 模型完全在设备端推理，无需网络，保护隐私 |
| 🎯 **智能动作状态机** | 6 阶段运动状态追踪（准备→下降→跪地→触底→上升→完成） |
| 📊 **自动校准** | 持续适应站位和跪垫位置的微小变化 |

### 计数模式

- **完整礼拜模式** — 从站立到磕头再回到站立算 1 次，确保动作完整
- **磕头计数模式** — 头部触底后起身即记 1 次，适合快速礼拜

### 拍摄角度

- **正拍模式** — 手机放在正前方，面对摄像头
- **侧拍模式** — 手机放在身体侧边，捕捉侧面动作

### 辅助功能

| 功能 | 说明 |
|------|------|
| 🔔 **目标提醒** | 预设 36/72/108 拜目标，或自定义任意数量 |
| 🔊 **完成音效** | 5 种音效风格（轻柔/短促/明显/长音/自定义频率） |
| 👁️ **画面模式** | 实时摄像头画面 或 纯骨架显示 |
| ⚙️ **高级调参** | 12 项可调参数，适配不同体型和动作幅度 |
| 🦴 **骨架叠加** | 实时显示识别到的人体骨骼连线 |

---

## 🖥️ 界面预览

```
┌─────────────────────────────┐
│        大拜计数器            │
│     基于本地姿态识别          │
│                             │
│          108                │
│        已完成               │
│   [动作中] [还差 0 拜]      │
│                             │
│   ┌───────────────────┐     │
│   │  📷 实时摄像头      │     │
│   │  + 骨架叠加显示     │     │
│   │                   │     │
│   │   🦴 ← AI 骨骼    │     │
│   │      检测          │     │
│   └───────────────────┘     │
│                             │
│  [暂停计数] [关闭] [重置]    │
│  [⚙️ 设置]                  │
└─────────────────────────────┘
```

---

## 🚀 快速开始

### 环境要求

- **Node.js** >= 18
- **npm** >= 9
- 支持摄像头的浏览器（Chrome / Edge / Safari）

### 安装与运行

```bash
# 1. 克隆仓库
git clone https://github.com/songyi141319/Prostration-Counter.git
cd Prostration-Counter

# 2. 安装依赖
npm install

# 3. 启动开发服务器
npm run dev
```

打开浏览器访问 `http://localhost:3000`，授权摄像头权限即可使用。

> **提示**：首次运行时，构建脚本会自动下载 MediaPipe WASM 和模型文件（约 28MB）。

### 可用脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器（端口 3000） |
| `npm run build` | 构建生产版本（自动下载模型） |
| `npm run preview` | 预览生产构建 |
| `npm run lint` | TypeScript 类型检查 |
| `npm run android:build:debug` | 构建 Android Debug APK |

---

## 📱 Android 构建

本项目使用 [Capacitor](https://capacitorjs.com/) 打包为 Android 原生应用。

### 环境要求

- **JDK** 21+
- **Android SDK**（API Level 22+）
- **Gradle**（通过 wrapper 自动下载）

### 构建 APK

```bash
# 一键构建（Web + Android）
npm run android:build:debug
```

APK 输出路径：`android/app/build/outputs/apk/debug/app-debug.apk`

### Android 特性

- 🔒 **锁定竖屏** — Activity 固定 portrait 方向
- 📸 **摄像头适配** — 自动检测横屏流并通过 OffscreenCanvas 旋转为竖屏，确保 AI 识别准确
- 🎨 **自适应图标** — 跪拜人物剪影 + 莲花元素的矢量图标

---

## 🏗️ 技术架构

```
┌─────────────────────────────────────────┐
│              用户界面 (React 19)          │
│         Tailwind CSS 4 + Lucide Icons    │
├──────────────┬──────────────────────────┤
│  摄像头模块   │     姿态检测模块           │
│ getUserMedia │  MediaPipe PoseLandmarker │
│ OffscreenCanvas│  33 个关键点实时追踪     │
│  帧旋转修正   │     WASM 本地推理         │
├──────────────┴──────────────────────────┤
│           动作状态机                      │
│  READY → DESCENDING → KNEELING →        │
│  BOTTOM → ASCENDING → 计数完成           │
├─────────────────────────────────────────┤
│         Capacitor (Android 封装)          │
│        WebView + 原生权限桥接             │
└─────────────────────────────────────────┘
```

### 关键技术点

**姿态识别 Pipeline**
1. 前置摄像头通过 `getUserMedia` 获取视频流
2. 检测到横屏流时，使用 `OffscreenCanvas` 将每帧旋转 90° 为竖屏
3. 旋转后的帧送入 `PoseLandmarker.detectForVideo()` 进行骨骼检测
4. 提取鼻子和肩膀关键点，通过 Y 轴位移驱动状态机

**动作状态机**
- 使用 6 阶段有限状态机追踪礼拜动作
- 指数移动平均（EMA）平滑鼻子 Y 坐标，减少抖动
- 自动校准基线位置，适应站位微调
- 超时保护机制，防止卡在某个阶段

### 技术栈

| 层级 | 技术 |
|------|------|
| **前端框架** | React 19 + TypeScript 5.8 |
| **样式** | Tailwind CSS 4 |
| **AI 推理** | MediaPipe Tasks Vision (WASM) |
| **构建工具** | Vite 6 |
| **移动端** | Capacitor 7.6 |
| **图标** | Lucide React |

---

## ⚙️ 高级配置

在设置面板中可以调整以下参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 自动校准间隔 | 3000ms | 多久重新校准一次基线位置 |
| 稳定帧数 | 4 帧 | 判定姿态稳定所需的连续帧数 |
| 正拍/侧拍稳定阈值 | 0.009 / 0.012 | 判定静止的运动幅度阈值 |
| 完整礼拜最小幅度 | 0.18 / 0.16 | 正拍/侧拍模式下有效动作的最小幅度 |
| 磕头最小幅度 | 0.12 / 0.10 | 磕头模式下有效动作的最小幅度 |
| 触底深度偏移 | 1.0 | 判定触底位置的敏感度 |
| 恢复偏移 | 1.0 | 判定起身完成的敏感度 |
| 阶段超时 | 5200 / 3600ms | 礼拜/磕头模式的阶段超时时间 |

---

## ❓ 常见问题

<details>
<summary><b>摄像头画面是黑的 / 无法打开</b></summary>

- 确认已授予摄像头权限（Android 设置 → 应用 → 大拜计数器 → 权限）
- 如果使用浏览器版本，确认通过 HTTPS 或 localhost 访问
- 尝试在设置中切换摄像头设备
</details>

<details>
<summary><b>计数不准确 / 漏计</b></summary>

- 确保全身在画面中可见（头部到膝盖）
- 尝试切换正拍/侧拍模式
- 调整设置中的「最小幅度」参数（降低可提高灵敏度）
- 确保光线充足，避免逆光
</details>

<details>
<summary><b>摄像头画面方向不对</b></summary>

部分 Android 设备的前置摄像头返回横屏流，应用会自动检测并旋转。如果仍有问题，请提 Issue 附上设备型号。
</details>

<details>
<summary><b>可以离线使用吗？</b></summary>

**完全可以。** 所有 AI 模型在首次构建时下载到本地，之后无需网络。摄像头数据不会上传到任何服务器。
</details>

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'feat: add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 提交 Pull Request

---

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 开源协议。

---

<div align="center">

**如果这个项目对你有帮助，请给一个 ⭐ Star！**

Made with ❤️ for mindful practice

</div>

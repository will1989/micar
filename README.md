# MiCar 遥控（WebBLE）

基于 **Web Bluetooth** 的网页版小米吉姆尼（Xiaomi Jimny / MiCar）遥控，纯前端、零依赖、单页应用。还原原版 App 的核心操控体验，可直接用手机浏览器本地打开，也可一键部署到 GitHub Pages。

> ⚠️ 爱好者复刻项目，与小米官方无任何关联。BLE 控制协议来自社区逆向：[Matt Cree 的逆向分析](https://mattcree.github.io/hardware/2026/01/07/reverse-engineering-xiaomi-jimny-ble-protocol.html)。请仅用于控制你本人拥有的设备。

## ✨ 功能

| 功能 | 说明 |
|------|------|
| 方向键模式 | ▲▼◀▶ 按住行驶，松开自动回中停车，中间 ● 紧急停车 |
| 虚拟摇杆模式 | 拖动控制油门（上下）与转向（左右），松手回中 |
| 重力感应模式 | 手机前倾加速、左右倾斜转向（支持 iOS 权限申请与居中校准） |
| 灯光开关 | 写入灯光特征 `0x01/0x00` |
| 高低速档位 | 低/中/高三档（UI 端功率限制器，见下方说明） |
| 转向微调 | ±300 偏移量，修正小车跑偏 |
| 电量显示 | 读取标准电池特征 `0x2A19` |
| 20Hz 保活 | 连接后按 ~20Hz 持续下发，降低延迟、维持控制 |
| 遥测日志 | 显示通知特征回传的原始字节 |

## 🚀 使用方式

### 方式一：本地文件（推荐手机端）
1. 把本仓库下载/克隆到手机，或直接把 `index.html` 存到手机内部存储；
2. 用 **支持 Web Bluetooth** 的浏览器打开：
   - 安卓：Chrome / Edge / **华为浏览器（鸿蒙）** ✅
   - 桌面：Chrome / Edge ✅
   - ❌ 微信内置浏览器（禁用 Web 蓝牙）、❌ iOS Safari（不支持 Web 蓝牙）
3. 开启手机蓝牙与位置权限，小车开机；
4. 点「连接小车」，在蓝牙弹窗中选择 `JimnygreenSNxxxx`；
5. 选择操控模式，开跑 🏎️

### 方式二：GitHub Pages（公网 HTTPS，已上线）

✅ 已通过 GitHub Actions 自动部署，直接访问：

**https://will1989.github.io/micar/**

用手机浏览器（安卓 Chrome / Edge / 华为浏览器）打开即可连接小车 —— HTTPS 满足 Web Bluetooth 的安全要求，无需传文件到手机。

## 🔧 技术细节（协议摘要）

- **设备广播名**：`JimnygreenSNxxxx`（过滤前缀 `Jimny`）
- **控制特征** `4fbbffe3-…`：WriteWithoutResponse，3 字节包
  - `byte0 = (steering >> 4) & 0xFF`
  - `byte1 = ((steering << 4) & 0xF0) | ((throttle >> 8) & 0x0F)`
  - `byte2 = throttle & 0xFF`
  - 转向/油门各为 12-bit，范围 `0–2000`，`1000` 为居中/停止；`>1000` 右转/前进，`<1000` 左转/后退
- **配置特征** `4fbbffe4-…`：连接后下发初始化包 `[0x20, 0x01]`
- **通知特征** `4fbbffe5-…`：遥测/响应
- **灯光特征** `4fbbffe6-…`：单字节 `0x01` 开 / `0x00` 关
- **电池特征** `0x2A19`（服务 `0x180F`）
- 自定义服务 UUID 未在文档中给出，本工具连接后自动枚举包含控制特征的服务，无需硬编码。

> 说明：原厂「高速/低速」的底层协议未公开，本项目的低/中/高三档为** UI 端油门功率限制器**（限制最大油门幅度），逻辑清晰且安全，不影响基础控制。

## 📱 兼容性 / 已知局限

- iOS / iPadOS Safari **不支持 Web Bluetooth**，无法使用本遥控（可改用安卓机或桌面浏览器）。
- 鸿蒙部分版本偶发蓝牙扫描失败：关闭蓝牙重开、小车断电重启通常可恢复。
- 重力感应依赖 `DeviceOrientationEvent`，iOS 需用户手势授权。

## 📂 项目结构

```
index.html              入口页面
css/styles.css          样式（移动端优先暗色 UI）
js/app.js               核心逻辑（BLE + 三种操控模式 + 保活）
manifest.webmanifest    可「添加到主屏幕」的安装清单
.github/workflows/pages.yml  GitHub Pages 自动部署
```

## 📜 License

[MIT](./LICENSE)

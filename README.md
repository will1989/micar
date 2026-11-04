# MiCar 遥控（网页版 + 微信小程序）

小米吉姆尼（Xiaomi Jimny / MiCar）的开源遥控方案，包含两个前端：

- **网页版**（仓库根目录）：基于 Web Bluetooth，零依赖单页应用，已部署到 GitHub Pages
- **微信小程序版**（`miniprogram/`）：原生小程序，用微信内置 BLE API，支持 iOS

两者共用同一套控制协议、功能对齐：方向键 / 虚拟摇杆 / 重力感应、灯光、高低速档位、转向微调、电量、20Hz 保活、遥测日志。

> ⚠️ 爱好者复刻项目，与小米官方无任何关联。BLE 控制协议来自社区逆向：[Matt Cree 的逆向分析](https://mattcree.github.io/hardware/2026/01/07/reverse-engineering-xiaomi-jimny-ble-protocol.html)。请仅用于控制你本人拥有的设备。

## ✨ 功能

| 功能 | 说明 |
|------|------|
| 方向键模式 | ▲▼◀▶ 按住行驶，松开自动回中停车，中间 ● 紧急停车 |
| 虚拟摇杆模式 | 拖动控制油门（上下）与转向（左右），松手回中 |
| 重力感应模式 | 前倾加速、左右倾斜转向（网页版用 DeviceOrientation，小程序用加速度计） |
| 灯光开关 | 写入灯光特征 `0x01/0x00` |
| 高低速档位 | 低/中/高三档（UI 端功率限制器，见下方说明） |
| 转向微调 | ±300 偏移量，修正小车跑偏 |
| 电量显示 | 读取标准电池特征 `0x2A19` |
| 20Hz 保活 | 连接后按 ~20Hz 持续下发，降低延迟、维持控制 |
| 遥测日志 | 显示通知特征回传的原始字节 |

## 🚀 使用方式

### 方式一：GitHub Pages（网页版，已上线）

✅ 直接访问 **https://will1989.github.io/micar/**

用手机浏览器（安卓 Chrome / Edge / 华为浏览器）打开即可连接小车 —— HTTPS 满足 Web Bluetooth 的安全要求，无需传文件到手机。仓库已配好 GitHub Actions 自动部署，push 即更新。

### 方式二：本地文件（网页版）

1. 下载本仓库，或直接把 `index.html` 存到手机内部存储；
2. 用支持 Web Bluetooth 的浏览器打开（安卓 Chrome / Edge / **华为浏览器**，或桌面 Chrome / Edge）；
3. 开启蓝牙与位置权限、小车开机 → 点「连接小车」→ 选 `JimnygreenSNxxxx` → 开跑 🏎️

### 方式三：微信小程序

1. 微信开发者工具「导入项目」，目录选本仓库的 **`miniprogram/`** 子目录；
2. AppID 已配置，也可换成自己的或「测试号」；
3. ⚠️ **蓝牙必须真机调试**：模拟器不支持蓝牙，请用「真机预览 / 真机调试」扫码在手机上操作。

详见 [miniprogram/README.md](./miniprogram/README.md)。

| | 网页版 (Web Bluetooth) | 微信小程序版 |
|---|---|---|
| iOS / iPhone | ❌ Safari 不支持 | ✅ 支持（需真机） |
| 微信内打开 | ❌ 内置浏览器禁用 | ✅ 原生可用 |
| 免传文件 | ✅ GitHub Pages | 需导入工具 / 上传体验版 |

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
- 自定义服务 UUID 未在文档中给出，两端均在连接后自动枚举包含控制特征的服务，无需硬编码。

> 说明：原厂「高速/低速」的底层协议未公开，低/中/高三档为 **UI 端油门功率限制器**（限制最大油门幅度），逻辑清晰且安全，不影响基础控制。

### 小程序版特有的工程处理

- **写入串行化**：微信 BLE 同一连接并发写会失败，所有写入统一走队列
- **writeType 降级**：控制特征仅支持 `writeNoResponse` 时显式指定，老基础库不识别则自动降级
- **Android 定位权限**：扫描前检查并申请 `scope.userLocation`，`app.json` 已声明用途描述
- **电量读取**：`readBLECharacteristicValue` 的结果在 `onBLECharacteristicValueChange` 回调中解析

## 📱 兼容性 / 已知局限

- 网页版：iOS / iPadOS Safari **不支持 Web Bluetooth**；鸿蒙部分版本偶发扫描失败（关蓝牙重开 + 小车断电重启可恢复）。
- 小程序版：开发者工具模拟器不支持蓝牙；真机调试建议打开调试模式；Android 需开启系统定位服务。
- 上架发布需自行在微信公众平台提交审核。

## 📂 项目结构

```
index.html                    网页版入口
css/styles.css                网页版样式（移动端优先暗色 UI）
js/app.js                     网页版核心逻辑（WebBLE + 三种操控模式 + 保活）
manifest.webmanifest          可「添加到主屏幕」的安装清单
miniprogram/                  微信小程序（原生，无 npm / 无云服务）
  ├── app.json / app.js / app.wxss
  ├── project.config.json
  ├── pages/index/            遥控主页
  └── utils/jimny-ble.js      BLE 协议 + 串行写入队列
.github/workflows/pages.yml   GitHub Pages 自动部署
```

## 📜 License

[MIT](./LICENSE)

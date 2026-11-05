# MiCar 遥控 · 微信小程序版

原生微信小程序实现的小米吉姆尼（Xiaomi Jimny / MiCar）BLE 遥控，**无云服务、无 npm 依赖**，与仓库根目录的网页版共用同一套控制协议。

> 爱好者复刻项目，与小米官方无关联。协议参考 [Matt Cree 的逆向分析](https://mattcree.github.io/hardware/2026/01/07/reverse-engineering-xiaomi-jimny-ble-protocol.html)。请仅用于控制你本人拥有的设备。

## 导入微信开发者工具

1. 打开**微信开发者工具**，选择「导入项目」；
2. 目录选择本仓库的 **`miniprogram/`**（注意是子目录，不是仓库根目录）；
3. AppID：`project.config.json` 里已由工具写入 `wxe66443daf86ece6f`，如需换成自己的 AppID 可在「详情 → 基本信息」中修改，或使用「测试号」；
4. 点击「编译」即可在模拟器中看到界面。

⚠️ **蓝牙功能必须用真机调试**：开发者工具模拟器不提供蓝牙能力，连接小车不会成功。请用「真机预览 / 真机调试」，扫码后在手机上操作。真机调试时建议打开调试模式（右上角 … → 打开调试），否则部分机型无法连接未上架小程序的 BLE。

## 与网页版相比的优势

| | 网页版 (Web Bluetooth) | 小程序版 |
|---|---|---|
| iOS / iPhone | ❌ Safari 不支持 | ✅ 支持（需真机） |
| 微信内打开 | ❌ 微信内置浏览器禁用 | ✅ 原生可用 |
| 重力感应 | `DeviceOrientationEvent`（iOS 需授权） | `wx.onAccelerometerChange`（更稳定） |
| 免传文件 | ✅ GitHub Pages | 需先导入开发者工具 / 上传体验版 |

## 功能

- **双手柄（横屏默认，推荐）**：左手方向键只保留 ▲ 前进 / ▼ 后退管油门，右手摇杆锁水平单轴只管转向角（±30° 显示）；两侧正交、可同时操作，松开一侧不影响另一侧
- **方向键**（单区备用）：四向按住行驶，松开自动回中停车，中间 ● 立即停车
- **虚拟摇杆**（单区备用）：触摸拖动控制油门与转向，松手回中
- 页面配置了 `pageOrientation: auto`，旋转设备由 `onResize` 自动重排；横屏样式统一用 `px`（`rpx` 在横屏会按屏幕宽度放大近一倍）
- **重力感应**：加速度计，前倾加速、左右倾斜转向；开启后自动以当前姿态为中点，可随时「校准居中」
- **灯光开关**、**低/中/高档位**、**转向微调 ±300**、**电量读取**、**遥测日志**

## 协议要点

- 广播名前缀 `Jimny`（如 `JimnygreenSNxxxx`）
- 控制特征 `4fbbffe3-…`：3 字节包，转向/油门各 12-bit，0–2000，1000 居中
  - `b0=(steer>>4)&0xFF`，`b1=((steer<<4)&0xF0)|((thr>>8)&0x0F)`，`b2=thr&0xFF`
- 配置 `4fbbffe4-…`（初始化 `[0x20,0x01]`）、通知 `4fbbffe5-…`、灯光 `4fbbffe6-…`（`0x01/0x00`）、电池 `0x2A19`
- 自定义服务 UUID 未公开 → 连接后遍历服务，自动定位包含控制特征的服务
- 原厂高低速协议未公开 → 三档为 UI 端油门功率限制器

### 小程序特有的工程处理

- **写入串行化**：微信 BLE 同一连接并发写会失败，所有写入（保活/灯光/初始化）统一走队列
- **writeType 降级**：控制特征仅支持 `writeNoResponse` 时显式指定，老基础库不识别则自动降级
- **约 20Hz 保活**：串行队列上按 50ms 投放控制包，队列堆积时跳帧
- **Android 定位权限**：扫描前检查 `scope.userLocation` 并授权（`app.json` 已声明用途描述）；系统定位开关也需打开
- **电量读取**：`readBLECharacteristicValue` 的结果在 `onBLECharacteristicValueChange` 回调中解析

## 目录结构

```
miniprogram/
├── app.js / app.json / app.wxss      全局配置与样式
├── project.config.json                开发者工具工程配置
├── sitemap.json
├── pages/index/                      遥控主页（WXML / WXSS / JS / JSON）
└── utils/jimny-ble.js                BLE 协议与串行写入队列
```

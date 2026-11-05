'use strict';

var ble = require('../../utils/jimny-ble.js');
var CENTER = ble.CENTER;
var MIN = ble.MIN;
var MAX = ble.MAX;
var MAX_ANGLE = 30;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

var DIR_LABEL = {
  forward: '前进',
  backward: '后退',
  left: '左转',
  right: '右转',
  stop: '停车',
};

function nowText() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

Page({
  data: {
    connected: false,
    connecting: false,
    statusText: '未连接',
    deviceName: '小米吉姆尼 · BLE',
    battery: '--%',
    mode: 'gamepad',
    wide: false,
    // full = 圆形摇杆 360°（水平转向 + 垂直油门，与原版 App 一致）
    // steer = 水平单轴，只输出转向（油门完全交给左侧方向键）
    joyAxis: 'full',
    lightsOn: false,
    gear: 1,
    trim: 0,
    activeDir: '',
    steerReadout: CENTER,
    throttleReadout: CENTER,
    angleText: '0°',
    idleDirText: '待命 · 按住前进 / 后退',
    idleJoyText: '待命 · 360° 拖动',
    joyActiveText: '全向操控 · 实时跟随',
    joyX: 0,
    joyY: 0,
    tiltX: 0,
    tiltY: 0,
    gravityRunning: false,
    gravityCalibrated: false,
    logs: [],
    logScrollTop: 0,
    compatNote: '蓝牙需真机预览调试；安卓请开启定位服务并授权位置权限。',
    showPrivacy: false,
    dirLabel: '',
    joyPressed: false,
  },

  onLoad: function () {
    this.logSeq = 0;
    this.joyRect = null;
    this.joyActive = false;
    this.gravityBase = null;
    this.modeLocked = false;
    // 两个正交输入分量：摇杆写转向，方向键/摇杆垂直轴共同决定油门
    this.steerVal = CENTER;
    this.throttleVal = CENTER;
    this.dirThrottle = CENTER;
    this.joyThrottle = CENTER;
    this._privacyResolve = null;
    this._privacyHandler = null;
    this._accelHandler = function (res) {
      if (this.data.gravityRunning) this.onAccel(res);
    }.bind(this);
    wx.onAccelerometerChange(this._accelHandler);
    // 微信要求：调用蓝牙/定位/加速度计等隐私接口前，须由用户同意隐私保护指引
    if (typeof wx.onNeedPrivacyAuthorization === 'function') {
      var that = this;
      this._privacyHandler = function (res) {
        // 不同基础库版本回调参数可能是 resolve 函数，也可能是含 resolve 的对象
        var resolve = typeof res === 'function' ? res : (res && res.resolve);
        if (typeof resolve !== 'function') return;
        that._privacyResolve = resolve;
        that.setData({ showPrivacy: true });
      };
      wx.onNeedPrivacyAuthorization(this._privacyHandler);
    }

    var info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
    var wide = info.windowWidth >= 700 || (info.windowWidth > info.windowHeight && info.windowWidth >= 560);
    this.setData({ wide: wide });
    this.setMode(wide ? 'gamepad' : 'dpad', false);
    this.appendLog('就绪。点击「连接小车」搜索 JimnygreenSNxxxx。');
  },

  onUnload: function () {
    wx.stopAccelerometer({});
    if (this._dirTimer) clearTimeout(this._dirTimer);
    if (this._joyTimer) clearTimeout(this._joyTimer);
    if (this._privacyHandler && typeof wx.offNeedPrivacyAuthorization === 'function') {
      wx.offNeedPrivacyAuthorization(this._privacyHandler);
    }
    ble.disconnect();
  },

  onHide: function () {
    this.resetSources();
    this.applyInputs({ steering: CENTER, throttle: CENTER });
    this.stopGravity();
  },

  // 横屏切换：pageOrientation=auto 时触发，重新计算布局并重新测量摇杆中心
  onResize: function (size) {
    var box = size && (size.size || size);
    var w = Number(box && box.windowWidth) || 0;
    var h = Number(box && box.windowHeight) || 0;
    if (!w) return;
    var wide = w >= 700 || (w > h && w >= 560);
    if (wide === this.data.wide) return;
    this.setData({ wide: wide });
    this.joyRect = null;
    if (!this.modeLocked) this.setMode(wide ? 'gamepad' : 'dpad', false);
    else this.measureJoystick();
  },

  appendLog: function (text, kind) {
    this.logSeq += 1;
    var logs = this.data.logs.concat([{
      id: this.logSeq,
      text: '[' + nowText() + '] ' + text,
      kind: kind || '',
    }]);
    if (logs.length > 100) logs.shift();
    this.setData({ logs: logs, logScrollTop: logs.length * 24 });
  },

  // ---------- 输入 ----------
  resetSources: function () {
    this.dirThrottle = CENTER;
    this.joyThrottle = CENTER;
  },

  // 油门仲裁：方向键按下时优先，松开后回落到 360° 摇杆的垂直分量。
  // 这样双手同时操作、任一侧松手都不会把另一侧指令清零。
  effectiveThrottle: function () {
    if (this.data.mode !== 'gamepad') return this.throttleVal;
    if (this.dirThrottle !== CENTER) return this.dirThrottle;
    return this.data.joyAxis === 'full' ? this.joyThrottle : CENTER;
  },

  // 始终下发完整的两个分量，避免部分更新与页面读数不一致
  applyInputs: function (next) {
    next = next || {};
    if (next.steering !== undefined) this.steerVal = clamp(next.steering, MIN, MAX);
    if (next.throttle !== undefined) this.throttleVal = clamp(next.throttle, MIN, MAX);
    ble.setTargets({ steering: this.steerVal, throttle: this.throttleVal });
    // 读数与实际下发值一致：叠加微调与档位（BLE 层同样处理）
    var steer = Math.round(clamp(this.steerVal + Number(this.data.trim), MIN, MAX));
    var thr = Math.round(clamp(CENTER + (this.throttleVal - CENTER) * Number(this.data.gear), MIN, MAX));
    var deg = Math.round((steer - CENTER) / (MAX - CENTER) * MAX_ANGLE);
    this.setData({
      steerReadout: steer,
      throttleReadout: thr,
      angleText: (deg > 0 ? '+' : '') + deg + '°',
    });
  },

  // ---------- 模式切换 ----------
  setMode: function (mode, fromUser) {
    if (fromUser) this.modeLocked = true;
    var dual = mode === 'gamepad';
    this.stopGravity();
    this.resetSources();
    this.joyActive = false;
    this.joyTouchId = undefined;
    this.applyInputs({ steering: CENTER, throttle: CENTER });
    var full = this.data.joyAxis === 'full';
    this.setData({
      mode: mode,
      activeDir: '',
      dirLabel: '',
      joyX: 0,
      joyY: 0,
      joyPressed: false,
      tiltX: 0,
      tiltY: 0,
      idleDirText: dual ? '待命 · 按住前进 / 后退' : '待命 · 按住方向键',
      idleJoyText: dual ? (full ? '待命 · 360° 拖动' : '待命 · 左右拖动转向') : '待命 · 按住摇杆拖动',
      joyActiveText: dual ? (full ? '全向操控 · 实时跟随' : '转向中 · 实时跟随') : '拖动中 · 实时跟随',
    }, function () {
      this.joyRect = null;
      if (mode === 'joystick' || dual) this.measureJoystick();
    }.bind(this));
  },

  onModeTap: function (e) {
    var mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;
    this.setMode(mode, true);
  },

  // 摇杆轴向切换（仅双手柄模式可见）
  onJoyAxisTap: function (e) {
    var axis = e.currentTarget.dataset.axis;
    if (axis !== 'full' && axis !== 'steer') return;
    if (axis === this.data.joyAxis) return;
    this.resetSources();
    this.joyActive = false;
    this.setData({
      joyAxis: axis,
      joyX: 0,
      joyY: 0,
      joyPressed: false,
      idleJoyText: axis === 'full' ? '待命 · 360° 拖动' : '待命 · 左右拖动转向',
      joyActiveText: axis === 'full' ? '全向操控 · 实时跟随' : '转向中 · 实时跟随',
    });
    this.applyInputs({ steering: CENTER, throttle: CENTER });
    this.joyRect = null;
    this.measureJoystick();
    this.appendLog(axis === 'full'
      ? '摇杆：360° 全向（左右转向 / 上下油门）'
      : '摇杆：仅转向（水平单轴，油门交给左侧方向键）');
  },

  // ---------- 连接 ----------
  onConnectTap: function () {
    if (this.data.connected) {
      ble.disconnect();
      return;
    }
    if (this.data.connecting) return;
    this.setData({ connecting: true, statusText: '连接中…' });

    ble.connect({
      onLog: function (text, kind) { this.appendLog(text, kind); }.bind(this),
      onStatus: function (status, name) {
        if (status === 'connected') {
          this.setData({
            connected: true,
            connecting: false,
            statusText: '已连接',
            deviceName: name || 'Jimny',
          });
        } else {
          this.onDisconnected();
        }
      }.bind(this),
      onBattery: function (pct) { this.setData({ battery: pct + '%' }); }.bind(this),
      onNotify: function (hex) { this.appendLog('通知: ' + hex); }.bind(this),
      onDisconnect: function () { this.onDisconnected(); }.bind(this),
    }).catch(function (err) {
      this.appendLog('连接失败: ' + (err.message || err.errMsg || err), 'err');
      this.onDisconnected();
    }.bind(this));
  },

  onDisconnected: function () {
    this.resetSources();
    this.stopGravity();
    this.applyInputs({ steering: CENTER, throttle: CENTER });
    this.setData({
      connected: false,
      connecting: false,
      statusText: '未连接',
      deviceName: '小米吉姆尼 · BLE',
      battery: '--%',
      activeDir: '',
      joyX: 0,
      joyY: 0,
    });
  },

  // ---------- 通用：轻微震动反馈（真机有效，模拟器静默忽略）----------
  vibrate: function () {
    if (typeof wx.vibrateShort === 'function') {
      wx.vibrateShort({ type: 'light', fail: function () {} });
    }
  },

  // ---------- 方向键 ----------
  // 操作反馈与连接状态解耦：未连接时同样显示按下态与读数，仅不下发指令
  onDirStart: function (e) {
    if (this._dirTimer) {
      clearTimeout(this._dirTimer);
      this._dirTimer = null;
    }
    var cmd = e.currentTarget.dataset.cmd;
    var dual = this.data.mode === 'gamepad';
    var s = CENTER;
    var t = CENTER;
    if (cmd === 'forward') t = MAX;
    else if (cmd === 'backward') t = MIN;
    else if (cmd === 'left') s = MIN;
    else if (cmd === 'right') s = MAX;
    var label = DIR_LABEL[cmd] || cmd;
    if (dual) {
      // 左手只负责油门；转向由右侧摇杆独占
      this.dirThrottle = t;
      this.applyInputs({ throttle: this.effectiveThrottle() });
    } else {
      this.applyInputs({ steering: s, throttle: t });
    }
    if (this.data.connected) {
      this.appendLog(label + ' → 油门 ' + t + (dual ? '（转向由摇杆控制）' : ' / 转向 ' + s), 'ok');
    } else {
      this.appendLog('演示：' + label + '（未连接小车，指令未下发）', 'warn');
    }
    this.setData({ activeDir: cmd, dirLabel: label });
    this.vibrate();
  },

  onDirEnd: function () {
    // 只回中自己这一侧；双区模式下另一侧（摇杆）指令保持不变
    if (this.data.mode === 'gamepad') {
      this.dirThrottle = CENTER;
      this.applyInputs({ throttle: this.effectiveThrottle() });
    } else {
      this.applyInputs({ steering: CENTER, throttle: CENTER });
    }
    var that = this;
    if (this._dirTimer) clearTimeout(this._dirTimer);
    this._dirTimer = setTimeout(function () {
      that.setData({ activeDir: '', dirLabel: '' });
      that._dirTimer = null;
    }, 240);
  },

  // ---------- 摇杆 ----------
  measureJoystick: function (cb) {
    wx.createSelectorQuery().in(this)
      .select('#joystick')
      .boundingClientRect(function (rect) {
        if (rect) this.joyRect = rect;
        if (typeof cb === 'function') cb(this.joyRect);
      }.bind(this))
      .exec();
  },

  onJoyStart: function (e) {
    var touch = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
    if (!touch) return;
    // 多指操作：只跟随摇杆这一根手指，避免读到左手方向键的触点坐标
    this.joyTouchId = touch.identifier;
    // touch 是事件快照，异步测量结束后还要用，先复制坐标
    var point = { clientX: touch.clientX, clientY: touch.clientY };
    var that = this;
    if (this._joyTimer) {
      clearTimeout(this._joyTimer);
      this._joyTimer = null;
    }
    this.joyActive = true;
    this.setData({ joyPressed: true });
    if (!this.data.connected) {
      this.appendLog('演示：摇杆可拖动，但未连接小车，指令未下发', 'warn');
    }
    this.vibrate();
    var start = function () { that.updateJoy(point); };
    // 首次切到摇杆时尺寸可能还没测回来，必须等 rect 到手再计算，否则第一次按下没反馈
    if (!this.joyRect) this.measureJoystick(start);
    else start();
  },

  onJoyMove: function (e) {
    if (!this.joyActive) return;
    var list = e.touches || [];
    var touch = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].identifier === this.joyTouchId) { touch = list[i]; break; }
    }
    if (!touch && list.length === 1) touch = list[0]; // 兼容不返回 identifier 的基础库
    this.updateJoy(touch);
  },

  onJoyEnd: function (e) {
    // 多指操作：抬起的是另一根手指时不能把摇杆回中；全部抬完仍需回中（安全兜底）
    if (e && e.changedTouches && e.changedTouches.length && this.joyTouchId !== undefined) {
      var mine = false;
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === this.joyTouchId) { mine = true; break; }
      }
      if (!mine && e.touches && e.touches.length) return;
    }
    this.joyActive = false;
    this.joyTouchId = undefined;
    this.joyThrottle = CENTER;
    if (this.data.mode === 'gamepad') {
      // 转向回中，油门回落到仍然按着的左侧方向键
      this.applyInputs({ steering: CENTER, throttle: this.effectiveThrottle() });
    } else {
      this.applyInputs({ steering: CENTER, throttle: CENTER });
    }
    this.setData({ joyX: 0, joyY: 0 });
    var that = this;
    if (this._joyTimer) clearTimeout(this._joyTimer);
    this._joyTimer = setTimeout(function () {
      that.setData({ joyPressed: false });
      that._joyTimer = null;
    }, 240);
  },

  updateJoy: function (touch) {
    var rect = this.joyRect;
    if (!rect || !touch) return;
    var dual = this.data.mode === 'gamepad';
    // 仅「仅转向」模式锁水平轴；默认 360° 全向，垂直位移同样生效
    var singleAxis = dual && this.data.joyAxis === 'steer';
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var dx = touch.clientX - cx;
    var dy = singleAxis ? 0 : (touch.clientY - cy);
    var max = rect.width / 2;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > max) {
      dx = dx / dist * max;
      dy = dy / dist * max;
    }
    var nx = clamp(dx / max, -1, 1);
    var ny = clamp(dy / max, -1, 1);
    var steering = Math.round(CENTER + nx * (MAX - CENTER));
    var throttle = Math.round(CENTER - ny * (MAX - CENTER));
    if (dual) {
      this.joyThrottle = singleAxis ? CENTER : throttle;
      this.applyInputs({ steering: steering, throttle: this.effectiveThrottle() });
    } else {
      this.applyInputs({ steering: steering, throttle: throttle });
    }
    this.setData({ joyX: dx, joyY: dy });
  },

  // ---------- 重力感应（加速度计）----------
  onGravityEnable: function () {
    if (!this.data.connected) {
      this.appendLog('请先连接小车', 'warn');
      return;
    }
    if (this.data.gravityRunning) {
      this.stopGravity();
      this.appendLog('重力感应已关闭');
      return;
    }
    this.gravityBase = null;
    wx.startAccelerometer({
      interval: 'game',
      success: function () {
        this.setData({ gravityRunning: true, gravityCalibrated: false });
        this.appendLog('重力感应已开启，正在采集中点', 'ok');
      }.bind(this),
      fail: function (err) {
        this.appendLog('加速度计启动失败: ' + (err.errMsg || ''), 'err');
      }.bind(this),
    });
  },

  onGravityCalib: function () {
    if (!this.data.gravityRunning) {
      this.appendLog('请先开启重力感应', 'warn');
      return;
    }
    this.gravityBase = null;
    this.setData({ gravityCalibrated: false });
    this.appendLog('正在重新采集中点');
  },

  onAccel: function (res) {
    if (!this.gravityBase) {
      this.gravityBase = { x: res.x, y: res.y };
      this.setData({ gravityCalibrated: true });
      this.appendLog('中点已校准', 'ok');
      return;
    }
    var dx = res.x - this.gravityBase.x;
    var dy = res.y - this.gravityBase.y;
    var nx = clamp(dx / 0.4, -1, 1);
    var ny = clamp(dy / 0.4, -1, 1);
    var dead = 0.08;
    var sx = Math.abs(nx) < dead ? 0 : nx;
    var sy = Math.abs(ny) < dead ? 0 : ny;
    var steering = Math.round(CENTER + sx * (MAX - CENTER));
    var throttle = Math.round(CENTER - sy * (MAX - CENTER));
    this.applyInputs({ steering: steering, throttle: throttle });
    this.setData({
      tiltX: Math.round(clamp(dx * 80, -40, 40)),
      tiltY: Math.round(clamp(dy * 80, -40, 40)),
    });
  },

  stopGravity: function () {
    if (!this.data.gravityRunning) return;
    wx.stopAccelerometer({});
    this.gravityBase = null;
    this.resetSources();
    this.applyInputs({ steering: CENTER, throttle: CENTER });
    this.setData({
      gravityRunning: false,
      gravityCalibrated: false,
      tiltX: 0,
      tiltY: 0,
    });
  },

  // ---------- 功能控制 ----------
  onLightTap: function () {
    if (!this.data.connected) {
      this.appendLog('请先连接小车', 'warn');
      return;
    }
    var next = !this.data.lightsOn;
    ble.setLights(next).then(function () {
      this.setData({ lightsOn: next });
      this.appendLog('灯光 ' + (next ? '开' : '关'), 'ok');
    }.bind(this)).catch(function (err) {
      this.appendLog('灯光控制失败: ' + (err.errMsg || err.message || ''), 'err');
    }.bind(this));
  },

  onGearTap: function (e) {
    var g = Number(e.currentTarget.dataset.gear);
    this.setData({ gear: g });
    ble.setTargets({ gear: g });
    this.applyInputs({});
    this.appendLog('档位功率 ' + Math.round(g * 100) + '%');
  },

  onTrimChange: function (e) {
    var v = Number(e.detail.value);
    this.setData({ trim: v });
    ble.setTargets({ trim: v });
    this.applyInputs({});
  },

  onBatteryTap: function () {
    if (!this.data.connected) {
      this.appendLog('请先连接小车', 'warn');
      return;
    }
    ble.readBattery();
  },

  onClearLog: function () {
    this.setData({ logs: [], logScrollTop: 0 });
  },

  // ---------- 隐私授权 ----------
  onPrivacyMaskMove: function () {},

  onOpenPrivacyContract: function () {
    if (typeof wx.openPrivacyContract === 'function') {
      wx.openPrivacyContract({ fail: function () {} });
    }
  },

  onPrivacyAgree: function () {
    var resolve = this._privacyResolve;
    this._privacyResolve = null;
    if (typeof resolve === 'function') {
      resolve({ buttonId: 'agree-btn', event: 'agree' });
    }
    this.setData({ showPrivacy: false });
  },

  onPrivacyDisagree: function () {
    var resolve = this._privacyResolve;
    this._privacyResolve = null;
    if (typeof resolve === 'function') {
      resolve({ event: 'disagree' });
    }
    this.setData({ showPrivacy: false });
    this.appendLog('未同意隐私指引，无法使用蓝牙功能', 'warn');
  },
});

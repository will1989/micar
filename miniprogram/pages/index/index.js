'use strict';

var ble = require('../../utils/jimny-ble.js');
var CENTER = ble.CENTER;
var MIN = ble.MIN;
var MAX = ble.MAX;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

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
    mode: 'dpad',
    lightsOn: false,
    gear: 1,
    trim: 0,
    activeDir: '',
    steerReadout: CENTER,
    throttleReadout: CENTER,
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
  },

  onLoad: function () {
    this.logSeq = 0;
    this.joyRect = null;
    this.joyActive = false;
    this.gravityBase = null;
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
    this.appendLog('就绪。点击「连接小车」搜索 JimnygreenSNxxxx。');
  },

  onUnload: function () {
    wx.stopAccelerometer({});
    if (this._privacyHandler && typeof wx.offNeedPrivacyAuthorization === 'function') {
      wx.offNeedPrivacyAuthorization(this._privacyHandler);
    }
    ble.disconnect();
  },

  onHide: function () {
    ble.setTargets({ steering: CENTER, throttle: CENTER });
    this.stopGravity();
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
    this.stopGravity();
    ble.setTargets({ steering: CENTER, throttle: CENTER });
    this.setData({
      connected: false,
      connecting: false,
      statusText: '未连接',
      deviceName: '小米吉姆尼 · BLE',
      battery: '--%',
      activeDir: '',
      steerReadout: CENTER,
      throttleReadout: CENTER,
      joyX: 0,
      joyY: 0,
    });
  },

  // ---------- 模式切换 ----------
  onModeTap: function (e) {
    var mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;
    this.stopGravity();
    ble.setTargets({ steering: CENTER, throttle: CENTER });
    this.setData({
      mode: mode,
      activeDir: '',
      steerReadout: CENTER,
      throttleReadout: CENTER,
      joyX: 0,
      joyY: 0,
      tiltX: 0,
      tiltY: 0,
    }, function () {
      // 摇杆面板渲染后再测量中心坐标
      if (mode === 'joystick') this.measureJoystick();
    }.bind(this));
  },

  // ---------- 方向键 ----------
  onDirStart: function (e) {
    if (!this.data.connected) {
      this.appendLog('请先连接小车', 'warn');
      return;
    }
    var cmd = e.currentTarget.dataset.cmd;
    var s = CENTER;
    var t = CENTER;
    if (cmd === 'forward') t = MAX;
    else if (cmd === 'backward') t = MIN;
    else if (cmd === 'left') s = MIN;
    else if (cmd === 'right') s = MAX;
    ble.setTargets({ steering: s, throttle: t });
    this.setData({ activeDir: cmd, steerReadout: s, throttleReadout: t });
  },

  onDirEnd: function () {
    ble.setTargets({ steering: CENTER, throttle: CENTER });
    this.setData({ activeDir: '', steerReadout: CENTER, throttleReadout: CENTER });
  },

  // ---------- 摇杆 ----------
  measureJoystick: function () {
    wx.createSelectorQuery().in(this)
      .select('#joystick')
      .boundingClientRect(function (rect) {
        if (rect) this.joyRect = rect;
      }.bind(this))
      .exec();
  },

  onJoyStart: function (e) {
    if (!this.data.connected) {
      this.appendLog('请先连接小车', 'warn');
      return;
    }
    if (!this.joyRect) this.measureJoystick();
    this.joyActive = true;
    this.updateJoy(e.touches[0]);
  },

  onJoyMove: function (e) {
    if (!this.joyActive) return;
    this.updateJoy(e.touches[0]);
  },

  onJoyEnd: function () {
    this.joyActive = false;
    ble.setTargets({ steering: CENTER, throttle: CENTER });
    this.setData({ joyX: 0, joyY: 0, steerReadout: CENTER, throttleReadout: CENTER });
  },

  updateJoy: function (touch) {
    var rect = this.joyRect;
    if (!rect || !touch) return;
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var dx = touch.clientX - cx;
    var dy = touch.clientY - cy;
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
    ble.setTargets({ steering: steering, throttle: throttle });
    this.setData({
      joyX: dx,
      joyY: dy,
      steerReadout: steering,
      throttleReadout: throttle,
    });
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
    ble.setTargets({ steering: steering, throttle: throttle });
    this.setData({
      tiltX: Math.round(clamp(dx * 80, -40, 40)),
      tiltY: Math.round(clamp(dy * 80, -40, 40)),
      steerReadout: steering,
      throttleReadout: throttle,
    });
  },

  stopGravity: function () {
    if (!this.data.gravityRunning) return;
    wx.stopAccelerometer({});
    this.gravityBase = null;
    ble.setTargets({ steering: CENTER, throttle: CENTER });
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
    this.appendLog('档位功率 ' + Math.round(g * 100) + '%');
  },

  onTrimChange: function (e) {
    var v = Number(e.detail.value);
    this.setData({ trim: v });
    ble.setTargets({ trim: v });
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

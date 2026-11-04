/**
 * 小米吉姆尼 (Xiaomi Jimny / MiCar) BLE 控制层 —— 微信小程序原生版
 *
 * 协议逆向参考：Matt Cree
 * https://mattcree.github.io/hardware/2026/01/07/reverse-engineering-xiaomi-jimny-ble-protocol.html
 *
 * 控制包 = 3 字节：steering(12bit) + throttle(12bit)，1000 为居中/停止。
 *   b0 = (steer >> 4) & 0xFF
 *   b1 = ((steer << 4) & 0xF0) | ((thr >> 8) & 0x0F)
 *   b2 = thr & 0xFF
 *
 * 微信小程序注意点（本模块已处理）：
 *  1. 同一连接的 BLE 写入必须串行，并发 writeBLECharacteristicValue 会失败 -> 统一写队列
 *  2. 控制特征仅支持 writeNoResponse -> 按 properties 选择 writeType，并在不支持时降级重试
 *  3. Android 扫描 BLE 需要 scope.userLocation 授权与系统定位开关
 *  4. readBLECharacteristicValue 的结果在 onBLECharacteristicValueChange 回调里返回
 *  5. getBLEDeviceServices 返回的 UUID 为小写，比较时统一归一化
 */
'use strict';

var UUID = {
  batteryService: '0000180f-0000-1000-8000-00805f9b34fb',
  batteryChar: '00002a19-0000-1000-8000-00805f9b34fb',
  control: '4fbbffe3-c59c-478d-bb99-d6e06367e344', // 转向/油门
  config: '4fbbffe4-c59c-478d-bb99-d6e06367e344',   // 配置命令
  notify: '4fbbffe5-c59c-478d-bb99-d6e06367e344',   // 通知/遥测
  lights: '4fbbffe6-c59c-478d-bb99-d6e06367e344',   // 灯光
};

var CENTER = 1000;
var MIN = 0;
var MAX = 2000;
var TICK = 50;          // 约 20Hz 保活
var SCAN_TIMEOUT = 15000;

var deviceId = null;
var serviceId = null;
var chars = { control: null, config: null, notify: null, lights: null, battery: null };
var connected = false;
var sendTimer = null;
var scanTimer = null;
var deviceFoundHandler = null;
var hooks = {};

// 页面下达的"意图"值；档位与微调在本层统一叠加
var targets = { steering: CENTER, throttle: CENTER, trim: 0, gear: 1 };

// 串行写队列
var writeQueue = [];
var writing = false;

function norm(u) {
  return String(u || '').toLowerCase();
}

function clampInt(v) {
  v = Math.round(Number(v) || 0);
  return Math.max(MIN, Math.min(MAX, v));
}

function errText(e) {
  if (!e) return '未知错误';
  return e.errMsg || e.message || String(e);
}

function log(text, kind) {
  if (hooks.onLog) hooks.onLog(text, kind);
}

/** Promise 化 wx api */
function wxp(api, opts) {
  return new Promise(function (resolve, reject) {
    api(Object.assign({}, opts || {}, {
      success: function (res) { resolve(res); },
      fail: function (err) { reject(err); },
    }));
  });
}

function toBuffer(bytes) {
  var buf = new ArrayBuffer(bytes.length);
  var view = new Uint8Array(buf);
  for (var i = 0; i < bytes.length; i++) view[i] = bytes[i] & 0xff;
  return buf;
}

function hexOf(buf) {
  var u = new Uint8Array(buf);
  var out = '';
  for (var i = 0; i < u.length; i++) {
    out += (u[i] < 16 ? '0' : '') + u[i].toString(16) + ' ';
  }
  return out.trim();
}

function encodeControl(steering, throttle) {
  var s = clampInt(steering);
  var t = clampInt(throttle);
  return toBuffer([
    (s >> 4) & 0xff,
    ((s << 4) & 0xf0) | ((t >> 8) & 0x0f),
    t & 0xff,
  ]);
}

/** 应用转向微调 + 档位（油门功率限制） */
function encodeCurrent() {
  var steer = clampInt(targets.steering + targets.trim);
  var thr = clampInt(CENTER + (targets.throttle - CENTER) * targets.gear);
  return encodeControl(steer, thr);
}

function pickChar(list, uuid, sid) {
  for (var i = 0; i < list.length; i++) {
    if (norm(list[i].uuid) === norm(uuid)) {
      return {
        uuid: list[i].uuid,
        serviceId: sid,
        properties: list[i].properties || {},
      };
    }
  }
  return null;
}

/** 所有 BLE 写入统一排队，保证串行 */
function enqueueWrite(charMeta, bytes, label) {
  return new Promise(function (resolve, reject) {
    if (!connected || !charMeta) {
      reject(new Error(label + '：未连接或特征不可用'));
      return;
    }
    writeQueue.push({ charMeta: charMeta, bytes: bytes, label: label, resolve: resolve, reject: reject });
    drainQueue();
  });
}

function drainQueue() {
  if (writing || writeQueue.length === 0) return;
  var item = writeQueue.shift();
  writing = true;
  doWrite(item.charMeta, item.bytes).then(
    function (res) {
      writing = false;
      item.resolve(res);
      drainQueue();
    },
    function (err) {
      writing = false;
      item.reject(err);
      drainQueue();
    }
  );
}

function doWrite(charMeta, bytes) {
  var base = {
    deviceId: deviceId,
    serviceId: charMeta.serviceId,
    characteristicId: charMeta.uuid,
    value: toBuffer(bytes),
  };
  var props = charMeta.properties || {};
  var opts = base;
  // 控制特征只支持 writeNoResponse 时，显式指定 writeType
  if (props.writeNoResponse && !props.write) {
    opts = Object.assign({}, base, { writeType: 'writeNoResponse' });
  }
  return wxp(wx.writeBLECharacteristicValue, opts).catch(function (err) {
    // 老基础库不识别 writeType 时降级为普通写
    if (opts.writeType) return wxp(wx.writeBLECharacteristicValue, base);
    throw err;
  });
}

/** 保活循环：约 20Hz 投放控制包，队列堆积时跳过本帧 */
function tick() {
  if (!connected) return;
  if (chars.control && writeQueue.length < 2 && !writing) {
    enqueueWrite(chars.control, encodeCurrent(), '控制').catch(function (err) {
      log('发送失败: ' + errText(err), 'err');
    });
  }
  sendTimer = setTimeout(tick, TICK);
}

function ensureLocationPermission() {
  var platform = '';
  try { platform = wx.getSystemInfoSync().platform || ''; } catch (e) { platform = ''; }
  if (String(platform).toLowerCase().indexOf('android') < 0) return Promise.resolve();

  return wxp(wx.getSetting, {}).then(function (setting) {
    var auth = (setting && setting.authSetting) || {};
    if (auth['scope.userLocation'] === true) return;
    return wxp(wx.authorize, { scope: 'scope.userLocation' });
  }).catch(function () {
    log('安卓位置权限未授予，可能扫描不到小车', 'warn');
  });
}

function stopDiscovery() {
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  if (deviceFoundHandler && typeof wx.offBluetoothDeviceFound === 'function') {
    wx.offBluetoothDeviceFound(deviceFoundHandler);
  }
  deviceFoundHandler = null;
  try { wx.stopBluetoothDevicesDiscovery({}); } catch (e) { /* 适配器可能已关闭 */ }
}

function discoverDevice() {
  stopDiscovery();
  return new Promise(function (resolve, reject) {
    var settled = false;
    function finish(err, device) {
      if (settled) return;
      settled = true;
      stopDiscovery();
      if (err) reject(err); else resolve(device);
    }

    deviceFoundHandler = function (res) {
      var list = (res && res.devices) || [];
      for (var i = 0; i < list.length; i++) {
        var d = list[i];
        var name = d.name || d.localName || '';
        if (name.indexOf('Jimny') === 0) {
          log('发现设备: ' + name);
          finish(null, { deviceId: d.deviceId, name: name });
          return;
        }
      }
    };

    wx.onBluetoothDeviceFound(deviceFoundHandler);
    scanTimer = setTimeout(function () {
      finish(new Error('未扫描到 Jimny 小车：请确认小车已开机、手机蓝牙与定位服务已开启'));
    }, SCAN_TIMEOUT);

    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: false,
      success: function () { log('开始扫描附近设备…'); },
      fail: function (err) { finish(new Error('启动扫描失败: ' + errText(err))); },
    });
  });
}

function resolveCharacteristics() {
  return wxp(wx.getBLEDeviceServices, { deviceId: deviceId }).then(function (res) {
    var services = (res && res.services) || [];
    var chain = Promise.resolve();
    var ctrlServiceUuid = null;
    var batteryServiceUuid = null;

    services.forEach(function (svc) {
      var sid = svc.uuid;
      var sNorm = norm(sid);
      if (sNorm === norm(UUID.batteryService)) batteryServiceUuid = sid;
      chain = chain.then(function () {
        return wxp(wx.getBLEDeviceCharacteristics, { deviceId: deviceId, serviceId: sid })
          .then(function (cr) {
            var list = (cr && cr.characteristics) || [];
            if (list.some(function (c) { return norm(c.uuid) === norm(UUID.control); })) {
              ctrlServiceUuid = sid;
              chars.control = pickChar(list, UUID.control, sid);
              chars.config = pickChar(list, UUID.config, sid);
              chars.notify = pickChar(list, UUID.notify, sid);
              chars.lights = pickChar(list, UUID.lights, sid);
            }
            var bat = pickChar(list, UUID.batteryChar, sid);
            if (bat) chars.battery = bat;
          })
          .catch(function () { /* 该服务不可读，跳过 */ });
      });
    });

    return chain.then(function () {
      if (!ctrlServiceUuid) {
        throw new Error('未找到 Jimny 控制服务，请确认连接的是小车本体');
      }
      serviceId = ctrlServiceUuid;
      log('控制服务: ' + ctrlServiceUuid, 'ok');
      // 电池服务单独再查一次（若前面未命中）
      if (!chars.battery && batteryServiceUuid) {
        return wxp(wx.getBLEDeviceCharacteristics, {
          deviceId: deviceId, serviceId: batteryServiceUuid,
        }).then(function (cr) {
          chars.battery = pickChar((cr && cr.characteristics) || [], UUID.batteryChar, batteryServiceUuid);
        }).catch(function () {});
      }
    });
  });
}

function sendInit() {
  if (!chars.config) {
    log('配置特征不可用，跳过初始化', 'warn');
    return Promise.resolve();
  }
  return enqueueWrite(chars.config, [0x20, 0x01], '初始化')
    .then(function () { log('已发送初始化包', 'ok'); })
    .catch(function (err) { log('初始化包失败: ' + errText(err), 'warn'); });
}

function enableNotify() {
  if (!chars.notify) return Promise.resolve();
  return wxp(wx.notifyBLECharacteristicValueChange, {
    deviceId: deviceId,
    serviceId: chars.notify.serviceId,
    characteristicId: chars.notify.uuid,
    state: true,
  }).then(function () {
    log('遥测通知已开启', 'ok');
  }).catch(function (err) {
    log('通知开启失败: ' + errText(err), 'warn');
  });
}

function readBattery() {
  if (!chars.battery) {
    log('电量特征不可用', 'warn');
    return Promise.resolve();
  }
  // 读取结果在 onBLECharacteristicValueChange 回调中返回
  return wxp(wx.readBLECharacteristicValue, {
    deviceId: deviceId,
    serviceId: chars.battery.serviceId,
    characteristicId: chars.battery.uuid,
  }).catch(function (err) {
    log('电量读取失败: ' + errText(err), 'warn');
  });
}

var handlers = {
  valueChange: function (res) {
    if (!res || !res.value) return;
    var cid = norm(res.characteristicId);
    if (cid === norm(UUID.batteryChar)) {
      var u = new Uint8Array(res.value);
      if (hooks.onBattery && u.length) hooks.onBattery(u[0]);
      return;
    }
    if (hooks.onNotify) hooks.onNotify(hexOf(res.value));
  },
  connState: function (res) {
    if (!connected || !res || res.connected !== false) return;
    if (norm(res.deviceId) !== norm(deviceId)) return;
    teardown(false);
    log('小车已断开', 'warn');
    if (hooks.onDisconnect) hooks.onDisconnect();
  },
};

function registerListeners() {
  if (typeof wx.offBLECharacteristicValueChange === 'function') {
    wx.offBLECharacteristicValueChange(handlers.valueChange);
  }
  if (typeof wx.offBLEConnectionStateChange === 'function') {
    wx.offBLEConnectionStateChange(handlers.connState);
  }
  wx.onBLECharacteristicValueChange(handlers.valueChange);
  wx.onBLEConnectionStateChange(handlers.connState);
}

function unregisterListeners() {
  if (typeof wx.offBLECharacteristicValueChange === 'function') {
    wx.offBLECharacteristicValueChange(handlers.valueChange);
  }
  if (typeof wx.offBLEConnectionStateChange === 'function') {
    wx.offBLEConnectionStateChange(handlers.connState);
  }
}

function clearQueue() {
  while (writeQueue.length) {
    var item = writeQueue.shift();
    item.reject(new Error('连接已断开'));
  }
}

function teardown(closeConnection) {
  var wasConnected = connected;
  connected = false;
  if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
  clearQueue();
  stopDiscovery();
  if (closeConnection && deviceId) {
    try { wx.closeBLEConnection({ deviceId: deviceId }); } catch (e) { /* 已断开 */ }
  }
  unregisterListeners();
  deviceId = null;
  serviceId = null;
  chars = { control: null, config: null, notify: null, lights: null, battery: null };
  targets = { steering: CENTER, throttle: CENTER, trim: 0, gear: 1 };
  return wasConnected;
}

/** 连接小车。hooks: { onLog, onStatus, onBattery, onNotify, onDisconnect } */
function connect(options) {
  hooks = options || {};
  if (connected) return Promise.resolve();

  return wxp(wx.openBluetoothAdapter, {}).catch(function (err) {
    throw new Error('蓝牙适配器不可用，请确认手机蓝牙已开启（' + errText(err) + '）');
  }).then(function () {
    log('蓝牙适配器就绪', 'ok');
    return ensureLocationPermission();
  }).then(function () {
    registerListeners();
    return discoverDevice();
  }).then(function (device) {
    deviceId = device.deviceId;
    return wxp(wx.createBLEConnection, { deviceId: deviceId })
      .then(function () { return device; });
  }).then(function (device) {
    return resolveCharacteristics().then(function () { return device; });
  }).then(function (device) {
    connected = true; // 允许 sendInit 走写队列
    return sendInit().then(function () { return device; });
  }).then(function (device) {
    return enableNotify().then(function () { return device; });
  }).then(function (device) {
    return readBattery().then(function () { return device; });
  }).then(function (device) {
    tick();
    if (hooks.onStatus) hooks.onStatus('connected', device.name);
    log('连接成功，开始保活发送', 'ok');
    return device;
  }).catch(function (err) {
    teardown(true);
    throw err;
  });
}

function disconnect() {
  var wasConnected = teardown(true);
  try { wx.closeBluetoothAdapter({}); } catch (e) { /* 忽略 */ }
  if (wasConnected && hooks.onStatus) hooks.onStatus('disconnected');
  if (wasConnected) log('已主动断开');
}

function setTargets(next) {
  if (!next) return;
  if (next.steering !== undefined) targets.steering = clampInt(next.steering);
  if (next.throttle !== undefined) targets.throttle = clampInt(next.throttle);
  if (next.trim !== undefined) targets.trim = Number(next.trim) || 0;
  if (next.gear !== undefined) targets.gear = Number(next.gear) || 1;
}

function setLights(on) {
  if (!chars.lights) return Promise.reject(new Error('该设备不支持灯光控制'));
  return enqueueWrite(chars.lights, [on ? 0x01 : 0x00], '灯光');
}

module.exports = {
  UUID: UUID,
  CENTER: CENTER,
  MIN: MIN,
  MAX: MAX,
  connect: connect,
  disconnect: disconnect,
  setTargets: setTargets,
  setLights: setLights,
  readBattery: readBattery,
  isConnected: function () { return connected; },
};

/* MiCar 遥控 (WebBLE)
 * 协议逆向参考：Matt Cree — https://mattcree.github.io/hardware/2026/01/07/reverse-engineering-xiaomi-jimny-ble-protocol.html
 * 控制包 = 3 字节：steering(12bit) + throttle(12bit)，1000 为居中/停止。
 * 注：高低速档位为 UI 端功率限制器（原厂高速/低速协议未公开）。
 */
(() => {
  'use strict';

  // ---- UUID ----
  const UUID = {
    // 自定义服务 UUID 未在文档中给出，列举候选，连接后自动发现包含控制特征的服务
    serviceCandidates: [
      '4fbbffe0-c59c-478d-bb99-d6e06367e344',
      '4fbbffe1-c59c-478d-bb99-d6e06367e344',
      '4fbbffe2-c59c-478d-bb99-d6e06367e344',
      '4fbbffe3-c59c-478d-bb99-d6e06367e344',
    ],
    batteryService: '0000180f-0000-1000-8000-00805f9b34fb',
    batteryChar:    '00002a19-0000-1000-8000-00805f9b34fb',
    control: '4fbbffe3-c59c-478d-bb99-d6e06367e344', // 转向/油门，WriteWithoutResponse
    config:  '4fbbffe4-c59c-478d-bb99-d6e06367e344', // 配置命令，Write
    notify:  '4fbbffe5-c59c-478d-bb99-d6e06367e344', // 通知/遥测，Notify
    lights:  '4fbbffe6-c59c-478d-bb99-d6e06367e344', // 灯光，Write
  };

  const CENTER = 1000, MIN = 0, MAX = 2000;
  const SEND_INTERVAL = 50; // 约 20Hz 保活
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---- 状态 ----
  const S = {
    gatt: null, svc: null,
    ctrlChar: null, cfgChar: null, notifyChar: null, lightChar: null, batChar: null,
    connected: false,
    lightsOn: false,
    gear: 1.0,
    trim: 0,
    targetSteering: CENTER,
    targetThrottle: CENTER,
    mode: 'dpad',
    sendTimer: null,
    gravityCalib: null,
    gravityHandler: null,
  };

  // ---- DOM ----
  const $ = (s) => document.querySelector(s);
  const els = {
    connectBtn: $('#connectBtn'),
    compatNote: $('#compatNote'),
    statusPill: $('#statusPill'),
    deviceName: $('#deviceName'),
    battery: $('#battery'),
    tabs: $('#tabs'),
    panel: $('#panel'),
    controls: $('#controls'),
    logZone: $('#logZone'),
    log: $('#log'),
    lightBtn: $('#lightBtn'),
    gear: $('#gear'),
    trim: $('#trim'),
    trimVal: $('#trimVal'),
    batteryBtn: $('#batteryBtn'),
    clearLog: $('#clearLog'),
    joystick: $('#joystick'),
    joyKnob: $('#joyKnob'),
    jsSteer: $('#jsSteer'),
    jsThrottle: $('#jsThrottle'),
    dpSteer: $('#dpSteer'),
    dpThrottle: $('#dpThrottle'),
    dirState: $('#dirState'),
    joyState: $('#joyState'),
    gravityTilt: $('#gravityTilt'),
    gravityLabel: $('#gravityLabel'),
    gravityEnable: $('#gravityEnable'),
    gravityCalib: $('#gravityCalib'),
    grSteer: $('#grSteer'),
    grThrottle: $('#grThrottle'),
  };

  // ---- 日志 ----
  function log(msg, kind) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = document.createElement('div');
    if (kind) line.className = kind;
    line.textContent = `[${t}] ${msg}`;
    els.log.appendChild(line);
    els.log.scrollTop = els.log.scrollHeight;
    while (els.log.childElementCount > 200) els.log.removeChild(els.log.firstChild);
  }

  function setStatus(text, cls) {
    els.statusPill.textContent = text;
    els.statusPill.className = 'pill ' + cls;
    // 连接后隐藏所有"演示模式"提示条
    document.body.classList.toggle('is-connected', cls === 'pill-on');
  }

  // ---- 编码 ----
  function encodeControl(steering, throttle) {
    steering = clamp(Math.round(steering), MIN, MAX);
    throttle = clamp(Math.round(throttle), MIN, MAX);
    const b0 = (steering >> 4) & 0xFF;
    const b1 = ((steering << 4) & 0xF0) | ((throttle >> 8) & 0x0F);
    const b2 = throttle & 0xFF;
    return new Uint8Array([b0, b1, b2]);
  }

  // 实际发送时叠加转向微调
  function currentTargets() {
    const steer = clamp(S.targetSteering + S.trim, MIN, MAX);
    return [steer, S.targetThrottle];
  }

  // ---- 发送循环（保活）----
  async function sendTick() {
    if (!S.connected || !S.ctrlChar) return;
    try {
      const [s, t] = currentTargets();
      await S.ctrlChar.writeValueWithoutResponse(encodeControl(s, t));
    } catch (e) {
      log('发送失败: ' + e.message, 'err');
    }
  }
  function startLoop() {
    stopLoop();
    S.sendTimer = setInterval(sendTick, SEND_INTERVAL);
  }
  function stopLoop() {
    if (S.sendTimer) { clearInterval(S.sendTimer); S.sendTimer = null; }
  }

  // ---- 连接 ----
  async function connect() {
    if (!navigator.bluetooth) {
      els.compatNote.hidden = false;
      els.compatNote.textContent = '当前浏览器不支持 Web Bluetooth（iOS Safari 不支持）。请用安卓 Chrome / Edge / 华为浏览器，或桌面 Chrome。';
      return;
    }
    try {
      setStatus('扫描中…', 'pill-busy');
      els.connectBtn.disabled = true;
      els.connectBtn.textContent = '扫描中…';

      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'Jimny' }],
        optionalServices: [...UUID.serviceCandidates, UUID.batteryService],
      });

      setStatus('连接中…', 'pill-busy');
      log('发现设备: ' + (device.name || '未知'));

      const gatt = await device.gatt.connect();
      S.gatt = gatt;

      // 发现包含控制特征的服务
      const services = await gatt.getPrimaryServices();
      let svc = null;
      for (const s of services) {
        const chars = await s.getCharacteristics();
        if (chars.some((c) => c.uuid.toLowerCase() === UUID.control)) { svc = s; break; }
      }
      if (!svc) throw new Error('未找到 Jimny 控制服务，请确认小车已开机且在范围内');

      S.svc = svc;
      S.ctrlChar = await svc.getCharacteristic(UUID.control);
      try { S.cfgChar = await svc.getCharacteristic(UUID.config); } catch (_) {}
      try { S.notifyChar = await svc.getCharacteristic(UUID.notify); } catch (_) {}
      try { S.lightChar = await svc.getCharacteristic(UUID.lights); } catch (_) {}

      // 通知
      if (S.notifyChar) {
        S.notifyChar.addEventListener('characteristicvaluechanged', onNotify);
        try { await S.notifyChar.startNotifications(); } catch (_) {}
      }

      // 初始化命令（连接后发送）
      if (S.cfgChar) {
        try { await S.cfgChar.writeValue(new Uint8Array([0x20, 0x01])); log('已发送初始化包', 'ok'); }
        catch (e) { log('初始化包发送失败: ' + e.message, 'warn'); }
      }

      // 电量
      try {
        const bs = await gatt.getPrimaryService(UUID.batteryService);
        S.batChar = await bs.getCharacteristic(UUID.batteryChar);
        await readBattery();
      } catch (e) { log('电量读取不可用: ' + e.message, 'warn'); }

      S.connected = true;
      els.deviceName.textContent = device.name || 'Jimny';
      setStatus('已连接', 'pill-on');
      els.connectBtn.textContent = '断开';
      els.connectBtn.disabled = false;
      [els.tabs, els.panel, els.controls, els.logZone].forEach((e) => (e.hidden = false));

      device.addEventListener('gattserverdisconnected', onDisconnect);
      startLoop();
      log('✅ 连接成功，开始保活发送', 'ok');
    } catch (e) {
      log('❌ ' + e.message, 'err');
      setStatus('未连接', 'pill-off');
      els.connectBtn.disabled = false;
      els.connectBtn.textContent = '连接小车';
    }
  }

  function onNotify(event) {
    const v = event.target.value;
    const hex = Array.from(new Uint8Array(v.buffer)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    log('📩 通知: ' + hex);
  }

  async function readBattery() {
    if (!S.batChar) return;
    try {
      const v = await S.batChar.readValue();
      const pct = v.getUint8(0);
      els.battery.textContent = pct + '%';
      log('电量: ' + pct + '%');
    } catch (e) { log('电量读取失败: ' + e.message, 'warn'); }
  }

  function disconnect() {
    stopLoop();
    try { if (S.gatt && S.gatt.connected) S.gatt.disconnect(); } catch (_) {}
    onDisconnect();
  }

  function onDisconnect() {
    S.connected = false;
    stopLoop();
    setStatus('未连接', 'pill-off');
    els.connectBtn.textContent = '连接小车';
    els.connectBtn.disabled = false;
    els.battery.textContent = '--%';
    els.deviceName.textContent = 'WebBLE · 小米吉姆尼';
    log('🔌 已断开', 'warn');
    stopGravity();
    els.gravityLabel.textContent = '未校准';
  }

  // ---- 方向键 ----
  const DIR_LABEL = { forward: '前进', backward: '后退', left: '左转', right: '右转', stop: '停车' };

  function syncDpadReadout() {
    els.dpSteer.textContent = Math.round(S.targetSteering + S.trim);
    els.dpThrottle.textContent = Math.round(S.targetThrottle);
  }

  // 操作反馈与连接状态解耦：未连接时同样显示按下态与读数，仅不下发指令
  function applyDir(cmd) {
    const g = S.gear;
    const fwd = CENTER + (MAX - CENTER) * g;
    const rev = CENTER - (MAX - CENTER) * g;
    switch (cmd) {
      case 'forward':  S.targetThrottle = fwd;        S.targetSteering = CENTER; break;
      case 'backward': S.targetThrottle = rev;        S.targetSteering = CENTER; break;
      case 'left':     S.targetSteering = MIN;        S.targetThrottle = CENTER; break;
      case 'right':    S.targetSteering = MAX;        S.targetThrottle = CENTER; break;
      case 'stop':     S.targetThrottle = CENTER;     S.targetSteering = CENTER; break;
    }
    syncDpadReadout();
    if (!S.connected) log('⚠️ 演示：' + (DIR_LABEL[cmd] || cmd) + '（未连接小车，指令未下发）', 'warn');
  }

  function resetNeutral() {
    S.targetThrottle = CENTER;
    S.targetSteering = CENTER;
    syncDpadReadout();
  }

  function bindDpad() {
    let releaseTimer = null;
    document.querySelectorAll('.dbtn').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
        btn.classList.add('held');
        els.dirState.textContent = DIR_LABEL[btn.dataset.cmd] || '操作中';
        els.dirState.classList.add('on');
        applyDir(btn.dataset.cmd);
      });
      const release = () => {
        resetNeutral();
        // 指令立即回中，高亮延迟熄灭：鼠标快速单击也能看到明确的"按到了"反馈
        if (releaseTimer) clearTimeout(releaseTimer);
        releaseTimer = setTimeout(() => {
          btn.classList.remove('held');
          els.dirState.textContent = '待命 · 按住方向键';
          els.dirState.classList.remove('on');
          releaseTimer = null;
        }, 240);
      };
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('pointerleave', () => { if (btn.classList.contains('held')) release(); });
    });
    // 全局兜底：任意抬起都回中，避免漏掉 pointerup
    window.addEventListener('pointerup', resetNeutral);
    window.addEventListener('pointercancel', resetNeutral);
    // 注：● 停车键已在上面的 .dbtn 循环里绑定 pointerdown/up，无需再按 id 单独绑定
  }

  // ---- 摇杆 ----
  function bindJoystick() {
    const j = els.joystick;
    let active = false;
    let releaseTimer = null;
    const setKnob = (x, y) => { els.joyKnob.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`; };
    const update = (clientX, clientY) => {
      const r = j.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = clientX - cx, dy = clientY - cy;
      const max = r.width / 2;
      const dist = Math.hypot(dx, dy);
      if (dist > max) { dx = dx / dist * max; dy = dy / dist * max; }
      setKnob(dx, dy);
      const nx = clamp(dx / max, -1, 1);
      const ny = clamp(dy / max, -1, 1);
      S.targetSteering = CENTER + nx * (MAX - CENTER);
      S.targetThrottle = CENTER - ny * (MAX - CENTER) * S.gear;
      els.jsSteer.textContent = Math.round(S.targetSteering + S.trim);
      els.jsThrottle.textContent = Math.round(S.targetThrottle);
    };
    const end = () => {
      active = false;
      setKnob(0, 0);
      resetNeutral();
      els.jsSteer.textContent = '1000';
      els.jsThrottle.textContent = '1000';
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => {
        j.classList.remove('active');
        els.joyKnob.classList.remove('active');
        els.joyState.textContent = '待命 · 按住摇杆拖动';
        els.joyState.classList.remove('on');
        releaseTimer = null;
      }, 240);
    };
    j.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
      active = true;
      j.classList.add('active');
      els.joyKnob.classList.add('active');
      els.joyState.textContent = '拖动中 · 实时跟随';
      els.joyState.classList.add('on');
      if (!S.connected) log('⚠️ 演示：摇杆可拖动，但未连接小车，指令未下发', 'warn');
      try { j.setPointerCapture(e.pointerId); } catch (err) { /* 部分浏览器不支持 */ }
      update(e.clientX, e.clientY);
    });
    j.addEventListener('pointermove', (e) => { if (active) update(e.clientX, e.clientY); });
    j.addEventListener('pointerup', end);
    j.addEventListener('pointercancel', end);
  }

  // ---- 重力感应 ----
  function bindGravity() {
    els.gravityEnable.addEventListener('click', async () => {
      if (!S.connected) log('⚠️ 演示：重力读数可见，但未连接小车，指令未下发', 'warn');
      if (typeof DeviceOrientationEvent === 'undefined') {
        log('❌ 此设备不支持方向传感器', 'err'); return;
      }
      // iOS 需要用户手势授权
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
          const res = await DeviceOrientationEvent.requestPermission();
          if (res !== 'granted') { log('❌ 未授予方向权限', 'err'); return; }
        } catch (e) { log('❌ 方向权限错误: ' + e.message, 'err'); return; }
      }
      startGravity();
    });

    els.gravityCalib.addEventListener('click', () => {
      S.gravityCalib = { beta: lastOrient.beta || 0, gamma: lastOrient.gamma || 0 };
      els.gravityLabel.textContent = '已校准';
      log('重力居中已校准');
    });
  }

  const lastOrient = { beta: 0, gamma: 0 };

  function stopGravity() {
    if (!S.gravityHandler) return;
    window.removeEventListener('deviceorientation', S.gravityHandler);
    S.gravityHandler = null;
    els.gravityLabel.textContent = '已停止';
    const phone = els.gravityTilt.querySelector('.tilt-phone');
    if (phone) phone.style.transform = '';
  }

  function startGravity() {
    if (S.gravityHandler) return;
    const handler = (e) => {
      lastOrient.beta = e.beta || 0; lastOrient.gamma = e.gamma || 0;
      if (!S.gravityCalib) { els.gravityLabel.textContent = '请先校准'; return; }
      const db = (e.beta || 0) - S.gravityCalib.beta;
      const dg = (e.gamma || 0) - S.gravityCalib.gamma;
      const nx = clamp(dg / 30, -1, 1);   // 左右倾斜 -> 转向
      const ny = clamp(db / 30, -1, 1);   // 前后倾斜 -> 油门
      const dead = 0.08;
      const sx = Math.abs(nx) < dead ? 0 : nx;
      const sy = Math.abs(ny) < dead ? 0 : ny;
      S.targetSteering = CENTER + sx * (MAX - CENTER);
      S.targetThrottle = CENTER - sy * (MAX - CENTER) * S.gear;
      els.grSteer.textContent = Math.round(S.targetSteering + S.trim);
      els.grThrottle.textContent = Math.round(S.targetThrottle);
      // 视觉反馈
      els.gravityTilt.querySelector('.tilt-phone').style.transform =
        `rotate(${clamp(dg,-40,40)}deg) rotateX(${clamp(db,-40,40)}deg)`;
    };
    window.addEventListener('deviceorientation', handler);
    S.gravityHandler = handler;
    els.gravityLabel.textContent = '运行中';
    log('重力感应已开启', 'ok');
  }

  // ---- 灯光 ----
  async function toggleLights() {
    if (!S.connected || !S.lightChar) { log('⚠️ 未连接或不支持灯光', 'warn'); return; }
    S.lightsOn = !S.lightsOn;
    try {
      await S.lightChar.writeValue(new Uint8Array([S.lightsOn ? 0x01 : 0x00]));
      els.lightBtn.setAttribute('aria-pressed', String(S.lightsOn));
      els.lightBtn.textContent = S.lightsOn ? '开' : '关';
      log('灯光 ' + (S.lightsOn ? '开' : '关'), 'ok');
    } catch (e) { log('灯光控制失败: ' + e.message, 'err'); S.lightsOn = !S.lightsOn; }
  }

  // ---- 模式切换 ----
  function bindTabs() {
    els.tabs.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const mode = tab.dataset.mode;
        S.mode = mode;
        els.tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
        els.panel.querySelectorAll('.mode-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === mode));
        // 离开重力模式时停掉传感器，避免它在后台持续覆盖其它模式的转向/油门指令
        if (mode !== 'gravity') stopGravity();
        // 切换模式时回中，避免残留指令
        resetNeutral();
      });
    });
  }

  // ---- 杂项绑定 ----
  function bindMisc() {
    els.connectBtn.addEventListener('click', () => {
      if (S.connected) disconnect(); else connect();
    });
    els.lightBtn.addEventListener('click', toggleLights);
    els.batteryBtn.addEventListener('click', readBattery);
    els.clearLog.addEventListener('click', () => { els.log.innerHTML = ''; });
    els.gear.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        S.gear = parseFloat(b.dataset.gear);
        els.gear.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        log('档位: ' + b.textContent + ' (功率 ' + Math.round(S.gear * 100) + '%)');
      });
    });
    els.trim.addEventListener('input', () => {
      S.trim = parseInt(els.trim.value, 10);
      els.trimVal.textContent = S.trim;
    });
    // 切到后台时回中，防止失控
    document.addEventListener('visibilitychange', () => { if (document.hidden) resetNeutral(); });
  }

  // ---- 错误可见化 ----
  // 手机端没有 DevTools：把脚本异常写进页面日志，并标明来自浏览器扩展的报错
  function bindErrorReporting() {
    window.addEventListener('error', (e) => {
      const sameOrigin = e.filename && (e.filename.startsWith(location.origin) || e.filename.startsWith('file:'));
      log('❌ 脚本错误' + (e.filename && !sameOrigin ? '（浏览器扩展/外部脚本）' : '') + ': ' + (e.message || '未知'), 'err');
    });
    window.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason || {};
      log('⚠️ 未处理的异步异常（多来自浏览器扩展，不影响本页）: ' + (reason.message || String(reason)), 'warn');
    });
  }

  // ---- 启动 ----
  function init() {
    bindErrorReporting();

    // 自检：任何 DOM 引用缺失都直接报出来，别让整个初始化静默中断
    const missing = Object.keys(els).filter((k) => !els[k]);
    if (missing.length) log('⚠️ 缺失 DOM 节点: ' + missing.join(', '), 'warn');

    // 每个模块独立容错：单一模块出错不再连带 tab / 摇杆 / 重力全部失效
    const safe = (name, fn) => {
      try { fn(); }
      catch (e) {
        console.error('[MiCar] ' + name + ' 初始化失败', e);
        log('❌ ' + name + ' 初始化失败: ' + e.message, 'err');
      }
    };

    safe('兼容提示', () => {
      if (!navigator.bluetooth) {
        els.compatNote.hidden = false;
        els.compatNote.textContent = '提示：当前浏览器不支持 Web Bluetooth（iOS Safari 不支持）。建议用安卓 Chrome / Edge / 华为浏览器打开本页。';
      }
    });

    // 面板默认可见：未连接时也能试操作（演示模式），不必先连真车
    [els.tabs, els.panel, els.controls, els.logZone].forEach((e) => { if (e) e.hidden = false; });

    safe('模式切换', bindTabs);   // 优先绑定，保证 tab 永远可切换
    safe('方向键', bindDpad);
    safe('摇杆', bindJoystick);
    safe('重力', bindGravity);
    safe('其他控件', bindMisc);
    log('就绪。点击「连接小车」并选择 JimnygreenSNxxxx。');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

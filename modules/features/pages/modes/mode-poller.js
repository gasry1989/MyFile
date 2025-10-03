import { wsHub } from '@core/hub.js';
import { POLL_INTERVAL, FAIL_THRESHOLD } from '/config/constants.js';

const GRACE_FACTOR = 1.6;
const THROTTLE_DRIFT_FACTOR = 2.5;
const THROTTLE_DEFER_MULT = 2.0;
const SINGLE_INFLIGHT = true;

const OFFLINE_CODE = 2004;

// 需要使用简化模式的命令（统一逻辑）
const SIMPLE_CMDS = new Set(['diponechannel', 'diptwochannel', 'audioonechannel']);

const _scope = (function () {
  try {
    if (window.top && window.top !== window && window.top.__GLOBAL_MODE_POLLER_SCOPE__) {
      return window.top.__GLOBAL_MODE_POLLER_SCOPE__;
    }
  } catch { }
  if (!window.__GLOBAL_MODE_POLLER_SCOPE__) {
    window.__GLOBAL_MODE_POLLER_SCOPE__ = { instance: null };
  }
  return window.__GLOBAL_MODE_POLLER_SCOPE__;
})();

function __mpTs() {
  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const p3 = n => String(n).padStart(3, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}
function _normCmd(c) { return String(c || '').trim(); }
function _lcCmd(c) { return _normCmd(c).toLowerCase(); }

class ModePoller {
  constructor() {
    this.map = new Map();           // key -> entry
    this.ridMap = new Map();        // requestId -> entry (用于 error / 2004 反查)
    this.listeners = {
      suspend: new Set(),
      resume: new Set(),
      send: new Set(),
      success: new Set()
    };

    try {
      window.addEventListener('beforeunload', () => this.disposeAll());
    } catch { }

    try {
      this._unsubRaw = wsHub.onRaw((msg) => {
        if (!msg) return;
        const code = msg.code;
        const requestId = msg.requestId;
        const rawCmd = _normCmd(msg.cmd);

        // 1) 离线判定：cmd === 'error' && code === 2004 或 某些响应返回 code=2004
        if (code === OFFLINE_CODE) {
          this._handleOfflineByRaw(msg);
          return;
        }

        // 2) 正常成功响应（*Response）
        if (rawCmd.endsWith('Response')) {
          const origin = rawCmd.slice(0, -8);
            this._handleResponseSuccess(origin, msg);
        }
        // 其它普通成功 (有时服务端可能直接用原命令返回，也可以扩展；当前按需求只处理 *Response)
      });
    } catch { }
  }

  key(cmd, devId) { return `${_lcCmd(cmd)}:${String(devId)}`; }

  _getEntry(cmd, devId) {
    const kLower = this.key(cmd, devId);
    return this.map.get(kLower) || this.map.get(`${_normCmd(cmd)}:${String(devId)}`);
  }

  _handleOfflineByRaw(msg) {
    // 优先按 requestId 查
    const rid = msg.requestId;
    let e = rid != null ? this.ridMap.get(rid) : null;

    if (!e) {
      // 如果是 *Response 也可以试着解析出 origin + devId
      if (msg.cmd && msg.cmd.endsWith('Response')) {
        const origin = msg.cmd.slice(0, -8);
        const devId =
          (msg.to && msg.to.id != null) ? msg.to.id :
            (msg.from && msg.from.id != null) ? msg.from.id :
              null;
        if (devId != null) {
          e = this._getEntry(origin, devId);
        }
      }
    }
    if (!e) {
      // 也可能是 'error' ：尝试从 ridMap 没找到就忽略
      console.warn(`[DBGTS ${__mpTs()}][POLL][offline-miss] rid=${rid} cmd=${msg.cmd}`);
      return;
    }
    if (e.suspended) {
      console.log(`[DBGTS ${__mpTs()}][POLL][offline-ignore] cmd=${e.cmd} devId=${e.devId} (already suspended)`);
      return;
    }
    e.failCount = Math.max(e.failCount, FAIL_THRESHOLD);
    e.offline = true;
    console.warn(`[DBGTS ${__mpTs()}][POLL][offline][${e.simple ? 'SIMPLE' : 'GEN'}] cmd=${e.cmd} devId=${e.devId} rid=${rid} code=${OFFLINE_CODE} -> suspend`);
    this.suspend(e.cmd, e.devId, 'offline-2004');
  }

  _handleResponseSuccess(originCmd, msg) {
    const devId =
      (msg.to && msg.to.id != null) ? msg.to.id :
        (msg.from && msg.from.id != null) ? msg.from.id :
          null;
    if (devId == null) return;
    const e = this._getEntry(originCmd, devId);
    if (!e) return;
    if (e.offline || e.suspended) {
      // 离线或暂停状态下不重置（除非未来业务要求自动恢复）
      return;
    }

    // 判断 data 是否为空（仅针对 SIMPLE_CMDS 才做 interval 动态调整）
    if (e.simple) {
      const d = msg.data;
      let empty = false;
      if (d == null) empty = true;
      else if (Array.isArray(d)) empty = d.length === 0;
      else if (typeof d === 'object') {
        empty = Object.keys(d).length === 0;
      }
      const prevHasData = e.hasData;
      e.hasData = !empty;
      if (prevHasData !== e.hasData) {
        const newInterval = e.hasData ? e.activeIntervalMs : e.idleIntervalMs;
        e.intervalMs = newInterval;
        e.nextDue = performance.now() + newInterval;
        if (e.timer) { clearTimeout(e.timer); e.timer = null; }
        console.log(`[DBGTS ${__mpTs()}][POLL][interval-shift][SIMPLE] cmd=${e.cmd} devId=${e.devId} hasData=${e.hasData} intervalMs=${newInterval}`);
        this._scheduleSimple(e);
      }
    }

    this.markSuccess(originCmd, devId, msg.requestId);
  }

  subscribe({ cmd, devId, intervalMs = POLL_INTERVAL, data = {} }) {
    const devNum = Number(devId);
    if (!cmd || !Number.isFinite(devNum)) {
      console.warn('[ModePoller] invalid subscribe params', { cmd, devId });
      return () => { };
    }
    devId = devNum;
    const norm = _normCmd(cmd);
    const lower = _lcCmd(norm);
    const isSimple = SIMPLE_CMDS.has(lower);

    const k = this.key(norm, devId);
    let e = this.map.get(k);
    if (!e) {
      e = this._createEntry({ cmd: norm, devId, intervalMs, data, simple: isSimple });
      this.map.set(k, e);
      console.log(`[DBGTS ${__mpTs()}][POLL][subscribe-new] cmd=${norm} devId=${devId} intervalMs=${intervalMs} ${isSimple ? '[SIMPLE]' : ''} FAIL_THRESHOLD=${FAIL_THRESHOLD}`);
      this._start(e);
    } else {
      console.log(`[DBGTS ${__mpTs()}][POLL][subscribe-ref] cmd=${norm} devId=${devId} intervalMs=${e.intervalMs} refCount(before)=${e.refCount}`);
    }
    e.refCount++;
    return () => this._unsubscribe(k);
  }

  updateInterval(cmd, devId, newIntervalMs) {
    const e = this._getEntry(cmd, devId);
    if (!e) {
      console.warn('[ModePoller][updateInterval] entry not found', cmd, devId);
      return;
    }
    const ms = Number(newIntervalMs);
    if (!Number.isFinite(ms) || ms <= 0) {
      console.warn('[ModePoller][updateInterval] invalid interval', newIntervalMs);
      return;
    }
    e.baseActiveIntervalMs = ms;
    e.activeIntervalMs = ms;

    // 如果当前有数据，就使用 activeInterval；无数据使用 idleInterval
    const target = e.hasData ? e.activeIntervalMs : e.idleIntervalMs;
    e.intervalMs = target;
    e.nextDue = performance.now() + 1;
    if (e.simple) {
      if (e.timer) clearTimeout(e.timer);
      this._scheduleSimple(e);
      console.log(`[DBGTS ${__mpTs()}][POLL][interval-updated][SIMPLE] cmd=${e.cmd} devId=${devId} active=${e.activeIntervalMs} idle=${e.idleIntervalMs}`);
    } else {
      this._schedule(e);
      console.log(`[DBGTS ${__mpTs()}][POLL][interval-updated] cmd=${e.cmd} devId=${devId} base=${ms}`);
    }
  }

  markSuccess(cmd, devId /* requestId 可忽略 */) {
    const e = this._getEntry(cmd, devId);
    if (!e) return;
    if (e.offline) return;         // 离线不再清零
    if (e.suspended) return;       // 已暂停不处理

    if (e.simple) {
      if (e.failCount !== 0) {
        e.failCount = 0;
        e.lastRespAt = performance.now();
        // console.log(`[DBGTS ${__mpTs()}][POLL][markSuccess][SIMPLE] cmd=${e.cmd} devId=${e.devId} failCount=0`);
      }
      this._emit('success', { cmd: e.cmd, devId: e.devId, rid: null });
      return;
    }

    // 非 simple 旧逻辑
    const requestId = arguments[2];
    if (requestId && e.current?.rid && e.current.rid !== requestId) {
      console.log(`[DBGTS ${__mpTs()}][POLL][late-success] cmd=${e.cmd} devId=${e.devId} rid=${requestId}`);
      return;
    }
    if (e.current && requestId && e.current.rid === requestId) {
      e.current = null;
    }
    if (requestId && e.lastRespRid === requestId) return;
    e.lastRespRid = requestId || e.lastRespRid || e.lastReqRid;
    e.failCount = 0;
    e.lastRespAt = performance.now();
    console.log(`[DBGTS ${__mpTs()}][POLL][markSuccess] cmd=${e.cmd} devId=${e.devId} rid=${requestId} failCountReset`);
    this._emit('success', { cmd: e.cmd, devId: e.devId, rid: requestId });
  }

  suspend(cmd, devId, reason = '') {
    const e = this._getEntry(cmd, devId);
    if (!e) return;
    if (!e.suspended) {
      e.suspended = true;
      if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      // console.warn(`[DBGTS ${__mpTs()}][POLL][suspend${e.simple ? '-SIMPLE' : ''}] cmd=${e.cmd} devId=${e.devId} failCount=${e.failCount} reason=${reason}`);
      this._emit('suspend', { cmd: e.cmd, devId: e.devId, reason });
    }
  }

  resume(cmd, devId, { immediate = true } = {}) {
    const e = this._getEntry(cmd, devId);
    if (!e) return;
    e.failCount = 0;
    e.offline = false;
    e.suspended = false;
    e.lastResumeAt = performance.now();
    e.current = null;
    // interval 根据 hasData 决定
    e.intervalMs = e.hasData ? e.activeIntervalMs : e.idleIntervalMs;
    e.nextDue = immediate ? performance.now() : performance.now() + e.intervalMs;
    if (e.timer) { clearTimeout(e.timer); e.timer = null; }

    if (e.simple) {
      this._scheduleSimple(e);
      // console.log(`[DBGTS ${__mpTs()}][POLL][manual-resume][SIMPLE] cmd=${e.cmd} devId=${devId} immediate=${immediate} intervalMs=${e.intervalMs}`);
    } else {
      this._schedule(e);
      console.log(`[DBGTS ${__mpTs()}][POLL][manual-resume] cmd=${e.cmd} devId=${devId} immediate=${immediate}`);
    }
    this._emit('resume', { cmd: e.cmd, devId: e.devId });
  }

  forceOnce(cmd, devId) {
    const e = this._getEntry(cmd, devId);
    if (!e) {
      console.warn('[ModePoller] forceOnce no entry', { cmd, devId });
      return;
    }
    if (e.suspended) {
      console.log(`[DBGTS ${__mpTs()}][POLL][forceOnce-skip] suspended cmd=${e.cmd} devId=${e.devId}`);
      return;
    }
    console.log(`[DBGTS ${__mpTs()}][POLL][forceOnce${e.simple ? '-SIMPLE' : ''}] cmd=${e.cmd} devId=${e.devId}`);
    if (e.simple) {
      e.failCount++;
      const reached = e.failCount >= FAIL_THRESHOLD;
      this._simpleSend(e, true, 'forceOnce');
      if (reached) this.suspend(e.cmd, e.devId, 'fail-threshold');
    } else {
      this._sendNow(e, true, 'forceOnce');
    }
  }

  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = new Set();
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  _emit(event, payload) {
    const set = this.listeners[event];
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (err) { console.warn('[ModePoller] listener error', err); }
    }
  }

  _createEntry({ cmd, devId, intervalMs, data, simple }) {
    return {
      cmd,
      devId,
      data,
      // 动态间隔字段
      baseActiveIntervalMs: intervalMs,
      activeIntervalMs: intervalMs,
      idleIntervalMs: 2000,   // 空列表 -> 2s
      hasData: false,
      intervalMs,             // 当前生效间隔（start 时按 hasData 决定）
      timer: null,
      refCount: 0,
      failCount: 0,
      suspended: false,
      offline: false,
      lastSendAt: null,
      lastRespAt: null,
      lastResumeAt: null,
      nextDue: null,
      // 旧逻辑字段
      lastReqRid: null,
      lastRespRid: null,
      lastTickAt: null,
      current: null,
      simple: !!simple
    };
  }

  _start(e) {
    if (!Number.isFinite(e.devId)) return;
    if (e.suspended) return;
    e.intervalMs = e.hasData ? e.activeIntervalMs : e.idleIntervalMs;
    e.nextDue = performance.now();
    if (e.simple) {
      this._scheduleSimple(e);
      // console.log(`[DBGTS ${__mpTs()}][POLL][start][SIMPLE] cmd=${e.cmd} devId=${e.devId} interval=${e.intervalMs}`);
    } else {
      this._schedule(e);
      console.log(`[DBGTS ${__mpTs()}][POLL][start] cmd=${e.cmd} devId=${e.devId} interval=${e.intervalMs}`);
    }
  }

  /* ====================== SIMPLE ====================== */
  _scheduleSimple(e) {
    if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    if (e.suspended) return;
    const now = performance.now();
    if (e.nextDue == null) e.nextDue = now;
    let delay;
    if (document.hidden) {
      delay = e.intervalMs; // 后台允许浏览器节流
    } else {
      delay = e.nextDue - now;
      if (delay < 0) delay = 0;
    }
    e.timer = setTimeout(() => this._simpleTick(e), delay);
  }

  _simpleTick(e) {
    if (e.suspended) return;
    const now = performance.now();
    if (e.nextDue == null) e.nextDue = now;

    e.failCount++;
    const reached = e.failCount >= FAIL_THRESHOLD;
    // console.log(`[DBGTS ${__mpTs()}][POLL][tick][SIMPLE] cmd=${e.cmd} devId=${e.devId} failCount=${e.failCount}/${FAIL_THRESHOLD} intervalMs=${e.intervalMs}`);

    this._simpleSend(e, false, document.hidden ? 'tick-hidden' : 'tick');

    if (reached) {
      this.suspend(e.cmd, e.devId, 'fail-threshold');
      return;
    }

    e.nextDue = now + e.intervalMs;
    this._scheduleSimple(e);
  }

  _simpleSend(e, force, reason) {
    if (e.suspended) return;
    try {
      const rid = wsHub.fireAndForget({ cmd: e.cmd, to: { type: 1, id: e.devId }, data: e.data });
      const now = performance.now();
      const delta = e.lastSendAt == null ? 0 : (now - e.lastSendAt).toFixed(1);
      e.lastSendAt = now;
      this.ridMap.set(rid, e);
      // 避免 ridMap 无限增长
      if (this.ridMap.size > 5000) {
        const it = this.ridMap.keys().next();
        if (!it.done) this.ridMap.delete(it.value);
      }
      // console.log(`[DBGTS ${__mpTs()}][POLL][send][SIMPLE] cmd=${e.cmd} devId=${e.devId} rid=${rid} reason=${reason} force=${!!force} sinceLastSendMs=${delta} failCount=${e.failCount}/${FAIL_THRESHOLD} intervalMs=${e.intervalMs}`);
      this._emit('send', { cmd: e.cmd, devId: e.devId, rid, force: !!force, simple: true });
    } catch (err) {
      console.warn('[ModePoller][SIMPLE] send fail', e.cmd, e.devId, err);
    }
  }

  /* ====================== 旧逻辑（非 SIMPLE 命令） ====================== */
  _schedule(e) {
    if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    if (e.suspended) return;
    const now = performance.now();
    if (e.nextDue == null) e.nextDue = now;
    let delay = e.nextDue - now;
    if (delay < 0) delay = 0;
    e.timer = setTimeout(() => this._runTick(e, false), delay);
  }

  _runTick(e, fromResume) {
    if (e.suspended) return;
    const now = performance.now();
    const planned = e.nextDue != null ? e.nextDue : now;
    const drift = now - planned;
    this._tickCore(e, drift, fromResume);
    if (e.suspended) return;
    e.nextDue = planned + e.intervalMs;
    if (e.nextDue < performance.now() - 50) {
      e.nextDue = performance.now() + e.intervalMs;
    }
    this._schedule(e);
  }

  _tickCore(e, driftMs, fromResume) {
    if (!Number.isFinite(e.devId)) return;
    const now = performance.now();
    const deltaTick = e.lastTickAt == null ? 0 : (now - e.lastTickAt).toFixed(1);
    e.lastTickAt = now;

    const timeoutMs = e.intervalMs * GRACE_FACTOR;
    const throttled = driftMs > e.intervalMs * THROTTLE_DRIFT_FACTOR;

    if (e.current && !e.current.timedOut) {
      const inflightMs = now - e.current.startAt;
      let effectiveTimeout = timeoutMs;
      if (throttled) {
        effectiveTimeout = timeoutMs * THROTTLE_DEFER_MULT;
      }

      if (inflightMs > effectiveTimeout) {
        e.current.timedOut = true;
        e.failCount++;
        const suspendNow = e.failCount >= FAIL_THRESHOLD;
        console.warn(`[DBGTS ${__mpTs()}][POLL][timeout${suspendNow ? '-suspend' : ''}] cmd=${e.cmd} devId=${e.devId} rid=${e.current.rid} inflightMs=${inflightMs.toFixed(1)} timeoutMs=${effectiveTimeout.toFixed(1)} failCount=${e.failCount}/${FAIL_THRESHOLD} throttled=${throttled}`);
        if (suspendNow) {
          this.suspend(e.cmd, e.devId, 'fail-threshold');
          return;
        }
        this._sendNow(e, false, 'timeout-retry');
        return;
      } else {
        console.log(`[DBGTS ${__mpTs()}][POLL][inflight] cmd=${e.cmd} devId=${e.devId} rid=${e.current.rid} inflightMs=${inflightMs.toFixed(1)} timeoutMs=${timeoutMs.toFixed(1)} throttled=${throttled}`);
        if (SINGLE_INFLIGHT) return;
      }
    } else if (e.current && e.current.timedOut) {
      if (SINGLE_INFLIGHT) return;
    }

    if (!e.current) {
      console.log(`[DBGTS ${__mpTs()}][POLL][tick] cmd=${e.cmd} devId=${e.devId} tickDeltaMs=${deltaTick} driftMs=${driftMs.toFixed(1)} failCount=${e.failCount} fromResume=${!!fromResume}`);
      this._sendNow(e, false, 'tick');
    }
  }

  _sendNow(e, isForce, reason = 'tick') {
    if (e.suspended) return;
    if (!Number.isFinite(e.devId)) return;
    try {
      const rid = wsHub.fireAndForget({ cmd: e.cmd, to: { type: 1, id: e.devId }, data: e.data });
      const now = performance.now();
      const deltaSinceLastSend = e.lastSendAt == null ? 0 : (now - e.lastSendAt).toFixed(1);
      e.lastSendAt = now;
      e.lastReqRid = rid;
      e.current = { rid, startAt: now, timedOut: false };
      this.ridMap.set(rid, e);
      if (this.ridMap.size > 5000) {
        const it = this.ridMap.keys().next();
        if (!it.done) this.ridMap.delete(it.value);
      }
      console.log(`[DBGTS ${__mpTs()}][POLL][send] cmd=${e.cmd} devId=${e.devId} rid=${rid} force=${!!isForce} reason=${reason} sinceLastSendMs=${deltaSinceLastSend}`);
      this._emit('send', { cmd: e.cmd, devId: e.devId, rid, force: !!isForce });
    } catch (err) {
      console.warn('[ModePoller] send fail', e.cmd, e.devId, err);
    }
  }

  _unsubscribe(k) {
    const e = this.map.get(k);
    if (!e) return;
    e.refCount = Math.max(0, e.refCount - 1);
    console.log(`[DBGTS ${__mpTs()}][POLL][unsubscribe] key=${k} refCount(after)=${e.refCount}`);
    if (e.refCount === 0) {
      if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      this.map.delete(k);
      console.log(`[DBGTS ${__mpTs()}][POLL][stop] ${k}`);
    }
  }

  disposeAll() {
    console.log(`[DBGTS ${__mpTs()}][POLL][disposeAll] size=${this.map.size}`);
    this.map.forEach(e => { if (e.timer) clearTimeout(e.timer); });
    this.map.clear();
    this.ridMap.clear();
    try { this._unsubRaw && this._unsubRaw(); } catch { }
  }
}

let modePollerInstance = _scope.instance;
if (!modePollerInstance) {
  modePollerInstance = new ModePoller();
  try { _scope.instance = modePollerInstance; } catch { }
}
export const modePoller = modePollerInstance;
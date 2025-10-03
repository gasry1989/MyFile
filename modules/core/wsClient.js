/**
 * 单 WebSocket 客户端封装（全局单例）
 * 保留原有逻辑 + 离线(2004) / 任意响应统一清理 pending，避免重复 TIMEOUT。
 * sendRequest / onMessage / _resolveOrRejectPending 为最新修改版本。
 */
import { ENV } from '@config/env.js';
import { authGetToken } from '@core/auth.js';
import { eventBus } from '@core/eventBus.js';
import { WS_LOG_ALL } from '/config/constants.js';

const DEBUG = WS_LOG_ALL || (ENV && ENV.WS_DEBUG === true) || (typeof window !== 'undefined' && window.__WS_DEBUG__ === true);
function WS_VERBOSE(){ try { return !!window.__WS_FORCE_VERBOSE__; } catch { return false; } }

class WSClient {
  constructor() {
    this.ws = null;
    this.status = 'disconnected';
    this.queue = [];
    this.retryTimer = null;
    this.retryInterval = 4000;
    this.handlers = new Map();
    this.manualClosed = false;
    this.pending = new Map();            // rid -> { resolve,reject,timer,cmd,toId }
    this.requestTimeoutMs = 10000;
    this.rawListeners = new Set();

    // requestId 生成器相关
    this._ridEpoch = Date.UTC(2025, 0, 1);
    this._ridLastMs = 0;
    this._ridSeq = 0;
    this._ridSeqMax = 63;
    this._instanceId = Math.floor(Math.random() * 256);
  }

  connect() {
    if (this.manualClosed) return;
    if (this.status === 'connecting' || this.status === 'connected') return;

    const token = authGetToken();
    if (!token) return;

    try {
      this.status = 'connecting';
      eventBus.emit('ws:statusChange', this.status);

      // 强制 wss
      let base = ENV.WS_URL || '';
      if (base.startsWith('ws://')) base = 'wss://' + base.slice(5);
      const url = `${base}?token=${encodeURIComponent(token)}`;

      this.ws = new WebSocket(url);
      this.ws.onopen = () => this.onOpen();
      this.ws.onclose = (ev) => this.onClose(ev);
      this.ws.onerror = (err) => this.onError(err);
      this.ws.onmessage = (ev) => this.onMessage(ev);
    } catch (e) {
      console.error('[WS] connect exception', e);
      this.scheduleReconnect();
    }
  }

  onOpen() {
    this.status = 'connected';
    eventBus.emit('ws:statusChange', this.status);
    while (this.queue.length > 0 && this.status === 'connected') {
      const msg = this.queue.shift();
      this._sendRaw(msg);
    }
    this._awaitFirstMessage = true;
  }

  onClose() {
    this.status = 'disconnected';
    eventBus.emit('ws:statusChange', this.status);
    for (const [rid, p] of this.pending.entries()) {
      try { p.reject(new Error('WS closed')); } catch {}
      clearTimeout(p.timer);
    }
    this.pending.clear();
    if (!this.manualClosed) this.scheduleReconnect();
  }

  onError() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.close(); } catch {}
    }
  }

  /**
   * 发送请求（需响应），记录 pending，附带 toId，用于 2004 离线时批量清理
   */
  sendRequest({ cmd, to, data, requestId }) {
    let rid = requestId != null ? requestId : this._nextRequestId();
    while (this.pending.has(rid)) {
      this._ridSeq += 1;
      if (this._ridSeq > this._ridSeqMax) {
        this._ridLastMs += 1;
        this._ridSeq = 0;
      }
      rid = this._nextRequestId();
    }
    const payload = { requestId: rid, cmd, to, data };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // 若已被提前清理则忽略
        if (!this.pending.has(rid)) return;
        this.pending.delete(rid);
        const err = new Error('WS request timeout');
        err.requestId = rid;
        err.cmd = cmd;
        if (!window.__WS_PRINT_RECV_SET__) window.__WS_PRINT_RECV_SET__ = new Set();
        const recvKey = 'RTO:' + rid;
        if (!window.__WS_PRINT_RECV_SET__.has(recvKey)) {
          window.__WS_PRINT_RECV_SET__.add(recvKey);
          console.warn('[WS][TIMEOUT]', { cmd, rid });
        }
        reject(err);
      }, this.requestTimeoutMs);
      const toId = to && to.id != null ? Number(to.id) : null;
      this.pending.set(rid, { resolve, reject, timer, cmd, toId });
      this.send(payload);
    });
  }

  /**
   * 无需响应（不创建 pending）
   */
  sendWithRid({ cmd, to, data, requestId }) {
    const rid = requestId != null ? requestId : this.genRequestId();
    this.send({ cmd, to, data, requestId: rid });
    return rid;
  }

  send(msg) {
    if (this.status !== 'connected') {
      this.queue.push(msg);
      this.ensureConnected();
      return;
    }
    this._sendRaw(msg);
  }

  _sendRaw(msg) {
    try {
      if (!window.__WS_PRINT_SENT_SET__) window.__WS_PRINT_SENT_SET__ = new Set();
      const ridKey = 'S:' + (msg?.requestId != null ? msg.requestId : ('nocb:' + (msg?.cmd||'') + ':' + Date.now()));
      if (!window.__WS_PRINT_SENT_SET__.has(ridKey)) {
        window.__WS_PRINT_SENT_SET__.add(ridKey);
        try {
          console.log('[WS][SEND:ONCE]', {
            time: new Date().toISOString(),
            cmd: msg?.cmd || '',
            rid: msg?.requestId,
            to: msg?.to,
            data: msg?.data
          });
        } catch {}
      }
      if (DEBUG || WS_VERBOSE()) {
        try {
          console.log(`[WS][SEND] ${new Date().toISOString()} cmd=${msg?.cmd || ''} rid=${msg?.requestId ?? ''}`, JSON.parse(JSON.stringify(msg)));
        } catch {
          console.log('[WS][SEND][raw]', msg);
        }
      }
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      console.error('[WS] send failed', e);
      this.queue.unshift(msg);
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.status = 'disconnected';
        this.scheduleReconnect();
      }
    }
  }

  // 替换函数：onMessage —— 仅修改“[WS][RECV:ONCE]” 去重打印对象，补充 data 字段（深拷贝安全版）；其它逻辑保持不变
  onMessage(ev) {
    let data = null;
    try { data = JSON.parse(ev.data); } catch {
      if (DEBUG || WS_VERBOSE()) console.warn('[WS][RECV] invalid JSON', ev.data);
      return;
    }

    // 去重打印（成功/失败）—— 增加 data 字段
    try {
      if (!window.__WS_PRINT_RECV_SET__) window.__WS_PRINT_RECV_SET__ = new Set();
      const recvKey = 'R:' + (data?.requestId != null
        ? data.requestId
        : (data?.cmd||'') + ':' + (data?.to?.id || data?.from?.id || ''));
      if (!window.__WS_PRINT_RECV_SET__.has(recvKey)) {
        window.__WS_PRINT_RECV_SET__.add(recvKey);
        let safeData = undefined;
        try {
          // 深拷贝（剥离可能的循环引用、函数）
          safeData = JSON.parse(JSON.stringify(data));
        } catch {
          // 退回浅拷贝（少量关键字段）
          safeData = {
            cmd: data?.cmd,
              requestId: data?.requestId,
            code: data?.code,
            to: data?.to,
            from: data?.from
          };
        }
        // console.log('[WS][RECV:ONCE]', {
        //   time: new Date().toISOString(),
        //   cmd: data?.cmd,
        //   rid: data?.requestId,
        //   code: data?.code,
        //   to: data?.to,
        //   from: data?.from,
        //   data: safeData      // 新增：完整（或降级）报文
        // });
        console.log('[WS][RECV:ONCE]', data);
      }
    } catch {}

    if (DEBUG || WS_VERBOSE()) {
      try {
        if (data && data.requestId != null) {
          console.log(
            `[WS][RECV] ${new Date().toISOString()} cmd=${data.cmd || ''} rid=${data.requestId} code=${data.code!=null?data.code:''}`,
            JSON.parse(JSON.stringify(data))
          );
        } else {
          console.log(
            `[WS][RECV] ${new Date().toISOString()} cmd=${data?.cmd ?? ''}`,
            JSON.parse(JSON.stringify(data))
          );
        }
      } catch {
        console.log('[WS][RECV][raw]', data);
      }
    }

    // 首条握手逻辑
    if (this._awaitFirstMessage) {
      if (data && Number(data.code) === 1001) {
        this._awaitFirstMessage = false;
        eventBus.emit('toast:show', { type: 'error', message: '实时连接失败，token失效' });
        (async () => {
          try {
            const mod = await import('@core/auth.js');
            if (mod && typeof mod.authReLogin === 'function') {
              await mod.authReLogin();
              try { this.closeManual(); } catch {}
              this.manualClosed = false;
              this.connect();
            } else throw new Error('authReLogin missing');
          } catch {
            eventBus.emit('toast:show', { type: 'error', message: '自动重新登录失败' });
          }
        })();
        return;
      }
      if (data && (data.code === 0 || data.code === '0')) {
        this._awaitFirstMessage = false;
        if (location.hash !== '#/login' && !location.hash.startsWith('#/login?')) {
          eventBus.emit('toast:show', { type: 'info', message: '实时连接已恢复' });
        }
      }
    }

    // 优先匹配 requestId（成功或失败都清理超时定时器）
    if (data && data.requestId != null) {
      this._resolveOrRejectPending(data.requestId, data);
    }

    // 离线 2004：清理同设备 pending
    if (data && Number(data.code) === 2004) {
      const devId = (data.to && data.to.id != null) ? Number(data.to.id)
                : (data.from && data.from.id != null) ? Number(data.from.id)
                : null;
      if (devId != null) {
        for (const [rid, p] of Array.from(this.pending.entries())) {
          if (p && p.toId === devId) {
            this.pending.delete(rid);
            clearTimeout(p.timer);
            try {
              const err = { code: 2004, message: 'device offline', requestId: rid };
              p.reject(err);
            } catch {}
          }
        }
      }
    }

    if (DEBUG) {
      if (data && data.requestId != null) {
        console.log(`[WS][response][${data.cmd}] rid=${data.requestId}`, data);
      } else {
        console.log(`[WS][message][${data?.cmd ?? ''}]`, data);
      }
    }

    // 通知 raw 监听器
    for (const fn of this.rawListeners) {
      try { fn(data); } catch (e) { console.error('[WS] raw listener error', e); }
    }

    // 普通 cmd 广播
    if (data && data.cmd) {
      const set = this.handlers.get(data.cmd);
      if (set) {
        for (const fn of set) {
          try { fn(data); } catch (e) { console.error('[WS] handler error', e); }
        }
      }
    }
  }

  /**
   * 统一完成 pending 响应处理
   */
  _resolveOrRejectPending(rid, data) {
    const req = this.pending.get(rid);
    if (!req) return false;
    this.pending.delete(rid);
    clearTimeout(req.timer);
    if (data && (data.code == null || data.code === 0)) {
      try { req.resolve(data); } catch {}
    } else {
      try { req.reject(data); } catch {}
    }
    return true;
  }

  scheduleReconnect() {
    if (this.manualClosed) return;
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryInterval);
  }

  ensureConnected() {
    if (this.manualClosed) this.manualClosed = false;
    if (this.status === 'disconnected') {
      this.connect();
      return;
    }
    if (!this.ws && this.status !== 'connecting') this.connect();
  }

  genRequestId() { return this._nextRequestId(); }

  _nextRequestId() {
    const now = Date.now();
    const ms = Math.max(now, this._ridLastMs);
    if (ms === this._ridLastMs) {
      this._ridSeq += 1;
      if (this._ridSeq > this._ridSeqMax) {
        this._ridLastMs = ms + 1;
        this._ridSeq = 0;
      }
    } else {
      this._ridLastMs = ms;
      this._ridSeq = 0;
    }
    const diff = Math.max(0, this._ridLastMs - this._ridEpoch);
    const rid = diff * 16384 + this._ridSeq * 256 + this._instanceId;
    return Math.floor(rid);
  }

  onCmd(cmd, fn) {
    if (!this.handlers.has(cmd)) this.handlers.set(cmd, new Set());
    this.handlers.get(cmd).add(fn);
    return () => { this.handlers.get(cmd)?.delete(fn); };
  }

  onRaw(fn) {
    this.rawListeners.add(fn);
    return () => this.rawListeners.delete(fn);
  }

  removeCmdHandlers(cmd) {
    this.handlers.delete(cmd);
  }

  closeManual() {
    this.manualClosed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.status = 'disconnected';
    eventBus.emit('ws:statusChange', this.status);
  }
}

export const wsClient = new WSClient();
export function ensureWS() { wsClient.ensureConnected(); }
export function wsSend(payload) { wsClient.send(payload); }
export function wsSendWithRid(payload) { return wsClient.sendWithRid(payload); }
export function wsGenRequestId() { return wsClient.genRequestId(); }
export function wsSetDebug(on) { try { window.__WS_DEBUG__ = !!on; } catch {} console.log('[WS] runtime debug =', !!on); }
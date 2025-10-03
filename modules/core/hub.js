/**
 * 全局 WS Hub（集中接入，统一分发）
 * - 依赖 wsClient
 * - 新增 fireAndForget：只发不等回，返回 rid
 */
import { wsClient } from '@core/wsClient.js';
import { eventBus } from '@core/eventBus.js';
import { authLogout } from '@core/auth.js';
import { WS_LOG_ALL } from '/config/constants.js';

const cmdHandlers = new Map();
const rawHandlers = new Set();
const matchHandlers = new Set();
const topicHandlers = new Map();
let unbindRaw = null;

/** 简单浅匹配：pattern 仅对第一层字段和常见路径做判断 */
function shallowMatch(msg, pattern) {
  if (!pattern || typeof pattern !== 'object') return true;
  for (const k of Object.keys(pattern)) {
    const expect = pattern[k];
    if (k === 'to.id') { if (!msg?.to || String(msg.to.id) !== String(expect)) return false; continue; }
    if (k === 'to.type') { if (!msg?.to || String(msg.to.type) !== String(expect)) return false; continue; }
    if (k === 'devId') { if (String(msg?.devId) !== String(expect)) return false; continue; }
    if (k === 'modeId') { if (String(msg?.modeId) !== String(expect)) return false; continue; }
    if (msg?.[k] !== expect) return false;
  }
  return true;
}

function dispatch(msg) {
  if (WS_LOG_ALL || (typeof window !== 'undefined' && window.__WS_DEBUG__ === true)) {
    // try { console.log('[WS][dispatch-raw]', msg); } catch {}
  }
  if (msg && msg.cmd === 'error' && Number(msg.code) === 1004) {
    try { window.__FORCE_LOGOUT_CONFLICT = 1; } catch {}
    try { authLogout(); } catch {}
    return;
  }
  for (const fn of rawHandlers) { try { fn(msg); } catch (e) { console.error('[wsHub] raw handler error', e); } }
  if (msg && msg.cmd && cmdHandlers.has(msg.cmd)) {
    for (const fn of cmdHandlers.get(msg.cmd)) {
      try { fn(msg); } catch (e) { console.error('[wsHub] cmd handler error', e); }
    }
  }
  for (const h of matchHandlers) {
    try {
      const ok = typeof h.filter === 'function' ? h.filter(msg) : shallowMatch(msg, h.filter);
      if (ok) h.fn(msg);
    } catch (e) { console.error('[wsHub] match handler error', e); }
  }
  eventBus.emit('ws:message', msg);
}

export const wsHub = {
  onRaw(fn) {
    rawHandlers.add(fn);
    return () => rawHandlers.delete(fn);
  },
  onCmd(cmd, fn) {
    if (!cmdHandlers.has(cmd)) cmdHandlers.set(cmd, new Set());
    cmdHandlers.get(cmd).add(fn);
    return () => cmdHandlers.get(cmd)?.delete(fn);
  },
  onMatch(filterOrFn, fn) {
    const item = typeof filterOrFn === 'function' ? { filter: filterOrFn, fn } : { filter: filterOrFn || {}, fn };
    matchHandlers.add(item);
    return () => matchHandlers.delete(item);
  },

  // —— 发送 —— //
  send(payload) {
    wsClient.send(payload);
  },
  request({ cmd, to, data, requestId }) {
    return wsClient.sendRequest({ cmd, to, data, requestId });
  },
  // fire-and-forget：只发不等回，返回 rid（唯一）
  fireAndForget({ cmd, to, data, requestId }) {
    return wsClient.sendWithRid({ cmd, to, data, requestId });
  },

  // —— 纯前端主题 —— //
  publish(topic, data) {
    if (!topicHandlers.has(topic)) return;
    for (const fn of topicHandlers.get(topic)) {
      try { fn(data); } catch (e) { console.error('[wsHub] topic handler error', e); }
    }
  },
  onTopic(topic, fn) {
    if (!topicHandlers.has(topic)) topicHandlers.set(topic, new Set());
    topicHandlers.get(topic).add(fn);
    return () => topicHandlers.get(topic)?.delete(fn);
  }
};

export function startWSHub() {
  if (!unbindRaw) {
    unbindRaw = wsClient.onRaw(dispatch);
  }
  eventBus.on('ws:statusChange', (s) => {
    eventBus.emit('ws:status', s);
    wsHub.publish('status', s);
  });
  try { window.__wsHub = wsHub; } catch {}
}
/**
 * 顶部居中全局 Toast
 * 用法：
 *  1) 事件方式：eventBus.emit('toast:show', { type:'success', message:'OK' })
 *  2) 直接函数：import { showToast } from '@ui/toast.js'; showToast({ message:'Hi' })
 *
 * 特性：
 *  - 单例：不会重复注册事件
 *  - 去重：同 (type+message) 800ms 内只显示一次 (可通过传 dedup:false 关闭)
 *  - Hover 暂停自动关闭
 */

import { eventBus } from '@core/eventBus.js';

const DEDUP_WINDOW = 800;          // 去重时间窗口
let container = null;
let seed = 0;
const active = new Map();          // id -> { el, timer }
const recent = [];                 // { h, t }

function ensureContainer() {
  // 创建容器
  if (!container) {
    container = document.createElement('div');
    container.id = 'globalToastContainer';
    document.body.appendChild(container);
  }
  // 关键：保证 toast 永远浮在 overlay 之上（overlay 使用 ~2147483645）
  try {
    const current = Number(getComputedStyle(container).zIndex) || 0;
    if (current < 2147483646) {
      container.style.zIndex = '2147483647';
    }
  } catch {}
}

function pruneRecent() {
  const now = Date.now();
  for (let i = recent.length - 1; i >= 0; i--) {
    if (now - recent[i].t > DEDUP_WINDOW) recent.splice(i, 1);
  }
}

function needSkip(type, message) {
  pruneRecent();
  const h = type + '::' + message;
  if (recent.find(r => r.h === h)) return true;
  recent.push({ h, t: Date.now() });
  return false;
}

/**
 * 显示一个 toast
 * @param {Object} opts
 *  - type: success | error | info | warn
 *  - message: string
 *  - duration: ms (0 = 不自动关闭)
 *  - dedup: 是否启用去重 (默认 true)
 * @returns id
 */
export function showToast(opts = {}) {
  ensureContainer();
  const {
    type = 'info',
    message = '',
    duration = 3000,
    dedup = true
  } = opts;

  if (dedup && needSkip(type, message)) return null;

  const id = ++seed;
  const el = document.createElement('div');
  el.className = `toast-item toast-${type}`;
  el.innerHTML = `
    <div class="toast-inner">
      <span class="toast-msg">${escapeHTML(message)}</span>
      <button class="toast-close" title="关闭">×</button>
    </div>
  `;

  // 新的永远插在最上
  if (container.firstChild) container.insertBefore(el, container.firstChild);
  else container.appendChild(el);

  const remove = () => {
    if (!active.has(id)) return;
    el.classList.add('leaving');
    setTimeout(() => {
      active.delete(id);
      el.remove();
    }, 150);
  };

  el.querySelector('.toast-close').addEventListener('click', remove);

  const rec = { el, timer: null };
  if (duration > 0) {
    rec.timer = setTimeout(remove, duration);
  }
  active.set(id, rec);

  // Hover 暂停
  el.addEventListener('mouseenter', () => {
    const r = active.get(id);
    if (r?.timer) { clearTimeout(r.timer); r.timer = null; }
  });
  el.addEventListener('mouseleave', () => {
    const r = active.get(id);
    if (r && !r.timer && duration > 0) {
      r.timer = setTimeout(remove, 1200);
    }
  });

  return id;
}

/**
 * 清除某条或全部
 * @param {number} id
 */
export function clearToast(id) {
  if (id == null) {
    active.forEach(r => {
      r.el.classList.add('leaving');
      setTimeout(() => r.el.remove(), 130);
    });
    active.clear();
    return;
  }
  const rec = active.get(id);
  if (!rec) return;
  rec.el.classList.add('leaving');
  setTimeout(() => rec.el.remove(), 130);
  active.delete(id);
}

/* 事件方式：只注册一次 */
if (!window.__TOAST_EVENT_BOUND__) {
  eventBus.on('toast:show', showToast);
  eventBus.on('toast:clear', clearToast);
  window.__TOAST_EVENT_BOUND__ = true;
}

/* 暴露到 window 便于调试 */
window.__toast = { show: showToast, clear: clearToast };

/* ---- 工具 ---- */
function escapeHTML(str='') {
  return str.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
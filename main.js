import '@config/env.js';
import { initApp } from '@features/bootstrap/init.js';
import { initRouter } from '@features/bootstrap/router.js';
import { renderHeaderUserMount } from '@core/renderHeaderMount.js';
import { eventBus } from '@core/eventBus.js';
import { authState } from '@core/auth.js';
import { showToast } from '@ui/toast.js';
import { initSidebarToggle } from '@layout/SidebarToggle.js';

// 全局 WS：单例客户端与集中分发 Hub
import { wsClient, ensureWS as ensureGlobalWS } from '@core/wsClient.js';
import { startWSHub } from '@core/hub.js';

window.__WS_DEBUG__ = true;

// 初始化基础（加载 token / 侧栏 / 预览容量）
initApp();

// 渲染头部（监听 authState）
renderHeaderUserMount();

// 初始化路由（含登录守卫）
initRouter();

initSidebarToggle(); // 全局初始化一次

// 启动 WS Hub（只需一次，集中接入/分发）
startWSHub();

// 全局 toast 事件
eventBus.on('toast:show', p => showToast(p));

// --- 全局 WS 生命周期（登录后即建立，全站共享；登录页/登出才关闭） --- 
let latestToken = null;

function isLoginRoute() {
  const h = location.hash || '#/login';
  return h === '#/login' || h.startsWith('#/login?');
}

// 根据 token + 路由 决定连接/断开
function reconcileWS() {
  if (isLoginRoute()) {
    // 登录页：强制断开并停止重连
    try { wsClient.closeManual(); } catch {}
    return;
  }
  // 离开登录页后，确保允许重连（与 wsClient.ensureConnected 的兜底相互独立，二者都在也不冲突）
  try { wsClient.manualClosed = false; } catch {}

  // 非登录页：如有 token 则确保连接（去重由 wsClient 内部处理）
  if (latestToken) {
    try { ensureGlobalWS(); } catch {}
  }
}

// 1) 监听登录状态变化
authState.subscribe(s => {
  latestToken = (s && s.token) ? s.token : null;

  // 已登录访问 login -> 跳回默认页（保持你原有逻辑）
  const hash = location.hash || '#/login';
  if (s.token && hash === '#/login') {
    location.hash = '#/site';
  }

  if (latestToken) {
    // 登录成功或刷新后仍已登录：确保连接
    ensureGlobalWS();
  } else {
    // 退出登录：关闭连接并停止重连
    try { wsClient.closeManual(); } catch {}
  }

  reconcileWS();
});

// 2) 路由变化时再校正一次（进入登录页需要断开）
window.addEventListener('hashchange', reconcileWS);

// 3) 页面从后台回前台时，如断开则唤醒重连（不改变 wsClient 的 4s 重连策略）
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && latestToken) {
    try { wsClient.ensureConnected(); } catch {}
  }
});

// 方便调试
console.log('[main] app started');
import { authState, authLogout } from '@core/auth.js';
import { eventBus } from '@core/eventBus.js';
import { wsClient } from '@core/wsClient.js'; // 新增：读取初始状态

let lastIsLoginRoute = null;
let cachedSidebarDisplay = null;
let unsubscribeAuth = null;

// 仅绑定一次的 WS 状态监听
let wsStatusBound = false;
let offWsStatus = null;

export function renderHeaderUserMount() {
  const headerRight = document.getElementById('headerRight');

  function isLoginRoute() {
    const h = location.hash || '#/login';
    return h === '#/login' || h.startsWith('#/login?');
  }

  function getSidebar() {
    // 兼容两种写法：#sidebar 或 #sideBar
    return document.getElementById('sidebar') || document.getElementById('sideBar');
  }

  function applyLayoutForRoute() {
    const isLogin = isLoginRoute();
    if (isLogin === lastIsLoginRoute) return;
    lastIsLoginRoute = isLogin;

    const sidebar = getSidebar();
    const appLayout = document.getElementById('appLayout');
    const mainView = document.getElementById('mainView');

    if (isLogin) {
      if (sidebar && cachedSidebarDisplay === null) {
        cachedSidebarDisplay = sidebar.style.display || '';
      }
      if (sidebar) {
        sidebar.style.display = 'none';
        // 去掉可能的边框
        sidebar.style.borderRight = 'none';
        sidebar.style.border = 'none';
      }
      if (mainView) {
        mainView.dataset._prevBorderLeft = mainView.style.borderLeft || '';
        mainView.dataset._prevBorder = mainView.style.border || '';
        mainView.style.borderLeft = 'none';
        mainView.style.border = 'none';
        mainView.style.marginLeft = '0';
      }
      appLayout && appLayout.classList.add('login-mode');
      if (headerRight) headerRight.innerHTML = ''; // 登录页不显示
    } else {
      // 还原
      if (sidebar && cachedSidebarDisplay !== null) {
        sidebar.style.display = cachedSidebarDisplay;
      }
      if (mainView) {
        if (mainView.dataset._prevBorderLeft !== undefined) {
          mainView.style.borderLeft = mainView.dataset._prevBorderLeft;
        }
        if (mainView.dataset._prevBorder !== undefined) {
          mainView.style.border = mainView.dataset._prevBorder;
        }
      }
      appLayout && appLayout.classList.remove('login-mode');
      // 方案A：离开登录页时移除首屏隐藏类，防止后续页面仍被强制隐藏
      document.documentElement.classList.remove('pre-login');
      renderUserArea(); // 非登录路由重新渲染 header 用户区
    }
  }

  function statusClass(s) {
    if (s === 'connected') return 'ok';
    if (s === 'connecting') return 'connecting';
    return 'down';
  }
  function statusText(s) {
    if (s === 'connected') return '已连接';
    if (s === 'connecting') return '连接中';
    return '未连接';
  }
  function updateWsBadge(s) {
    const el = document.getElementById('wsStatusBadge');
    if (!el) return;
    el.className = `ws-badge ${statusClass(s)}`;
    const txt = el.querySelector('.txt');
    if (txt) txt.textContent = statusText(s);
    el.title = `WebSocket：${statusText(s)}`;
  }

  function ensureWsStatusListener() {
    if (wsStatusBound) return;
    wsStatusBound = true;
    offWsStatus = eventBus.on('ws:statusChange', s => updateWsBadge(s));
    // 初始化一次
    try { updateWsBadge(wsClient.status || 'disconnected'); } catch {}
  }

  function renderUserArea() {
    if (!headerRight) return;
    if (isLoginRoute()) {
      headerRight.innerHTML = '';
      return;
    }
    const s = authState.get();

    // 连接状态徽标（总是显示在右侧）
    const current = (wsClient && wsClient.status) ? wsClient.status : 'disconnected';
    const wsBadgeHtml = `
      <span id="wsStatusBadge" class="ws-badge ${statusClass(current)}" title="WebSocket：${statusText(current)}">
        <span class="dot"></span><span class="txt">${statusText(current)}</span>
      </span>
    `;

    if (!s.token || !s.userInfo) {
      headerRight.innerHTML = `${wsBadgeHtml}<a href="#/login" class="btn btn-xs" id="btnLoginLink">登录</a>`;
      ensureWsStatusListener();
      return;
    }

    headerRight.innerHTML = `
      ${wsBadgeHtml}
      <span class="user-label">${escapeHTML(s.userInfo.userName||'用户')} (角色ID:${s.userInfo.roleId})</span>
      <button class="btn btn-xs" id="btnLogout">退出</button>
    `;
    headerRight.querySelector('#btnLogout')?.addEventListener('click', () => {
      authLogout();
      eventBus.emit('toast:show', { type:'info', message:'已退出登录' });
    });

    ensureWsStatusListener();
  }

  function fullRefresh() {
    applyLayoutForRoute();
    if (!isLoginRoute()) renderUserArea();
  }

  unsubscribeAuth = authState.subscribe(fullRefresh);
  window.addEventListener('hashchange', fullRefresh);
  fullRefresh();
}

function escapeHTML(str='') {
  return str.replace(/[&<>"']/g, c=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
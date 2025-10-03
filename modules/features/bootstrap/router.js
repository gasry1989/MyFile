import { authRequireGuard } from '@core/auth.js';
import { closeAllModals } from '@ui/modal.js';
import { mountUserListPage, unmountUserListPage } from '@features/pages/UserListPage.js';
import { mountSitePage, unmountSitePage } from '@features/pages/SitePage.js';
import { mountLoginPage, unmountLoginPage } from '@features/pages/LoginPage.js';
import { mountDataCenterPage, unmountDataCenterPage } from '@features/pages/DataCenterPage.js';
import { mountVideoCenterPage, unmountVideoCenterPage } from '@features/pages/VideoCenterPage.js';

let currentUnmount = null;

const routes = {
  '/login': { allowAnon: true, mount: mountLoginPage, unmount: unmountLoginPage },
  '/users': { allowAnon: false, mount: mountUserListPage, unmount: unmountUserListPage },
  '/site' : { allowAnon: false, mount: mountSitePage, unmount: unmountSitePage },
  '/datacenter': { allowAnon: false, mount: mountDataCenterPage, unmount: unmountDataCenterPage },
  '/videocenter': { allowAnon: false, mount: mountVideoCenterPage, unmount: unmountVideoCenterPage }
};

export function initRouter() {
  window.addEventListener('hashchange', navigate);
  if (!location.hash) location.hash = '#/site'; // 默认改为现场管理
  navigate();
}

function navigate() {
  const raw = location.hash.replace(/^#/, '') || '/site';
  const path = raw || '/site';
  const route = routes[path] || routes['/site'];

  // 守卫
  if (!route.allowAnon && !authRequireGuard()) {
    location.hash = '#/login';
    return;
  }
  if (route.allowAnon && authRequireGuard() && path === '/login') {
    location.hash = '#/site';  // 登录后直接跳现场管理
    return;
  }

  closeAllModals();
  currentUnmount && currentUnmount();
  currentUnmount = route.mount();
  highlightNav(path);
}

function highlightNav(path) {
  document.querySelectorAll('.nav-link').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === '#' + path);
  });
}
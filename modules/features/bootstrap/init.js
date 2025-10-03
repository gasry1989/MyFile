/**
 * 应用初始化
 * - 载入本地 token
 * - 侧栏折叠监听
 * - 计算预览窗口容量
 * - 可放全局事件监听
 */
import { authLoadToken } from '@core/auth.js';
import { computePreviewCapacity } from '@state/previewState.js';

export function initApp() {
  authLoadToken();
  bindSidebarCollapse();
  window.addEventListener('resize', computePreviewCapacity);
  computePreviewCapacity();
}

function bindSidebarCollapse() {
  const toggle = document.getElementById('sidebarToggle');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('collapsed');
    computePreviewCapacity();
  });
}
/**
 * 侧栏折叠控制（与 index.html 对齐）
 * - 侧栏：#sidebar
 * - 按钮：#sidebarToggle（div 也可）
 * - 展开显示 «（可折叠），折叠显示 »（可展开）
 * - 状态持久化 localStorage
 * - 额外：提供事件委托兜底，确保无论何时能点
 */
const KEY = 'ui.sidebar.collapsed';
let inited = false;

export function initSidebarToggle() {
  if (inited) return;
  inited = true;

  const side = document.getElementById('sidebar');
  const btn  = document.getElementById('sidebarToggle');

  // 主路径：精准绑定按钮
  if (side && btn) {
    let collapsed = readState();
    if (collapsed == null) collapsed = side.classList.contains('collapsed');
    apply(side, btn, collapsed);

    btn.addEventListener('click', () => {
      collapsed = !collapsed;
      apply(side, btn, collapsed);
      saveState(collapsed);
    }, true);

    // 键盘可用
    btn.setAttribute('tabindex', '0');
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); btn.click(); }
    });

    // 监听外部切 class，自动同步按钮文案与存储
    try {
      const mo = new MutationObserver(() => {
        const now = side.classList.contains('collapsed');
        if (now !== collapsed) {
          collapsed = now;
          renderIcon(btn, collapsed);
          saveState(collapsed);
        }
      });
      mo.observe(side, { attributes:true, attributeFilter:['class'] });
    } catch {}

    // 首帧统一一次图标
    renderIcon(btn, collapsed);
  }

  // 兜底路径：即使上面没有命中（例如 DOM 动态替换），也用事件委托保证可点击
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest && e.target.closest('#sidebarToggle');
    const s = document.getElementById('sidebar');
    if (!t || !s) return;
    const willCollapsed = !s.classList.contains('collapsed');
    s.classList.toggle('collapsed', willCollapsed);
    renderIcon(t, willCollapsed);
    saveState(willCollapsed);
  }, true);
}

function apply(side, btn, flag) {
  side.classList.toggle('collapsed', flag);
  renderIcon(btn, flag);
}

function renderIcon(btn, collapsed) {
  btn.textContent = collapsed ? '»' : '«';
  btn.title = collapsed ? '展开侧栏' : '折叠侧栏';
}

function readState() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === '1') return true;
    if (v === '0') return false;
    return null;
  } catch { return null; }
}
function saveState(v) {
  try { localStorage.setItem(KEY, v ? '1' : '0'); } catch {}
}
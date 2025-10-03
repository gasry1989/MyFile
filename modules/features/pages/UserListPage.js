/**
 * 用户管理页面（最终最小补丁：保证用户列表自身滚动，不依赖 mainView 全局滚动）
 *
 * 关键点：
 * 1. 产生滚动的前提：有一条高度约束链。之前失败的根因是：
 *    mainView 被其它页面写死 overflow:hidden + height:XXX；切回来时 users-page-root 的 height:100% 无法生效
 *    （因为中间的 #usersPageMount/auto 高度导致 100% 计算不到），table-wrapper 于是跟随内容高度 → 没有滚动。
 * 2. 方案：在 mountUserListPage 中（仅用户列表页生命周期内）建立高度链：
 *    mainView（已有固定 height 或我们临时算） -> #usersPageMount(height:100%) -> .users-page-root(flex column, flex:1, min-height:0)
 *    -> .table-wrapper(flex:1,min-height:0,overflow:auto)
 * 3. 不改模板文件，不依赖全局 CSS；全部用行内 style 覆盖；卸载时恢复 mainView 原 inline 样式。
 * 4. 不再做任何动态计算或 ResizeObserver；仅首帧和数据渲染后两次兜底 scheduleReflow。
 */

import { userState } from '@state/userState.js';
import { authState } from '@state/authState.js';
import { apiUserList, apiUserDelete, apiRoleList } from '@api/userApi.js';
import { buildPageWindow } from '@core/pagination.js';
import { eventBus } from '@core/eventBus.js';
import { hasModifyRolePermission } from '@utils/permissions.js';
import { initSidebarToggle } from '@layout/SidebarToggle.js';
import { importTemplate } from '@ui/templateLoader.js';

let rootEl = null;
let unsubscribe = null;
let __offUserReload = null;
let __restoreMainViewStyle = null;

export function mountUserListPage() {
  console.debug('[UserListPage] mount');
  const main = document.getElementById('mainView');
  if (!main) {
    console.error('[UserListPage] #mainView missing');
    return () => {};
  }

  // 记录进入时 mainView 的 inline 样式（只恢复我们改动的几个属性）
  const prev = {
    display: main.style.display,
    flexDirection: main.style.flexDirection,
    height: main.style.height
  };
  __restoreMainViewStyle = () => {
    main.style.display = prev.display;
    main.style.flexDirection = prev.flexDirection;
    // height 有可能是其它功能页写死的，不覆盖已存在的固定值；若我们新设且之前为空则清除
    if (!prev.height) main.style.removeProperty('height'); else main.style.height = prev.height;
  };

  // 仅当 main 没有 display:flex（或需要结构撑满）时设置；不强制覆盖其它页面可能需要的 block 行为
  if (!main.style.display) main.style.display = 'flex';
  if (!main.style.flexDirection) main.style.flexDirection = 'column';

  // 若没有 height（比如直接打开 /users），计算一次（其它功能页本就会写 height）
  if (!main.style.height) {
    const top = main.getBoundingClientRect().top;
    const h = window.innerHeight - top;
    if (h > 0) main.style.height = h + 'px';
  }

  main.innerHTML = '<div id="usersPageMount"></div>';
  const mountPoint = main.querySelector('#usersPageMount');

  // 关键：mountPoint 也要建立高度参照
  mountPoint.style.height = '100%';
  mountPoint.style.display = 'flex';
  mountPoint.style.flexDirection = 'column';
  mountPoint.style.minHeight = '0';
  mountPoint.style.flex = '1 1 auto';

  importTemplate('/modules/features/pages/users-page.html', 'tpl-users-page')
    .then(frag => {
      mountPoint.innerHTML = '';
      mountPoint.appendChild(frag);

      rootEl = mountPoint.querySelector('.users-page-root');
      applyInnerScrollLayout(rootEl);

      initSidebarToggle();
      bindGlobalActions();
      subscribeState();
      loadUserPage(1);

      // 数据刷新事件
      const handler = () => loadUserPage(1);
      if (eventBus.on) eventBus.on('user:list:reload', handler);
      __offUserReload = () => { if (eventBus.off) eventBus.off('user:list:reload', handler); };

      // 首帧再兜底一次（避免某些延迟样式覆盖）
      scheduleReflow();
    })
    .catch(err => console.error('[UserListPage] template load failed', err));

  return () => {
    unsubscribe && unsubscribe();
    __offUserReload && __offUserReload();
    __restoreMainViewStyle && __restoreMainViewStyle();
    rootEl = null;
  };
}

export function unmountUserListPage() {
  unsubscribe && unsubscribe();
  __offUserReload && __offUserReload();
  __restoreMainViewStyle && __restoreMainViewStyle();
  rootEl = null;
}

/* ---------------- 数据加载 ---------------- */
function loadUserPage(pageIndex) {
  const { listInfo } = userState.get();
  userState.set({ loading: true });
  apiUserList(pageIndex, listInfo.pageSize)
    .then(data => {
      const list = data.userList || data.users || [];
      const li = data.listInfo || {
        total: list.length,
        pageIndex,
        pageSize: listInfo.pageSize,
        pageTotal: Math.max(1, Math.ceil(list.length / listInfo.pageSize))
      };
      userState.set({ loading:false, list, listInfo: li });
      scheduleReflow(); // 数据加载后再兜底
    })
    .catch(err => {
      console.error('[UserListPage] loadUserPage error', err);
      userState.set({ loading: false });
    });
}

/* ---------------- 状态订阅与渲染 ---------------- */
function subscribeState() { unsubscribe = userState.subscribe(renderAll); }
function renderAll(s) {
  if (!rootEl) return;
  renderTable(s);
  renderPagination(s);
  scheduleReflow(); // 渲染结构变化时兜底
}

function renderTable(state) {
  const tbody = rootEl.querySelector('#userTableBody');
  const selection = state.selection;
  tbody.innerHTML = state.list.map(u => {
    const checked = selection.has(u.userId) ? 'checked' : '';
    return `
      <tr>
        <td><input type="checkbox" data-id="${u.userId}" ${checked}/></td>
        <td>${safe(u.userId)}</td>
        <td>${escapeHTML(u.userAccount || '')}</td>
        <td>${escapeHTML(u.roleName || '')}</td>
        <td>${escapeHTML(u.userName || '')}</td>
        <td>${u.onlineState
          ? '<span class="dot dot-green" title="在线"></span>'
          : '<span class="dot dot-gray" title="离线"></span>'}
        </td>
        <td>${escapeHTML(u.parentUserAccount || '')}</td>
        <td>${escapeHTML(u.parentUserName || '')}</td>
        <td>${escapeHTML(u.rootUserAccount || '')}</td>
        <td>${escapeHTML(u.rootUserName || '')}</td>
        <td>${escapeHTML([u.provinceName,u.cityName,u.zoneName].filter(Boolean).join(''))}</td>
        <td>${formatTime(u.createTime)}</td>
        <td>${escapeHTML(u.memo || '')}</td>
        <td>
          <button class="btn btn-xs" data-op="edit" data-id="${u.userId}">修改信息</button>
          <button class="btn btn-xs" data-op="pwd" data-id="${u.userId}">修改密码</button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('input[type=checkbox][data-id]').forEach(chk => {
    chk.addEventListener('change', () => {
      const id = Number(chk.getAttribute('data-id'));
      const sel = new Set(userState.get().selection);
      chk.checked ? sel.add(id) : sel.delete(id);
      userState.set({ selection: sel });
    });
  });
  tbody.addEventListener('click', onRowButtonClick, { once:true });
}

function onRowButtonClick(e) {
  const btn = e.target.closest('button[data-op]');
  if (!btn) {
    e.currentTarget.addEventListener('click', onRowButtonClick, { once:true });
    return;
  }
  const op = btn.getAttribute('data-op');
  const id = Number(btn.getAttribute('data-id'));
  const user = userState.get().list.find(u => u.userId === id);
  if (!user) return;
  if (op === 'edit') openEditUserModal(user);
  if (op === 'pwd') openPasswordModal(user);
  e.currentTarget.addEventListener('click', onRowButtonClick, { once:true });
}

function renderPagination(state) {
  const pager = rootEl.querySelector('#userPagination');
  const { pageIndex, pageTotal } = state.listInfo;
  const pages = buildPageWindow(pageIndex, pageTotal, 2);
  pager.innerHTML = `
    <button class="pg-btn" data-pg="prev" ${pageIndex===1?'disabled':''}>&lt;</button>
    ${pages.map(p => `<button class="pg-btn ${p===pageIndex?'active':''}" data-pg="${p}">${p}</button>`).join('')}
    <button class="pg-btn" data-pg="next" ${pageIndex===pageTotal?'disabled':''}>&gt;</button>
  `;
  pager.querySelectorAll('.pg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-pg');
      let target = pageIndex;
      if (val==='prev') target = pageIndex - 1;
      else if (val==='next') target = pageIndex + 1;
      else target = Number(val);
      if (target < 1 || target > pageTotal) return;
      loadUserPage(target);
    });
  });
}

/* ---------------- 操作区 ---------------- */
function bindGlobalActions() {
  const actionsEl = rootEl.querySelector('#userActions');
  const roleId = authState.get().userInfo?.roleId;
  const showRoleMatrixBtn = hasModifyRolePermission(roleId);

  actionsEl.innerHTML = `
    <button class="btn btn-primary" id="btnAddUser">添加</button>
    <button class="btn btn-danger" id="btnDeleteUser">删除</button>
    <button class="btn" id="btnDeviceOverview">设备概览</button>
    ${showRoleMatrixBtn ? '<button class="btn" id="btnRoleMatrix">用户角色权限管理</button>' : ''}
  `;

  actionsEl.addEventListener('click', e => {
    if (!(e.target instanceof HTMLElement)) return;
    switch (e.target.id) {
      case 'btnAddUser': openAddUserModal(); break;
      case 'btnDeleteUser': deleteSelectedUsers(); break;
      case 'btnDeviceOverview': openDeviceOverview(); break;
      case 'btnRoleMatrix': openRoleMatrixPanel(); break;
    }
  });

  rootEl.querySelector('#chkAll').addEventListener('change', e => {
    const checked = e.target.checked;
    const newSel = new Set();
    if (checked) userState.get().list.forEach(u => newSel.add(u.userId));
    userState.set({ selection: newSel });
  });
}

function deleteSelectedUsers() {
  const sel = Array.from(userState.get().selection);
  if (!sel.length) {
    eventBus.emit('toast:show', { type:'info', message:'请选择要删除的用户' });
    return;
  }
  if (!confirm(`确认删除选中 ${sel.length} 个用户？`)) return;
  apiUserDelete(sel).then(() => {
    eventBus.emit('toast:show', { type:'success', message:'删除成功' });
    userState.set({ selection: new Set() });
    loadUserPage(userState.get().listInfo.pageIndex);
  });
}

/* ---------------- 动态 import ---------------- */
function openAddUserModal() { import('./modals/AddUserModal.js').then(m => m.showAddUserModal()); }
function openEditUserModal(user) { import('./modals/EditUserModal.js').then(m => m.showEditUserModal(user)); }
function openPasswordModal(user) {
  import('./modals/PasswordModal.js').then(m => m.showPasswordModal(user))
    .catch(err => console.error('[UserListPage] open password modal failed', err));
}
function openDeviceOverview() {
  const sel = Array.from(userState.get().selection);
  import('./modals/DeviceOverviewModal.js').then(m => m.showDeviceOverviewModal({ userIds: sel.length?sel:[] }));
}
function openRoleMatrixPanel() {
  apiRoleList().then(data => {
    import('./modals/RoleMatrixPanel.js').then(m => m.showRoleMatrixPanel(data.roles || []));
  });
}

/* ---------------- 内部滚动布局补丁 ---------------- */
function applyInnerScrollLayout(root) {
  if (!root) return;
  // root
  root.style.display = 'flex';
  root.style.flex = '1 1 auto';
  root.style.flexDirection = 'column';
  root.style.minHeight = '0';
  root.style.height = '100%'; // 在父高度链成立时才生效
  // table-wrapper
  const tw = root.querySelector('.table-wrapper');
  if (tw) {
    tw.style.flex = '1 1 auto';
    tw.style.minHeight = '0';
    tw.style.overflow = 'auto';
  }
}

/* ---------------- 兜底 reflow ---------------- */
let reflowTimer = null;
function scheduleReflow() {
  if (!rootEl) return;
  if (reflowTimer) clearTimeout(reflowTimer);
  reflowTimer = setTimeout(() => {
    try {
      const mountPoint = document.getElementById('usersPageMount');
      if (mountPoint) {
        // 如果高度链仍未建立，强制一遍
        if (getComputedStyle(mountPoint).display !== 'flex') {
          mountPoint.style.display = 'flex';
          mountPoint.style.flexDirection = 'column';
          mountPoint.style.height = '100%';
          mountPoint.style.minHeight = '0';
          mountPoint.style.flex = '1 1 auto';
          applyInnerScrollLayout(rootEl);
        }
      }
    } catch {}
  }, 32);
}

/* ---------------- 工具 ---------------- */
function escapeHTML(str='') { return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function safe(v){ return v==null?'' : v; }
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => n<10?'0'+n:n;
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
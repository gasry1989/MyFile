/**
 * 设备概览 - 修复滚动条与无谓空白
 * - Modal 固定自适应高度（height: ~78vh），内部 dev-table-area 承担滚动
 * - 滚动条风格与树状栏一致（见模板 CSS）
 */
import { createModal, getModal } from '@ui/modal.js';
import { apiDeviceList } from '@api/deviceApi.js';
import { buildPageWindow } from '@core/pagination.js';
import { importTemplate } from '@ui/templateLoader.js';

const MAX_WIDTH = 1600;

let modalRef = null;
let state = {
  list: [],
  listInfo: { total:0, pageSize:20, pageIndex:1, pageTotal:1 },
  loading: false,
  filters: { userIds: [] }
};

const COL_MAP = [
  { key:'devId',       title:'设备ID',     format:v=>safe(v) },
  { key:'devName',     title:'名称',       format:v=>escapeHTML(v||'') },
  { key:'devNo',       title:'编号',       format:v=>escapeHTML(v||'') },
  { key:'onlineState', title:'在线',       format:v=>{
    // 兼容后端可能返回 true/false / 1/0 / "1"/"0"/null
    const on = (v===true || v===1 || v==='1');
    return on
      ? '<span class="dot dot-green"></span><span style="margin-left:4px;color:#33d27a;">在线</span>'
      : '<span class="dot dot-gray"></span><span style="margin-left:4px;color:#888;">离线</span>';
  } },
  { key:'devTypeName', title:'类型',       format:v=>escapeHTML(v||'') },
  { key:'devModes',    title:'支持模式',   format:arr=> Array.isArray(arr)&&arr.length? arr.map(m=>escapeHTML(modeName(m))).join('、'):'' },
  { key:'userId',      title:'所属用户ID', format:v=>safe(v) },
  { key:'userName',    title:'所属帐号',   format:v=>escapeHTML(v||'') }
];

export async function showDeviceOverviewModal(opt={}) {
  const exist = getModal('deviceOverviewModal');
  if (exist) {
    if (opt.userIds) state.filters.userIds = Array.isArray(opt.userIds)?opt.userIds:[];
    loadPage(1, { silentLoading:false });
    exist.open && exist.open();
    return;
  }
  state.filters.userIds = Array.isArray(opt.userIds)?opt.userIds:[];

  let frag;
  try {
    frag = await importTemplate('/modules/features/pages/modals/device-overview-modal.html', 'tpl-device-overview-modal');
  } catch (e) {
    console.error('[DeviceOverviewModal] template load failed', e);
    return;
  }
  const content = document.createElement('div');
  content.appendChild(frag);

  // 填充 THEAD
  const headRow = content.querySelector('#devHeadRow');
  headRow.innerHTML = COL_MAP.map(c=>`<th>${c.title}</th>`).join('');

  const { width, height } = calcModalSize();
  modalRef = createModal({
    id:'deviceOverviewModal',
    title:'设备概览',
    width,
    height,            // 关键：固定一个可视高度，内部区域滚动
    content,
    footerButtons:[{
      text:'关闭',
      onClick: close => {
        close && close();
        window.removeEventListener('resize', onResize);
        modalRef = null;
      }
    }]
  });
  if (!modalRef) return;

  bindEvents();
  loadPage(1, { silentLoading:true });
}

function bindEvents() {
  modalRef.body.querySelector('#btnDevRefresh')
    .addEventListener('click', () => loadPage(state.listInfo.pageIndex, { silentLoading:false }));
  window.addEventListener('resize', onResize);
}
function onResize() {
  const m = getModal('deviceOverviewModal');
  if (!m || !m.wrap) return;
  const { width, height } = calcModalSize();
  m.wrap.style.width = width + 'px';
  m.wrap.style.height = height + 'px';
}

function calcModalSize() {
  const width = Math.min(Math.floor(window.innerWidth * 0.8), MAX_WIDTH);
  // 78vh 大约等于视口高度的 78%，预留头部/底部不遮挡
  const height = Math.max(460, Math.floor(window.innerHeight * 0.78));
  return { width, height };
}

function loadPage(pageIndex, { silentLoading }) {
  if (state.loading) return;
  state.loading = true;

  const mask = modalRef?.body.querySelector('#devLoadingMask');
  if (mask && !silentLoading) mask.style.display = 'flex';
  if (silentLoading && modalRef) {
    const tbody = modalRef.body.querySelector('.dev-tbody');
    tbody.innerHTML = renderLoadingRow();
  }

  apiDeviceList({
    userIds: state.filters.userIds,
    pageIndex,
    pageSize: state.listInfo.pageSize
  }).then(data => {
    const list = data.devList || [];
    const li = data.listInfo || {};
    const pageSize = li.pageSize || state.listInfo.pageSize;
    const total = li.total ?? list.length;
    const pageTotal = li.pageTotal || Math.max(1, Math.ceil(total / pageSize));
    state = {
      ...state,
      list: list.map(normalizeItem),
      listInfo: { total, pageIndex, pageSize, pageTotal }
    };
    renderTable();
    renderPager();
  }).catch(err => {
    console.error('[DeviceOverviewModal] load error', err);
    if (modalRef) {
      const tbody = modalRef.body.querySelector('.dev-tbody');
      tbody.innerHTML = `<tr><td colspan="${COL_MAP.length}" class="center text-error">${escapeHTML(err?.msg || '加载失败')}</td></tr>`;
      modalRef.body.querySelector('#devPager').innerHTML = '';
    }
  }).finally(() => {
    state.loading = false;
    const mask = modalRef?.body.querySelector('#devLoadingMask');
    if (mask) mask.style.display = 'none';
  });
}

function renderTable() {
  if (!modalRef) return;
  const tbody = modalRef.body.querySelector('.dev-tbody');
  if (!state.list.length) {
    tbody.innerHTML = `<tr><td colspan="${COL_MAP.length}" class="center">暂无数据</td></tr>`;
    return;
  }
  tbody.innerHTML = state.list.map(item =>
    `<tr>${COL_MAP.map(c=>`<td>${c.format(item[c.key])}</td>`).join('')}</tr>`
  ).join('');
}

function renderPager() {
  if (!modalRef) return;
  const { pageIndex, pageTotal, total } = state.listInfo;
  const pages = buildPageWindow(pageIndex, pageTotal, 2);
  const pagerEl = modalRef.body.querySelector('#devPager');
  pagerEl.innerHTML = `
    <button class="pg-btn" data-pg="prev" ${pageIndex===1?'disabled':''}>&lt;</button>
    ${pages.map(p=>`<button class="pg-btn ${p===pageIndex?'active':''}" data-pg="${p}">${p}</button>`).join('')}
    <button class="pg-btn" data-pg="next" ${pageIndex===pageTotal?'disabled':''}>&gt;</button>
    <span class="pg-info">共 ${total} 条</span>
  `;
  pagerEl.querySelectorAll('.pg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-pg');
      let target = pageIndex;
      if (val==='prev') target = pageIndex - 1;
      else if (val==='next') target = pageIndex + 1;
      else target = Number(val);
      if (target < 1 || target > pageTotal) return;
      loadPage(target, { silentLoading:false });
    });
  });
}

function renderLoadingRow() { return `<tr><td colspan="${COL_MAP.length}" class="center">加载中...</td></tr>`; }

/* ---- 标准化 ---- */
function normalizeItem(raw) {
  const di = raw?.devInfo || {};
  const ui = raw?.userInfo || {};
  return {
    devId: di.id,
    devName: di.name,
    devNo: di.no,
    onlineState: di.onlineState,
    devTypeName: di.typeName,
    devModes: di.modeList || [],
    userId: ui.userId,
    userName: ui.userName
  };
}
function modeName(m){ if(!m) return ''; if(typeof m==='string') return m; return m.modeName || m.name || String(m.modeId || m.id || ''); }
function safe(v){ return v==null?'':v; }
function escapeHTML(str=''){ return str.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
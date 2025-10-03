/**
 * DataCenterPage
 * 10 秒保留策略：
 *  - 离开页面时不立即销毁，移入隐藏池并启动 10 秒定时器；
 *  - 10 秒内返回复用原 DOM（设备行与模式组件保持运行）；
 *  - 超时定时器触发后才真正销毁。
 * 其它逻辑保持（含原有 setData / tree 交互）。
 */

import { importTemplate } from '@ui/templateLoader.js';
import { createTreePanel } from './components/TreePanel.js';
import { apiDevTypes, apiDevModes, apiGroupedDevices } from '@api/deviceApi.js';
import { eventBus } from '@core/eventBus.js';
import { wsHub } from '@core/hub.js';
import { createModeTilt } from './modes/ModeTilt.js';
import { createModeDispTilt } from './modes/ModeDispTilt.js';
import { createModeAudio } from './modes/ModeAudio.js';

const MAX_ROWS = 20;
const PREF_MODES = [1,2,3];
const KEY_TREE_COLLAPSED = 'ui.datacenter.tree.collapsed';
const __DC_RETAIN_MS = 10000;

if (!window.__PAGE_RETENTION) window.__PAGE_RETENTION = {};

let root = null, left = null, splitter = null, listEl = null, tree = null;
let treeToggleBtn = null, treeHandleBtn = null;
let deviceMap = new Map(); // devId -> { userInfo, devInfo }
let opened = new Map();    // devId -> { row, comps:[{mid,inst,unsub}], cleanup, devId, devNo }
let styleEl = null;        // *** 新增: 记录模板 style（保证 10 秒内复用时样式不丢）

export function mountDataCenterPage() {
  const main = document.getElementById('mainView');

  // 复用保留
  const retain = window.__PAGE_RETENTION.datacenter;
  if (retain && retain.root && (Date.now() - retain.ts) < __DC_RETAIN_MS) {
    if (retain.timer) { clearTimeout(retain.timer); retain.timer = null; }
    main.innerHTML = '';
    main.style.padding='0';
    main.style.overflow='hidden';
    if (retain.style && !document.contains(retain.style)) { // *** 新增: 还原样式
      main.appendChild(retain.style);
    }
    main.appendChild(retain.root);
    root = retain.root;
    left = root.querySelector('#dcLeft');
    splitter = root.querySelector('#dcSplitter');
    listEl = root.querySelector('#dcList');
    treeToggleBtn = root.querySelector('#dcTreeToggle');
    treeHandleBtn = root.querySelector('#dcTreeHandle');
    tree = retain.tree;
    deviceMap = retain.deviceMap;
    opened = retain.opened;
    styleEl = retain.style || null; // *** 恢复 style 引用
    if (listEl && typeof retain.scrollTop === 'number') { // *** 恢复滚动位置
      listEl.scrollTop = retain.scrollTop;
    }
    fit(main);
    window.addEventListener('resize', () => fit(main));
    return unmountDataCenterPage;
  }

  main.innerHTML = '';
  main.style.padding = '0';
  main.style.overflow = 'hidden';
  if (!getComputedStyle(main).position || getComputedStyle(main).position === 'static') main.style.position = 'relative';

  fit(main); window.addEventListener('resize', () => fit(main));

  importTemplate('/modules/features/pages/data-center-page.html', 'tpl-data-center-page')
    .then(async frag => {
      main.appendChild(frag);
      root = main.querySelector('#dcRoot');
      styleEl = (root && root.previousElementSibling instanceof HTMLStyleElement) ? root.previousElementSibling : null; // *** 记录样式节点
      left = root.querySelector('#dcLeft');
      splitter = root.querySelector('#dcSplitter');
      listEl = root.querySelector('#dcList');
      treeToggleBtn = root.querySelector('#dcTreeToggle');
      treeHandleBtn = root.querySelector('#dcTreeHandle');

      tree = createTreePanel();
      left.appendChild(tree);
      try { await tree.whenReady?.(); } catch {}

      const initCollapsed = loadCollapsed();
      applyLeftCollapsed(initCollapsed);
      treeToggleBtn.addEventListener('click', () => {
        const next = !left.classList.contains('collapsed');
        applyLeftCollapsed(next); saveCollapsed(next);
      });
      treeHandleBtn.addEventListener('click', () => { applyLeftCollapsed(false); saveCollapsed(false); });

      initSplitter(left, splitter);

      const onFilters = debounce(reloadByFilters, 250);
      ['filterchange','filtersChange','filterschange','filters:change'].forEach(evt => {
        try { tree.addEventListener(evt, onFilters); } catch {}
      });
      left.addEventListener('input', onFilters, true);
      left.addEventListener('change', onFilters, true);

      bindTreeDeviceClick(tree, (devId) => openDeviceRow(devId));

      await bootstrapData();
    })
    .catch(err => console.error('[DataCenter] template load failed', err));

  return unmountDataCenterPage;
}

export function unmountDataCenterPage() {
  if (!root) return;
  let pool = document.getElementById('__retainPool');
  if (!pool) {
    pool = document.createElement('div');
    pool.id='__retainPool';
    pool.style.display='none';
    document.body.appendChild(pool);
  }
  if (styleEl && document.contains(styleEl)) { // *** 放入隐藏池保存样式
    pool.appendChild(styleEl);
  }
  const currentScroll = listEl ? listEl.scrollTop : 0; // *** 记录滚动
  pool.appendChild(root);

  const destroy = () => {
    // 真正销毁
    for (const rs of opened.values()) { try { rs.cleanup?.(); } catch {} }
    opened.clear();
    deviceMap.clear();
    try { root.remove(); } catch {}
    root = null;
    try { styleEl && styleEl.remove(); } catch {}
    styleEl = null;
  };
  const timer = setTimeout(() => {
    destroy();
    if (window.__PAGE_RETENTION) delete window.__PAGE_RETENTION.datacenter;
  }, __DC_RETAIN_MS);

  window.__PAGE_RETENTION.datacenter = {
    root,
    style: styleEl, // *** 存储 style
    ts: Date.now(),
    timer,
    tree,
    deviceMap,
    opened,
    scrollTop: currentScroll // *** 存储滚动
  };

  // 断开本次引用
  root = null;
}

function fit(main){
  const top = main.getBoundingClientRect().top;
  const h = window.innerHeight - top;
  if (h > 0) main.style.height = h + 'px';
}

async function bootstrapData() {
  const [typesRes, modesRes] = await Promise.allSettled([
    apiDevTypes(), apiDevModes()
  ]);
  const types = typesRes.status==='fulfilled' ? (typesRes.value||{}) : {};
  const modes = modesRes.status==='fulfilled' ? (modesRes.value||{}) : {};

  const allTypes = Array.isArray(types.devTypeList) ? types.devTypeList : [];
  const allModes = Array.isArray(modes.devModeList) ? modes.devModeList : [];
  tree.__allTypes = allTypes;
  tree.__allModes = allModes;

  // 设备类型放开：展示全部设备类型（保留原始 typeId）
  const dcTypes = allTypes.map(t => ({ typeId: Number(t.typeId), typeName: t.typeName }));
  const dcModes = allModes.slice(0, 3).map((m, idx) => ({ modeId: idx + 1, modeName: m.modeName }));

  try {
    tree.setData({
      userList: [],
      devList: [],
      ungroupedDevices: [],
      devTypes: dcTypes,
      devModes: dcModes,
      expandLevel: 2,
      hideUngrouped: true
    });
  } catch {}

  await reloadByFilters();
}

async function reloadByFilters() {
  const f = tree.getFilterValues();
  const allTypes = Array.isArray(tree.__allTypes) ? tree.__allTypes : [];
  const allModes = Array.isArray(tree.__allModes) ? tree.__allModes : [];

  // 设备类型放开：若选择 0=全部，则使用全部原始 typeId；否则直接使用所选的真实 typeId
  const typeArr = (Number(f.devType) === 0)
    ? allTypes.map(t => Number(t.typeId)).filter(Boolean)
    : [Number(f.devType)].filter(Boolean);

  const modeArr = (Array.isArray(f.devModeIdArr) && f.devModeIdArr.length)
    ? f.devModeIdArr
    : (Number(f.devMode) === 0
        ? allModes.slice(0,3).map(m => Number(m.modeId)).filter(Boolean)
        : (allModes[Number(f.devMode) - 1] ? [Number(allModes[Number(f.devMode) - 1].modeId)] : []));

  const payload = {
    searchStr: f.searchStr,
    filterOnline: f.filterOnline,
    devTypeIdArr: typeArr,
    devModeIdArr: modeArr
  };

  const [gRes] = await Promise.allSettled([
    apiGroupedDevices(payload)
  ]);
  const grouped = gRes.status==='fulfilled' ? (gRes.value||{ userList:[], devList:[] }) : { userList:[], devList:[] };

  (function reRoot(){
    const selfId = (window && window.__CURRENT_USER_ID != null)
      ? Number(window.__CURRENT_USER_ID)
      : (window && window.__USER_ID != null ? Number(window.__USER_ID) : null);
    if (!(selfId > 0)) return;
    const list = Array.isArray(grouped.userList) ? grouped.userList : [];
    const idMap = new Map();
    list.forEach(u => { if (u && u.userId != null) idMap.set(Number(u.userId), u); });
    if (!idMap.has(selfId)) return;
    const keep = new Set();
    const childrenIdx = new Map();
    for (let i=0;i<list.length;i++){
      const u = list[i];
      if (!u || u.userId == null) continue;
      const pid = u.parentUserId;
      if (pid != null) {
        const k = Number(pid);
        if (!childrenIdx.has(k)) childrenIdx.set(k, []);
        childrenIdx.get(k).push(Number(u.userId));
      }
    }
    function dfs(id){
      if (keep.has(id)) return;
      if (!idMap.has(id)) return;
      keep.add(id);
      const ch = childrenIdx.get(id) || [];
      for (let j=0;j<ch.length;j++) dfs(ch[j]);
    }
    dfs(selfId);
    grouped.userList = list.filter(u => keep.has(Number(u.userId))).map(u => {
      if (Number(u.userId) === selfId) {
        const nu = Object.assign({}, u);
        nu.parentUserId = null;
        return nu;
      }
      return u;
    });
  })();

  try {
    tree.setData({
      userList: grouped.userList || [],
      devList: grouped.devList || [],
      ungroupedDevices: [],
      expandLevel: 2,
      hideUngrouped: true
    });
  } catch {}

  // 重建 deviceMap
  deviceMap.clear();
  const userMap = new Map();
  (grouped.userList || []).forEach(u => {
    if (u && u.userId != null) userMap.set(Number(u.userId), u);
  });
  (grouped.devList || []).forEach(item => {
    const di = item.devInfo || {};
    const devId = Number(di.id);
    if (!devId) return;
    const ownerId = Number(item.ownerUserId);
    const ownerUser = userMap.get(ownerId);
    deviceMap.set(devId, {
      devInfo: di,
      ownerUserId: ownerId,
      ownerUserName: ownerUser ? (ownerUser.userName || '') : ''
    });
  });
}

// 替换函数：openDeviceRow
function openDeviceRow(devId) {
  devId = Number(devId);
  if (!deviceMap.has(devId)) {
    eventBus.emit('toast:show', { type:'warn', message:'找不到设备数据' });
    return;
  }
  if (opened.has(devId)) {
    eventBus.emit('toast:show', { type:'info', message:'该设备已打开' });
    return;
  }
  if (opened.size >= MAX_ROWS) {
    eventBus.emit('toast:show', { type:'error', message:'没有空闲行' });
    return;
  }

  const item = deviceMap.get(devId);
  const di = item.devInfo || {};
  const devNo = di.no || di.devNo || '';
  const devName = di.name || '';
  const ownerName = item.ownerUserName || '';

  // 先确定要展示的模式（原逻辑 PREF_MODES 顺序，最多 3 个）
  const allow = new Set(PREF_MODES);
  const orderedMids = [];
  (di.modeList || []).forEach(m => {
    const mid = Number(m.modeId);
    if (allow.has(mid) && orderedMids.length < 3) orderedMids.push(mid);
  });

  // 模式名（去掉“模式”二字）
  function shortMode(mid){
    switch(Number(mid)){
      case 1: return '倾角';
      case 2: return '位移·倾角';
      case 3: return '音频';
      default: return '模式';
    }
  }
  const modePart = orderedMids.map(shortMode).join(' ');

  // 新标题格式：设备名称 设备编号 属主用户名 模式列表
  const titleText = [devName, devNo, ownerName, modePart]
    .filter(s => !!s && String(s).trim() !== '')
    .join(' ')
    .trim();

  const row = document.createElement('div'); 
  row.className = 'dc-row'; 
  row.setAttribute('data-dev-id', String(devId));
  row.innerHTML = `
    <div class="dc-row-hd">
      <div class="title">${escapeHTML(titleText || devNo || devName || '--')}</div>
      <div class="meta"></div>
      <div class="spacer"></div>
      <button type="button" class="btn-close" data-close="1" title="关闭">✕</button>
    </div>
    <div class="dc-row-bd"></div>
  `;
  listEl.appendChild(row);

  const header = row.querySelector('.dc-row-hd');
  const body = row.querySelector('.dc-row-bd');
  const closeBtn = row.querySelector('[data-close]');

  header.addEventListener('click', ev => {
    if (ev.target.closest('[data-close]')) return;
    openDeviceDetailOverlay(devId, devNo);
  });
  try { header.style.cursor = 'pointer'; } catch {}

  const comps = [];
  orderedMids.forEach(mid => {
    const cell = document.createElement('div'); 
    cell.className = 'dc-thumb'; 
    cell.setAttribute('data-mode', String(mid));
    const label = document.createElement('div'); 
    label.className = 'label'; 
    label.textContent = shortMode(mid); // 缩略图自身的文字也使用短模式名
    cell.appendChild(label);

    const safeDevIdNum = Number(devId);
    const inst = createModeComponent(mid, safeDevIdNum);
    const instEl = inst && (inst.el || inst);
    if (instEl) cell.appendChild(instEl);

    cell.addEventListener('click', ev => {
      try {
        if (ev.target && ev.target.closest && ev.target.closest('[data-refresh-btn],[data-refresh="1"],.refresh-btn,.mode-refresh')) {
          return;
        }
        const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
        for (const n of path) {
          if (!n || n === cell || n === document || n === window) continue;
            if (n.hasAttribute && (n.hasAttribute('data-refresh-btn') || n.getAttribute('data-refresh') === '1')) return;
            if (n.classList && (n.classList.contains('refresh-btn') || n.classList.contains('mode-refresh'))) return;
        }
      } catch {}
      try {
        const instElement = inst && inst.el;
        if (instElement && (instElement.dataset.suspended === '1' || !instElement.dataset.hasData)) {
          eventBus.emit('toast:show', { type:'info', message:'暂无数据，无法进入详情' });
          return;
        }
      } catch {}
      openModeDetailOverlay(devId, devNo, mid);
    });

    try { cell.style.cursor = 'pointer'; } catch {}
    try { label.style.cursor = 'pointer'; } catch {}
    try { if (instEl && instEl.style) instEl.style.cursor = 'pointer'; } catch {}

    try { inst && inst.start && inst.start(); } catch {}

    const unsub = () => {};
    body.appendChild(cell);
    comps.push({ mid, inst, unsub });
  });

  const cleanup = () => {
    // 先逻辑关闭，确保订阅引用数立即减少
    comps.forEach(c => {
      try { c.inst && c.inst.setOpened && c.inst.setOpened(false); } catch {}
    });
    // 再执行 destroy 彻底释放
    comps.forEach(c => {
      try { c.inst && c.inst.destroy && c.inst.destroy(); } catch {}
      try { c.unsub && c.unsub(); } catch {}
    });
    try { row.remove(); } catch {}
    opened.delete(devId);
  };
  closeBtn.addEventListener('click', cleanup);

  opened.set(devId, { row, comps, cleanup, devId, devNo });
}

function destroyRow(devId) {
  const r = opened.get(devId);
  if (!r) return;
  try { r.cleanup && r.cleanup(); } catch {}
  opened.delete(devId);
}

function modeName(mid){
  switch(Number(mid)){
    case 1: return '倾角模式';
    case 2: return '位移·倾角模式';
    case 3: return '音频模式';
    default: return '模式';
  }
}

function createModeComponent(mid, devId) {
  if (mid === 1) return createModeTilt({ devId });
  if (mid === 2) return createModeDispTilt({ devId });
  if (mid === 3) return createModeAudio({ devId });
  return createModeAudio({ devId });
}

function openDeviceDetailOverlay(devId, devNo) {
  openOverlay('/modules/features/pages/details/device-detail.html', { devId, devNo });
}
function openModeDetailOverlay(devId, devNo, modeId) {
  const mid = Number(modeId);
  const url = mid===1 ? '/modules/features/pages/details/mode-tilt-detail.html'
            : mid===2 ? '/modules/features/pages/details/mode-disp-tilt-detail.html'
            : '/modules/features/pages/details/mode-audio-detail.html';
  openOverlay(url, { devId, devNo, modeId: mid });
}

/* -------------- Splitter -------------- */
function initSplitter(leftWrap, splitter) {
  const MIN = 240, MAXVW = 50;
  splitter.addEventListener('mousedown', e => {
    if (leftWrap.classList.contains('collapsed')) return;
    const layoutRect = root.getBoundingClientRect();
    const maxPx = Math.floor(window.innerWidth * (MAXVW/100));
    const glass = document.createElement('div');
    Object.assign(glass.style, { position:'fixed', inset:'0', cursor:'col-resize', zIndex:'2147483646', background:'transparent', userSelect:'none' });
    document.body.appendChild(glass);
    const move = ev => {
      const x = (ev.clientX||0) - layoutRect.left;
      const w = Math.max(MIN, Math.min(Math.round(x), maxPx));
      leftWrap.style.width = w+'px';
      ev.preventDefault();
    };
    const end = () => {
      try { glass.remove(); } catch {}
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', end);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('blur', end);
      document.removeEventListener('visibilitychange', end);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end, { once:true });
    window.addEventListener('pointerup', end, { once:true });
    window.addEventListener('blur', end, { once:true });
    document.addEventListener('visibilitychange', end, { once:true });
    e.preventDefault();
  });
}

function bindTreeDeviceClick(treeEl, fn) {
  const handler = e => {
    const devId = (e && e.detail && (e.detail.devId || e.detail.id)) || e.devId || e.id;
    if (!devId) return;
    fn(Number(devId));
  };
  ['deviceclick','deviceClick','devclick','dev:click'].forEach(evt => {
    try { treeEl.addEventListener(evt, handler); } catch {}
  });
}

/* -------------- Overlay -------------- */
let __overlay = null;
function ensureOverlay() {
  if (__overlay && document.body.contains(__overlay.host)) return __overlay;

  const host = document.createElement('div');
  Object.assign(host.style, { position:'fixed', inset:'0', background:'#000', zIndex:'2147483645', display:'none' });
  const iframe = document.createElement('iframe');
  Object.assign(iframe.style, { position:'absolute', inset:'0', width:'100%', height:'100%', border:'0', background:'#000' });
  host.appendChild(iframe);
  document.body.appendChild(host);

  const chUnsub = new Map();
  const chKey = new Map();

  const onMsg = e => {
    const msg = e.data || {};
    if (!msg || !msg.__detail) return;
    switch (msg.t) {
      case 'ready': {
        const payload = Object.assign({ t:'init' }, (__overlay.initParams || {}));
        try { iframe.contentWindow?.postMessage(Object.assign({ __detail:true }, payload), '*'); } catch {}
        return;
      }
      case 'back': closeOverlay(); return;
      case 'openMode': openModeDetailOverlay(msg.devId, msg.devNo, msg.modeId); return;
      case 'ws:open': {
        const ch = Date.now() + Math.floor(Math.random()*1000);
        chKey.set(ch, { kind: msg.kind, devId: msg.devId, modeId: msg.modeId });
        const filter = {};
        if (msg.devId != null) filter['to.id'] = String(msg.devId);
        if (msg.modeId != null) filter['modeId'] = String(msg.modeId);
        const un = wsHub.onMatch(filter, m => {
          try { iframe.contentWindow?.postMessage({ __detail:true, t:'ws:message', ch, data:m }, '*'); } catch {}
        });
        chUnsub.set(ch, un);
        try { iframe.contentWindow?.postMessage({ __detail:true, t:'ws:open:ok', reqId: msg.reqId, ch }, '*'); } catch {}
        return;
      }
      case 'ws:send': { try { wsHub.send(msg.data); } catch {} return; }
      case 'ws:close': {
        const ch = msg.ch, un = chUnsub.get(ch);
        if (un) { try { un(); } catch {} }
        chUnsub.delete(ch); chKey.delete(ch);
        try { iframe.contentWindow?.postMessage({ __detail:true, t:'ws:closed', ch }, '*'); } catch {}
        return;
      }
    }
  };
  window.addEventListener('message', onMsg);

  __overlay = { host, iframe, onMsg, initParams: null, chUnsub, chKey };
  return __overlay;
}
function openOverlay(url, params) {
  const ov = ensureOverlay();
  const qs = new URLSearchParams(params || {});
  qs.set('_ts', Date.now());
  ov.initParams = Object.assign({}, params || {});
  ov.iframe.src = url + '?' + qs.toString();
  ov.host.style.display = 'block';
}
function closeOverlay() {
  if (!__overlay) return;
  try {
    for (const un of __overlay.chUnsub.values()) { try { un(); } catch {} }
    __overlay.chUnsub.clear();
  } catch {}
  __overlay.host.style.display = 'none';
  try { __overlay.iframe.src = 'about:blank'; } catch {}
}

/* -------------- 工具 -------------- */
function escapeHTML(str=''){ return String(str).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function debounce(fn, wait){ let t; return function(){ const a=arguments; clearTimeout(t); t=setTimeout(()=>fn.apply(null,a), wait||300); }; }
function applyLeftCollapsed(flag){
  const toggle = document.getElementById('dcTreeToggle');
  const handle = document.getElementById('dcTreeHandle');
  if (!left || !root || !toggle || !handle) return;

  if (flag) {
    if (!left.dataset.prevW) {
      const w = left.getBoundingClientRect().width;
      if (w > 0) left.dataset.prevW = w + 'px';
    }
    left.classList.add('collapsed');
    root.classList.add('left-collapsed');
    toggle.textContent = '»'; toggle.title = '展开树状栏';
    handle.textContent = '»'; handle.title = '展开树状栏';
  } else {
    left.classList.remove('collapsed');
    root.classList.remove('left-collapsed');
    toggle.textContent = '«'; toggle.title = '折叠树状栏';
    handle.textContent = '«'; handle.title = '折叠树状栏';
    left.style.width = left.dataset.prevW || '320px';
  }
}
function loadCollapsed(){ try{ return localStorage.getItem(KEY_TREE_COLLAPSED) === '1'; } catch { return false; } }
function saveCollapsed(v){ try{ localStorage.setItem(KEY_TREE_COLLAPSED, v?'1':'0'); } catch {} }
import { createTreePanel } from './components/TreePanel.js';
import { createVideoPreview } from './modes/VideoPreview.js';
import { createModePreview } from './modes/ModePreview.js';
import { createModeTilt } from './modes/ModeTilt.js';
import { createModeDispTilt } from './modes/ModeDispTilt.js';
import { createModeAudio } from './modes/ModeAudio.js';
import { createMapView } from './components/MapView.js';
import { ENV } from '/config/env.js';
import { siteState } from '@state/siteState.js';
import { wsHub } from '@core/hub.js';
import { androidWsApi } from '@api/androidWSApi.js';

import {
  apiDevTypes, apiDevModes, apiGroupedDevices, apiUngroupedDevices,
  apiDeviceSummary, apiOnlineList, apiDeviceInfo
} from '@api/deviceApi.js';
import { eventBus } from '@core/eventBus.js';
import { importTemplate } from '@ui/templateLoader.js';
import { createStreamThumbnail, requestHighQuality } from '@utils/streamThumbManager.js';
import { SITE_MAX_WINDOWS } from '/config/constants.js'; // MOD: 最大窗口配置

const KEY_TREE_COLLAPSED = 'ui.sitepage.tree.collapsed';
const __SITE_RETAIN_MS = 10000;

if (!window.__PAGE_RETENTION) window.__PAGE_RETENTION = {};

let rootEl = null;
let tree = null;
let mapView = null;
let siteStyleEl = null;
let __firstMounted = false; // 首次进入标记

/* ================== MOD: 新增窗口管理结构 ================== */
let recordList = [];          // 重新加载(全部打开)时记录的“可滚动”模式/视频全集
let openLogical = [];         // 逻辑窗口序列（记录 + 手动）
let nextRecordCursor = 0;     // 下一个尚未加入 openLogical 的 recordList 索引
// openLogical 元素结构：
//   kind: 'record' | 'manual'
//   recordIndex: >=0(记录) 或 -1(手动)
//   devId, devNo, modeId, streamIndex(视频0主 1副)
//   key: devId:modeId:streamIndex
//   inst / __videoCleanup / __slot
let visibleOrder = [];        // 当前已渲染的 6 个槽位对应 openLogical 的索引数组（支持拖拽保持）
/* =========================================================== */

let windowStart = 0;
let notifyTimer = null;

/* ---------------- 名称工具 ---------------- */
function MODE_NAME(mid){
  switch(Number(mid)){
    case 1: return '倾角模式';
    case 2: return '位移·倾角模式';
    case 3: return '音频模式';
    default: return '模式';
  }
}

/* ---------------- 全局引用注册 ---------------- */
function initGlobalStreamRegistry() {
  if (!window.__GLOBAL_VIDEO_REF) window.__GLOBAL_VIDEO_REF = Object.create(null);
  if (!window.__GLOBAL_MODE_REF)  window.__GLOBAL_MODE_REF  = Object.create(null);
  console.log('[SitePage][globalRef] registry ready');
}
// MOD: 补回被移除的 initSplitter，实现与最初版本等价（供调用处使用）
function initSplitter(leftWrap, splitter, onDrag) {
  const MIN = 240, MAXVW = 50;
  splitter.addEventListener('mousedown', (e) => {
    if (leftWrap.classList.contains('collapsed')) return;
    const layoutRect = rootEl.getBoundingClientRect();
    const maxPx = Math.floor(window.innerWidth * (MAXVW/100));
    const glass = document.createElement('div');
    Object.assign(glass.style, {
      position:'fixed', inset:'0', cursor:'col-resize', zIndex:'2147483646',
      background:'transparent', userSelect:'none'
    });
    document.body.appendChild(glass);
    const move = (ev) => {
      const x = (ev.clientX||0) - layoutRect.left;
      const w = Math.max(MIN, Math.min(Math.round(x), maxPx));
      leftWrap.style.width = w+'px';
      if (onDrag) onDrag();
      ev.preventDefault();
    };
    const end = () => {
      try { glass.remove(); } catch {}
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', end);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('blur', end);
      document.removeEventListener('visibilitychange', end);
      requestAnimationFrame(()=>{ if (onDrag) onDrag(); });
      setTimeout(()=>{ if (onDrag) onDrag(); }, 100);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end, { once:true });
    window.addEventListener('pointerup', end, { once:true });
    window.addEventListener('blur', end, { once:true });
    document.addEventListener('visibilitychange', end, { once:true });
    e.preventDefault();
  });
}
// MOD: 辅助汇总当前 openLogical 设备/模式结构
function __dumpOpenLogicalSummary() {
  const map = new Map();
  openLogical.forEach(e=>{
    if (!e.devId || !e.modeId) return;
    if (!map.has(e.devId)) map.set(e.devId, new Set());
    map.get(e.devId).add(e.modeId + ':' + (e.modeId===4 ? (e.streamIndex||0) : '0'));
  });
  // 转换为指定格式 [10:[1,2,3],11:[1,4]] 其中视频主/副以 modeId=4 但区分 index => 展开为 4(0),4(1)
  const arr = [];
  for (const [devId, set] of map.entries()) {
    const list = Array.from(set).map(s=>{
      const [mid, idx]=s.split(':');
      return Number(mid)===4 ? (`4(${idx})`) : mid;
    });
    arr.push(`${devId}:[${list.join(',')}]`);
  }
  return `[${arr.join(', ')}]`;
}

/* ========================================================================== *
 *  挂载 / 卸载
 * ========================================================================== */
// MOD: mountSitePage 增加“自动打开模式/视频”持久化逻辑（localStorage），默认 true，用户改变后保存，下次进入按保存值决定是否自动全部打开
export function mountSitePage() {
  console.log('[SitePage][mount] start, reuse check...');
  initGlobalStreamRegistry();

  const main = document.getElementById('mainView');
  const retain = window.__PAGE_RETENTION.site;

  // 复用路径（无时间限制）
  if (retain && retain.root) {
    console.log('[SitePage][mount] reuse path');
    if (retain.timer) { clearTimeout(retain.timer); retain.timer = null; }
    main.innerHTML = '';
    main.style.padding='0';
    main.style.overflow='hidden';
    main.appendChild(retain.root);
    if (retain.style && !document.contains(retain.style)) {
      console.log('[SitePage][mount] re-append retained style');
      document.getElementById('mainView').insertBefore(retain.style, retain.root);
    }
    rootEl      = retain.root;
    mapView     = retain.mapView;
    tree        = retain.tree;
    siteStyleEl = retain.style;
    notifyTimer = retain.notifyTimer;

    ensureSitePageStyle();
    restoreAfterReuse(main);
    return unmountSitePage;
  }

  // 首次路径
  console.log('[SitePage][mount] first time path');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  main.innerHTML = '';
  main.style.padding = '0';
  main.style.overflow = 'hidden';
  if (!getComputedStyle(main).position || getComputedStyle(main).position === 'static')
    main.style.position = 'relative';

  fitMainHeight(main);
  window.addEventListener('resize', () => fitMainHeight(main));

  importTemplate('/modules/features/pages/site-page.html', 'tpl-site-page')
    .then(async frag => {
      main.appendChild(frag);
      siteStyleEl = Array.from(main.querySelectorAll(':scope > style')).find(s=>s.textContent.includes('.sp-root'));
      if (siteStyleEl) siteStyleEl.__sitePageStyle = true;
      rootEl = main.querySelector('#spRoot');
      console.log('[SitePage][mount] template appended, style found?', !!siteStyleEl);

      const leftWrap      = rootEl.querySelector('#spLeft');
      const splitter      = rootEl.querySelector('#spSplitter');
      const mapMount      = rootEl.querySelector('#spMapMount');
      const statusPanel   = rootEl.querySelector('.sp-status');
      const notifyPanel   = rootEl.querySelector('.sp-notify');
      const grid          = rootEl.querySelector('#mediaGrid');
      const treeToggleBtn = rootEl.querySelector('#spTreeToggle');
      const treeHandleBtn = rootEl.querySelector('#spTreeHandle');

      injectMediaLayoutStructure();

      tree = createTreePanel();
      leftWrap.appendChild(tree);
      try { if (tree.whenReady) await tree.whenReady(); } catch {}
      console.log('[SitePage][mount] tree ready');

      const initCollapsed = loadCollapsed();
      applyLeftCollapsed(initCollapsed);

      treeToggleBtn.addEventListener('click', () => {
        const next = !leftWrap.classList.contains('collapsed');
        applyLeftCollapsed(next); saveCollapsed(next);
        try { mapView.resize(); } catch {}
      });
      treeHandleBtn.addEventListener('click', () => {
        applyLeftCollapsed(false); saveCollapsed(false);
        try { mapView.resize(); } catch {}
      });

      const onTreeFiltersChange = debounce(() => {
        console.log('[SitePage][filters] change -> reload data (not auto open)');
        reloadByFilters();
      }, 250);
      ['filtersChange','filterchange','filterschange','filters:change'].forEach(evt => {
        try { tree.addEventListener(evt, onTreeFiltersChange); } catch {}
      });
      leftWrap.addEventListener('input', onTreeFiltersChange, true);
      leftWrap.addEventListener('change', onTreeFiltersChange, true);

      mapView = createMapView({
        amapKey: (ENV && ENV.AMAP_KEY) || (window.__AMAP_KEY || ''),
        debug: false
      });
      mapMount.appendChild(mapView);
      mapView.mount();
      console.log('[SitePage][mount] mapView mounted');

      mapView.addEventListener('openVideo', e => openVideoInSlot(e.detail.devId, e.detail.devNo, e.detail.stream || 'main'));
      mapView.addEventListener('openMode',  e => openModeInSlot(e.detail.devId, e.detail.devNo, e.detail.modeId));
      mapView.addEventListener('refreshDevice', async e => {
        try {
          const data = await apiDeviceInfo(e.detail.devId);
          mapView.openDevice({ devInfo:data.devInfo, followCenterWhenNoLocation:true });
        } catch (err) {
          console.warn('[Site] refreshDevice api error', err);
        }
      });
      mapView.addEventListener('markerClick', async e => {
        try {
          const data = await apiDeviceInfo(e.detail.devId);
          mapView.openDevice({ devInfo:data.devInfo, followCenterWhenNoLocation:true });
        } catch {
          mapView.openDevice({ devInfo:{ id:e.detail.devId, devNo:e.detail.devNo }, followCenterWhenNoLocation:true });
        }
      });
      mapView.addEventListener('openDetail', e => openDeviceDetailOverlay(e.detail.devId, e.detail.devNo));

      bindTreeDeviceClick(tree);

      grid.addEventListener('click', ev => {
        const btn = ev.target.closest('[data-close]');
        if (!btn) return;
        const idx = Number(btn.getAttribute('data-close'));
        closeSlot(idx);
      });

      initSplitter(leftWrap, splitter, () => { try { mapView.resize(); } catch {} });

      // 初始化 6 个物理槽位空态
      for (let i=0;i<6;i++) {
        const body = document.getElementById('mediaBody'+i);
        if (body) {
          body.innerHTML='<div style="color:#567;font-size:12px;">视频流/模式</div>';
          body.setAttribute('data-free','1');
        }
      }

      enableGridDragReorder(grid);
      enableGridClickOpen(grid);

      // 自动展示开关（持久化）
      const autoWrap = document.createElement('div');
      autoWrap.style.display='flex';
      autoWrap.style.alignItems='center';
      autoWrap.style.margin='4px 0 6px 0';
      autoWrap.innerHTML = `
        <label style="font-size:12px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="autoShowModes" />
          <span>自动打开模式/视频</span>
        </label>
      `;
      try { statusPanel.parentElement.insertBefore(autoWrap, statusPanel); } catch {}

      // 读取保存值（默认 true）
      let savedAuto = true;
      try {
        const v = localStorage.getItem('ui.sitepage.autoShowModes');
        if (v === '0') savedAuto = false;
        else if (v === '1') savedAuto = true;
      } catch {}
      const autoChkInit = document.getElementById('autoShowModes');
      if (autoChkInit) {
        autoChkInit.checked = savedAuto;
        autoChkInit.addEventListener('change', () => {
          try {
            localStorage.setItem('ui.sitepage.autoShowModes', autoChkInit.checked ? '1' : '0');
          } catch {}
        });
      }

      setupMediaToolbar();
      startNotifyPoll(notifyPanel.querySelector('#notifyList'));

      await bootstrapData(statusPanel.querySelector('#summaryChart'), notifyPanel.querySelector('#notifyList'));

      const autoChk = document.getElementById('autoShowModes');
      if (autoChk && autoChk.checked && !__firstMounted) {
        performFullOpen();
      }

      __firstMounted = true;
      console.log('[SitePage][mount] completed');
    })
    .catch(err => console.error('[SitePage] template load failed', err));

  return unmountSitePage;
}

/**
 * 卸载：移入隐藏池并启动定时清理媒体（保留其它数据结构，10秒后清空窗口和记录）
 */
export function unmountSitePage() {
  console.log('[SitePage][unmount] start');
  if (!rootEl) { console.log('[SitePage][unmount] no root, skip'); return; }
  let pool = document.getElementById('__retainPool');
  if (!pool) {
    pool = document.createElement('div');
    pool.id = '__retainPool';
    pool.style.display='none';
    document.body.appendChild(pool);
  }

  if (siteStyleEl && document.contains(siteStyleEl)) {
    pool.appendChild(siteStyleEl);
  }
  pool.appendChild(rootEl);

  const destroy = () => {
    console.log('[SitePage][unmount] clear media slots after retention');
    try {
      for (let i=0;i<openLogical.length;i++){
        if (openLogical[i].__slot != null) releaseSlot(openLogical[i].__slot);
      }
      openLogical = [];
      visibleOrder = [];
      windowStart = 0;
      recordList = [];
      nextRecordCursor = 0;
    } catch {}
    if (window.__PAGE_RETENTION && window.__PAGE_RETENTION.site) {
      window.__PAGE_RETENTION.site.clearedMedia = true;
    }
  };

  const timer = setTimeout(() => {
    destroy();
  }, __SITE_RETAIN_MS);

  window.__PAGE_RETENTION.site = {
    root: rootEl,
    style: siteStyleEl,
    ts: Date.now(),
    timer,
    destroy,
    mapView,
    tree,
    notifyTimer,
    clearedMedia:false
  };

  rootEl = null;
  console.log('[SitePage][unmount] retained, timeout=', __SITE_RETAIN_MS);
}

/* ========================================================================== *
 *  样式 / 地图 保证
 * ========================================================================== */
function ensureSitePageStyle() {
  if (siteStyleEl && document.contains(siteStyleEl)) return;
  const main = document.getElementById('mainView');
  const exist = Array.from(main.querySelectorAll(':scope > style')).find(s => s.textContent.includes('.sp-root'));
  if (exist) {
    siteStyleEl = exist;
    siteStyleEl.__sitePageStyle = true;
    console.log('[SitePage][style] reused existing style');
    return;
  }
  console.log('[SitePage][style] missing, re-fetch template style...');
  fetch('/modules/features/pages/site-page.html', { cache:'no-cache' })
    .then(r=>r.text())
    .then(html=>{
      const doc = new DOMParser().parseFromString(html,'text/html');
      const style = doc.querySelector('template#tpl-site-page > style');
      if (style) {
        siteStyleEl = style.cloneNode(true);
        siteStyleEl.__sitePageStyle = true;
        main.insertBefore(siteStyleEl, main.firstChild || null);
        console.log('[SitePage][style] restored style from template');
      } else {
        console.warn('[SitePage][style] template style not found');
      }
    })
    .catch(e=>console.error('[SitePage][style] restore failed', e));
}

function ensureMapViewAlive() {
  try {
    const mount = rootEl?.querySelector('#spMapMount');
    if (!mount) { console.warn('[SitePage][map] mount missing'); return; }
    const iframe = mount.querySelector('iframe');
    const rect = mount.getBoundingClientRect();
    if (!iframe) {
      console.log('[SitePage][map] iframe missing -> remount');
      try { mapView && mapView.mount && mapView.mount(); } catch(e){ console.warn('[SitePage][map] remount failed', e); }
    } else if (rect.width === 0 || rect.height === 0) {
      console.log('[SitePage][map] zero size -> force resize later');
      requestAnimationFrame(()=>{ try { mapView && mapView.resize && mapView.resize(); } catch{} });
      setTimeout(()=>{ try { mapView && mapView.resize && mapView.resize(); } catch{} }, 60);
    } else {
      try { mapView && mapView.resize && mapView.resize(); } catch {}
    }
  } catch(e) {
    console.warn('[SitePage][map] ensureMapViewAlive error', e);
  }
}

/* ========================================================================== *
 *  复用恢复
 * ========================================================================== */
// MOD: restoreAfterReuse 增加自动展示勾选框持久化恢复 & 若为空且开启则自动全部打开
function restoreAfterReuse(main) {
  console.log('[SitePage][restore] begin');
  ensureSitePageStyle();
  injectMediaLayoutStructure();
  setupMediaToolbar();

  const grid = rootEl.querySelector('#mediaGrid');
  enableGridDragReorder(grid);
  enableGridClickOpen(grid);

  // 恢复自动展示勾选框状态
  const autoChk = document.getElementById('autoShowModes');
  if (autoChk) {
    try {
      const v = localStorage.getItem('ui.sitepage.autoShowModes');
      if (v === '0') autoChk.checked = false;
      else if (v === '1') autoChk.checked = true;
      else autoChk.checked = true; // 默认
    } catch {
      autoChk.checked = true;
    }
    // 绑定一次（若重复绑定也只是覆盖）
    autoChk.onchange = () => {
      try { localStorage.setItem('ui.sitepage.autoShowModes', autoChk.checked ? '1':'0'); } catch {}
    };
  }

  fitMainHeight(main);
  ensureMapViewAlive();
  try { mapView && mapView.resize && mapView.resize(); } catch {}

  requestAnimationFrame(() => {
    fitMainHeight(main);
    ensureMapViewAlive();
    requestAnimationFrame(() => {
      ensureMapViewAlive();
    });
  });

  // 如果当前没有任何逻辑窗口并且勾选开启，执行自动打开
  if (openLogical.length === 0 && autoChk && autoChk.checked) {
    performFullOpen();
  } else {
    renderVisible();
  }

  console.log('[SitePage][restore] done');
}

/* ========================================================================== *
 *  媒体布局结构注入
 * ========================================================================== */
function injectMediaLayoutStructure() {
  if (!rootEl) return;
  const bottom = rootEl.querySelector('.sp-bottom');
  const grid   = rootEl.querySelector('#mediaGrid');
  if (!bottom || !grid) {
    console.warn('[SitePage][layout] missing bottom or grid', bottom, grid);
    return;
  }

  const existedToolbar = bottom.querySelector('.sp-media-toolbar');
  const existedRow     = bottom.querySelector('.sp-media-row');

  if (existedToolbar && existedRow) {
    const wrap = existedRow.querySelector('.media-grid-wrap');
    if (wrap && !wrap.contains(grid)) {
      console.log('[SitePage][layout] re-parent grid into wrap');
      wrap.innerHTML = '';
      wrap.appendChild(grid);
    }
    if (!bottom.querySelector('#windowIndexInfo')) {
      const infoSpan = document.createElement('span');
      infoSpan.id = 'windowIndexInfo';
      infoSpan.style.cssText='font-size:11px;color:#9ec3ff;margin-right:12px;white-space:nowrap;';
      existedToolbar.insertBefore(infoSpan, existedToolbar.firstChild);
    }
    if (!bottom.querySelector('#reloadSlotsBtn')) {
      const btnOpen = document.createElement('button');
      btnOpen.id='reloadSlotsBtn';
      btnOpen.className='btn btn-xs';
      btnOpen.style.padding='4px 12px';
      btnOpen.textContent='全部打开';
      existedToolbar.appendChild(btnOpen);
    } else {
      const b = bottom.querySelector('#reloadSlotsBtn');
      if (b) b.textContent='全部打开';
    }
    if (!bottom.querySelector('#closeAllBtn')) {
      const btnCloseAll = document.createElement('button');
      btnCloseAll.id='closeAllBtn';
      btnCloseAll.className='btn btn-xs';
      btnCloseAll.style.cssText='padding:4px 12px;margin-left:6px;';
      btnCloseAll.textContent='全部关闭';
      existedToolbar.appendChild(btnCloseAll);
    }
    return;
  }

  if (!rootEl.querySelector('#__mediaLayoutStyle')) {
    const style = document.createElement('style');
    style.id='__mediaLayoutStyle';
    style.textContent = `
      .sp-media-toolbar{display:flex;align-items:center;justify-content:flex-end;margin:4px 0 6px 0;min-height:28px;}
      .sp-media-row{display:flex;align-items:stretch;gap:10px;width:100%;height:100%;}
      .sp-media-row .media-nav{width:32px;min-width:32px;background:#15202b;border:1px solid #2e3a44;color:#9ec3ff;border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px;user-select:none;}
      .sp-media-row .media-nav:hover{background:#1e2a35;}
      .sp-media-row .media-grid-wrap{flex:1 1 auto;min-width:0;display:flex;}
      .sp-media-row .sp-grid{flex:1 1 auto;height:100%;}
    `;
    rootEl.appendChild(style);
  }

  const toolbar = document.createElement('div');
  toolbar.className='sp-media-toolbar';
  toolbar.innerHTML = `
    <span id="windowIndexInfo" style="font-size:11px;color:#9ec3ff;margin-right:12px;white-space:nowrap;"></span>
    <div style="flex:1"></div>
    <button id="reloadSlotsBtn" class="btn btn-xs" style="padding:4px 12px;">全部打开</button>
    <button id="closeAllBtn" class="btn btn-xs" style="padding:4px 12px;margin-left:6px;">全部关闭</button>
  `;

  const row = document.createElement('div');
  row.className='sp-media-row';
  row.innerHTML = `
    <button type="button" class="media-nav" id="mediaNavPrev" title="上一组" style="display:none;">&lt;</button>
    <div class="media-grid-wrap"></div>
    <button type="button" class="media-nav" id="mediaNavNext" title="下一组" style="display:none;">&gt;</button>
  `;
  row.querySelector('.media-grid-wrap').appendChild(grid);

  bottom.innerHTML='';          // 清空旧内容（网格会重新放入 row）
  bottom.appendChild(row);      // 只放网格行
  // 工具栏移到 bottom 之前，成为兄弟元素
  if (!bottom.previousElementSibling || !bottom.previousElementSibling.classList.contains('sp-media-toolbar')) {
    bottom.parentNode.insertBefore(toolbar, bottom);
  }
  console.log('[SitePage][layout] structure injected');
}

function setupMediaToolbar() {
  if (!rootEl) return;
  const prevBtn    = rootEl.querySelector('#mediaNavPrev');
  const nextBtn    = rootEl.querySelector('#mediaNavNext');
  const openBtn    = rootEl.querySelector('#reloadSlotsBtn');
  const closeAllBtn= rootEl.querySelector('#closeAllBtn');

  function rebind(btn, handler, name){
    if (!btn) { console.warn('[SitePage][toolbar] missing button', name); return; }
    const clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    clone.addEventListener('click', handler);
  }

  rebind(prevBtn, () => {
    scrollLeft();
  }, 'prev');

  rebind(nextBtn, () => {
    scrollRight();
  }, 'next');

  rebind(openBtn, () => {
    console.log('[SitePage][toolbar] 全部打开 clicked');
    performFullOpen();
  }, 'fullopen');

  rebind(closeAllBtn, () => {
    console.log('[SitePage][toolbar] 全部关闭 clicked');
    closeAllWindowsAndClearRecords(true);
  }, 'fullclose');

  console.log('[SitePage][toolbar] bound (new)');
  updateIndexDisplay();
  updateArrowVisibility();
}

/* ========================================================================== *
 *  Record 构建 & 全部打开
 * ========================================================================== */
function buildRecordListFromLastDevices() {
  recordList = [];
  const all = Array.isArray(window.__LAST_SITE_DEVS) ? window.__LAST_SITE_DEVS : [];
  all.forEach(d => {
    const di = d.devInfo || {};
    if (!di.onlineState) return;
    const devId   = di.id;
    const devNo   = di.no || di.devNo || '';   // 编号（唯一凭据）
    const devName = di.name || '';             // 设备名称（可能为空）
    const modes = Array.isArray(di.modeList) ? di.modeList : [];
    const modeIds = modes.map(m => Number(m.modeId)).filter(m => [1,2,3,4].includes(m));
    modeIds.sort((a,b)=>a-b);

    const camCount = Number(
      (di.hardwareInfo && di.hardwareInfo.cameraCount != null) ? di.hardwareInfo.cameraCount :
      (di.cameraCount != null ? di.cameraCount :
        (di.cameras != null ? di.cameras : 0))
    ) || 0;

    modeIds.forEach(mid => {
      if (mid === 4) {
        if (camCount <= 0) return;
        recordList.push({ devId, devNo, devName, modeId:4, streamIndex:0 });
        if (camCount >= 2) {
          recordList.push({ devId, devNo, devName, modeId:4, streamIndex:1 });
        }
      } else {
        recordList.push({ devId, devNo, devName, modeId:mid });
      }
    });
  });
  recordList.sort((a,b)=>{
    if (a.devId !== b.devId) return a.devId - b.devId;
    if (a.modeId !== b.modeId) return a.modeId - b.modeId;
    return (a.streamIndex||0) - (b.streamIndex||0);
  });
  console.log('[SitePage][recordList] rebuilt size=', recordList.length);
  nextRecordCursor = 0;
}

function performFullOpen() {
  // 清空已有窗口实例
  for (let i=0;i<openLogical.length;i++){
    if (openLogical[i].__slot != null) releaseSlot(openLogical[i].__slot);
  }
  openLogical = [];
  visibleOrder = [];
  windowStart = 0;

  buildRecordListFromLastDevices();

  // 将全部 recordList 直接放入 openLogical（形成完整逻辑序列）
  for (let i=0;i<recordList.length;i++) {
    const r = recordList[i];
    openLogical.push({
      kind:'record',
      recordIndex:i,
      devId:r.devId,
      devNo:r.devNo,
      modeId:r.modeId,
      streamIndex:r.streamIndex||0,
      key: recordKey(r.devId, r.modeId, r.streamIndex||0),
      inst:null,
      __videoCleanup:null,
      __slot:undefined
    });
  }

  // 标记已“全部消费”recordList，箭头逻辑不再认为还有未加载的记录
  nextRecordCursor = recordList.length;

  // 仅渲染当前 windowStart 开头的 6 个
  renderVisible();
  updateArrowVisibility();
  updateIndexDisplay();
}

function recordKey(devId, modeId, streamIndex){
  return `${devId}:${modeId}:${streamIndex||0}`;
}

/* ========================================================================== *
 *  渲染 / 窗口管理
 * ========================================================================== */
// MOD: renderVisible 保持原逻辑，若需要首次 / 回退全量渲染；增量滚动路径已避免调用该函数导致的闪烁
function renderVisible() {
  const grid = document.getElementById('mediaGrid');
  if (!grid) return;
  const visible = [];
  if (!visibleOrder.length) {
    for (let i=0;i<6;i++) {
      const logicalIdx = windowStart + i;
      if (logicalIdx < openLogical.length) visible.push(logicalIdx);
    }
    visibleOrder = visible.slice();
  } else {
    visibleOrder = visibleOrder.filter(idx => idx >= windowStart && idx < windowStart + 6);
    for (let i=0;i<6 && visibleOrder.length<6;i++){
      const logicalIdx = windowStart + i;
      if (!visibleOrder.includes(logicalIdx) && logicalIdx < openLogical.length) {
        visibleOrder.push(logicalIdx);
      }
    }
  }

  for (let slot=0; slot<6; slot++) {
    const cellIdx = slot;
    const body = document.getElementById('mediaBody'+cellIdx);
    const title= document.getElementById('mediaTitle'+cellIdx);
    const hd   = body ? body.parentElement.querySelector('.sp-cell-hd') : null;

    const logicalIdx = visibleOrder[slot];
    if (logicalIdx == null) {
      if (body) {
        const any = openLogical.find(l=>l.__slot===cellIdx);
        if (any) {
          releaseSlot(cellIdx);
        }
        body.innerHTML = '<div style="color:#567;font-size:12px;">视频流/模式</div>';
        body.setAttribute('data-free','1');
      }
      if (title) title.textContent='';
      if (hd) hd.style.display='none';
      continue;
    }

    const entry = openLogical[logicalIdx];
    if (!entry) continue;
    if (entry.__slot != null && entry.__slot === cellIdx && entry.inst) continue;
    // 若 entry 在别的槽，释放旧槽
    if (entry.__slot != null && entry.__slot !== cellIdx) {
      releaseSlot(entry.__slot);
    }
    // 实例化/渲染
    __ensureEntryInst(entry, cellIdx);
  }
  updateIndexDisplay();
  updateArrowVisibility();
}

function openVideoInSlotAt(devId, devNo, streamIndex, slotIdx, logicalEntry) {
  devId = Number(devId);
  const body  = document.getElementById('mediaBody'+slotIdx);
  const title = document.getElementById('mediaTitle'+slotIdx);
  const hd    = body ? body.parentElement.querySelector('.sp-cell-hd') : null;
  if (hd && hd.style.display==='none') hd.style.display='flex';
  body.innerHTML='';
  body.setAttribute('data-free','0');

  // 获取名称（recordList > manual > 全局查询），名称为空回退编号
  const rec = (logicalEntry && logicalEntry.recordIndex!=null) ? recordList[logicalEntry.recordIndex] : null;
  const displayName = (rec && rec.devName) || (logicalEntry && logicalEntry.devName) || __lookupDevName(devId) || devNo || '';
  const nameOrNo = displayName || devNo;

  const streamLabel = streamIndex===1 ? '副码流' : '主码流';
  if (title) title.textContent = nameOrNo + ' ' + streamLabel;

  const thumb = createStreamThumbnail({
    container: body,
    devId,
    hardwareType:1,
    hardwareIndex: streamIndex===1 ? 1 : 0,
    createPreview: ()=>createVideoPreview({ objectFit:'fill' }),
    wantLow: true
  });

  logicalEntry.inst = thumb.preview;
  logicalEntry.__videoCleanup = () => thumb.destroy();
  logicalEntry.type='video';
  logicalEntry.devId = devId;
  logicalEntry.devNo = devNo;
  logicalEntry.devName = displayName;
  logicalEntry.modeId = 4;
  logicalEntry.streamIndex = streamIndex;

  const k = recordKey(devId, 4, streamIndex);
  window.__GLOBAL_VIDEO_REF[k] = (window.__GLOBAL_VIDEO_REF[k] || 0) + 1;
}

function openModeInSlotAt(devId, devNo, modeId, slotIdx, logicalEntry) {
  devId = Number(devId);
  const mid = Number(modeId);
  const body  = document.getElementById('mediaBody'+slotIdx);
  const title = document.getElementById('mediaTitle'+slotIdx);
  const hd    = body ? body.parentElement.querySelector('.sp-cell-hd') : null;
  if (hd && hd.style.display==='none') hd.style.display='flex';
  let mp;
  if      (mid === 1) mp = createModeTilt({ devId });
  else if (mid === 2) mp = createModeDispTilt({ devId });
  else if (mid === 3) mp = createModeAudio({ devId });
  else                mp = createModePreview({ modeId: mid, devId });

  body.innerHTML='';
  body.appendChild(mp.el);
  body.style.cursor='pointer';
  body.setAttribute('data-free','0');

  // 名称获取（同视频）
  const rec = (logicalEntry && logicalEntry.recordIndex!=null) ? recordList[logicalEntry.recordIndex] : null;
  const displayName = (rec && rec.devName) || (logicalEntry && logicalEntry.devName) || __lookupDevName(devId) || devNo || '';
  const nameOrNo = displayName || devNo;

  // 短模式名（去掉“模式”二字）
  function shortMode(mid){
    switch(Number(mid)){
      case 1: return '倾角';
      case 2: return '位移·倾角';
      case 3: return '音频';
      default: return '模式';
    }
  }
  if (title) title.textContent = nameOrNo + ' ' + shortMode(mid);

  logicalEntry.inst = mp;
  logicalEntry.type='mode';
  logicalEntry.devId= devId;
  logicalEntry.devNo= devNo;
  logicalEntry.devName = displayName;
  logicalEntry.modeId= mid;

  try { mp.start && mp.start(); } catch {}

  const k = recordKey(devId, mid, 0);
  window.__GLOBAL_MODE_REF[k] = (window.__GLOBAL_MODE_REF[k] || 0) + 1;
}

// MOD: 释放槽位实例时打印（用于滚动/淘汰）
function releaseSlot(slotIdx){
  const entry = openLogical.find(e => e.__slot === slotIdx);
  if (!entry) return;

  __logClose(entry, 'release');

  if (entry.type === 'video') {
    // 视频缩略：保留原清理
    try { entry.__videoCleanup && entry.__videoCleanup(); } catch {}
  } else if (entry.type === 'mode') {
    // 先逻辑关闭（立即退订），再 destroy
    try { entry.inst && entry.inst.setOpened && entry.inst.setOpened(false); } catch {}
    try { entry.inst && entry.inst.destroy && entry.inst.destroy(); } catch {}
  }

  entry.inst = null;
  entry.__videoCleanup = null;
  delete entry.__slot;
}

function updateArrowVisibility() {
  if (!rootEl) return;
  const prevBtn = rootEl.querySelector('#mediaNavPrev');
  const nextBtn = rootEl.querySelector('#mediaNavNext');
  if (!prevBtn || !nextBtn) return;

  const canLeft = windowStart > 0;
  const hasMoreRecordToAppend = nextRecordCursor < recordList.length;
  const canRight = (windowStart + 6) < openLogical.length || hasMoreRecordToAppend;

  prevBtn.style.display = canLeft ? '' : 'none';
  nextBtn.style.display = canRight ? '' : 'none';
}

function updateIndexDisplay() {
  if (!rootEl) return;
  const span = rootEl.querySelector('#windowIndexInfo');
  if (!span) return;
  const indices = [];
  for (let i=0;i<6;i++){
    const logicalIdx = visibleOrder[i];
    if (logicalIdx == null) {
      indices.push('-');
      continue;
    }
    const entry = openLogical[logicalIdx];
    if (!entry) { indices.push('-'); continue; }
    indices.push(entry.recordIndex != null ? entry.recordIndex : -1);
  }
  span.textContent = indices.join(',') + '/' + recordList.length;
}
// 强化版：仅在真正“未实例化”时创建；已有实例换槽位使用纯 DOM 迁移，不触发 releaseSlot
function __ensureEntryInst(entry, slotIdx){
  if (!entry) return;
  if (entry.__slot === slotIdx && entry.inst) return;

  if (entry.__slot != null && entry.inst && entry.__slot !== slotIdx) {
    __moveEntryDOM(entry, entry.__slot, slotIdx);
    return;
  }

  const body  = document.getElementById('mediaBody'+slotIdx);
  const title = document.getElementById('mediaTitle'+slotIdx);
  if (!body) return;
  const hd = body.parentElement.querySelector('.sp-cell-hd');

  const occupant = openLogical.find(e => e.__slot === slotIdx && e !== entry);
  if (occupant) {
    const occLogicalIdx = openLogical.indexOf(occupant);
    const desiredSlot = (occLogicalIdx >=0) ? (occLogicalIdx - windowStart) : -1;
    if (desiredSlot >=0 && desiredSlot < 6 && desiredSlot !== slotIdx && !openLogical.find(e=>e.__slot===desiredSlot)) {
      __moveEntryDOM(occupant, slotIdx, desiredSlot);
    } else {
      let free = -1;
      for (let s=0; s<6; s++) {
        if (!openLogical.find(e=>e.__slot === s)) { free = s; break; }
      }
      if (free >=0) {
        __moveEntryDOM(occupant, slotIdx, free);
      } else {
        if (desiredSlot < 0 || desiredSlot > 5) {
          releaseSlot(slotIdx);
        } else {
          releaseSlot(slotIdx);
        }
      }
    }
  }

  body.innerHTML = '';
  body.setAttribute('data-free','0');
  if (hd && hd.style.display==='none') hd.style.display='flex';

  if (entry.kind === 'record') {
    const r = recordList[entry.recordIndex];
    if (!r) {
      body.innerHTML='<div style="color:#a55;font-size:12px;">记录缺失</div>';
      body.setAttribute('data-free','1');
      if (title) title.textContent='';
      return;
    }
    if (r.modeId === 4) {
      openVideoInSlotAt(r.devId, r.devNo, r.streamIndex||0, slotIdx, entry);
    } else {
      openModeInSlotAt(r.devId, r.devNo, r.modeId, slotIdx, entry);
    }
  } else {
    if (entry.modeId === 4) {
      openVideoInSlotAt(entry.devId, entry.devNo, entry.streamIndex||0, slotIdx, entry);
    } else {
      openModeInSlotAt(entry.devId, entry.devNo, entry.modeId, slotIdx, entry);
    }
  }

  entry.__slot = slotIdx;
  __logOpen(entry, entry.kind === 'manual' ? 'MANUAL' : 'AUTO');
}
// MOD: 向右滚动（保留原逻辑增减 openLogical 的部分，替换 renderVisible 为增量 DOM 移动）
function scrollRight() {
  if (windowStart + 6 >= openLogical.length) {
    updateArrowVisibility();
    return;
  }
  const originalWindowStart = windowStart;
  windowStart++;

  // 增量方式：将 0 槽释放，1..5 向左移动，最后补 windowStart+5 对应逻辑
  if (!visibleOrder.length || originalWindowStart !== windowStart - 1) {
    // 回退全量（首次或异常）
    visibleOrder = [];
    renderVisible();
    return;
  }

  // 1. 释放离开视窗的槽位 0
  const leaving = openLogical.find(e=>e.__slot===0);
  if (leaving) {
    releaseSlot(0);
  }

  // 2. 移动 1..5 -> 0..4
  for (let s=0; s<5; s++) {
    const moving = openLogical.find(e=>e.__slot===s+1);
    if (moving) __moveEntryDOM(moving, s+1, s);
  }

  // 3. 补第 5 槽：逻辑索引 = windowStart + 5
  const targetLogicalIdx = windowStart + 5;
  if (targetLogicalIdx < openLogical.length) {
    const entry = openLogical[targetLogicalIdx];
    if (entry) __ensureEntryInst(entry, 5);
  } else {
    // 不存在则清空槽 5
    const b = document.getElementById('mediaBody5');
    const t = document.getElementById('mediaTitle5');
    const hd= b ? b.parentElement.querySelector('.sp-cell-hd') : null;
    if (b) {
      b.innerHTML='<div style="color:#567;font-size:12px;">视频流/模式</div>';
      b.setAttribute('data-free','1');
    }
    if (t) t.textContent='';
    if (hd) hd.style.display='none';
  }

  // 4. 重建 visibleOrder
  const newVis = [];
  for (let s=0;s<6;s++){
    const e = openLogical.find(en=>en.__slot===s);
    if (!e) continue;
    const li = openLogical.indexOf(e);
    if (li>=0) newVis.push(li);
  }
  visibleOrder = newVis;

  updateIndexDisplay();
  updateArrowVisibility();
  try { console.log(`[SitePage][SCROLL][RIGHT] windowStart=${windowStart} visibleOrder=[${visibleOrder.join(',')}]`); } catch {}
}

// MOD: 向左滚动（增量 DOM 移动，不重建保留实例）
function scrollLeft() {
  if (windowStart === 0) {
    updateArrowVisibility();
    return;
  }
  const originalWindowStart = windowStart;
  windowStart--;

  if (!visibleOrder.length || originalWindowStart !== windowStart + 1) {
    visibleOrder = [];
    renderVisible();
    return;
  }

  // 1. 释放离开视窗的槽位 5
  const leaving = openLogical.find(e=>e.__slot===5);
  if (leaving) {
    releaseSlot(5);
  }

  // 2. 移动 4..0 -> 5..1 (逆向)
  for (let s=5; s>0; s--) {
    const moving = openLogical.find(e=>e.__slot===s-1);
    if (moving) __moveEntryDOM(moving, s-1, s);
  }

  // 3. 补槽位 0
  const targetLogicalIdx = windowStart;
  if (targetLogicalIdx < openLogical.length) {
    const entry = openLogical[targetLogicalIdx];
    if (entry) __ensureEntryInst(entry, 0);
  } else {
    const b = document.getElementById('mediaBody0');
    const t = document.getElementById('mediaTitle0');
    const hd= b ? b.parentElement.querySelector('.sp-cell-hd') : null;
    if (b) {
      b.innerHTML='<div style="color:#567;font-size:12px;">视频流/模式</div>';
      b.setAttribute('data-free','1');
    }
    if (t) t.textContent='';
    if (hd) hd.style.display='none';
  }

  // 4. 重建 visibleOrder
  const newVis = [];
  for (let s=0;s<6;s++){
    const e = openLogical.find(en=>en.__slot===s);
    if (!e) continue;
    const li = openLogical.indexOf(e);
    if (li>=0) newVis.push(li);
  }
  visibleOrder = newVis;

  updateIndexDisplay();
  updateArrowVisibility();
  try { console.log(`[SitePage][SCROLL][LEFT] windowStart=${windowStart} visibleOrder=[${visibleOrder.join(',')}]`); } catch {}
}

function pruneHiddenManual() {
  // const start = windowStart;
  // const end = windowStart + 5;
  // for (let i=openLogical.length-1;i>=0;i--){
  //   const e = openLogical[i];
  //   if (e.kind === 'manual') {
  //     if (i < start || i > end) {
  //       if (e.__slot != null) releaseSlot(e.__slot);
  //       openLogical.splice(i,1);
  //       if (i < windowStart) windowStart--;
  //     }
  //   }
  // }
}

/* ========================================================================== *
 *  手动打开入口重写
 * ========================================================================== */
async function openVideoInSlot(devId, devNo, stream = 'main') {
  const streamIndex = (stream === 'sub' || stream === 1) ? 1 : 0;
  handleManualOpen(devId, devNo, 4, streamIndex);
}

function openModeInSlot(devId, devNo, modeId) {
  const mid = Number(modeId);
  if (mid === 4) {
    openVideoInSlot(devId, devNo, 'main');
    return;
  }
  handleManualOpen(devId, devNo, mid, 0);
}

// 新增：确保某个逻辑索引在当前 6 槽窗口范围内；只调整 windowStart，不做渲染。
// 之后调用方根据需要再调用 reflowVisible()（推荐）或 renderVisible()。
function ensureIndexVisible(logicalIdx) {
  if (logicalIdx < 0 || logicalIdx >= openLogical.length) return;
  if (logicalIdx < windowStart) {
    windowStart = logicalIdx;
  } else if (logicalIdx > windowStart + 5) {
    windowStart = Math.max(0, logicalIdx - 5);
  }
  // 防越界（删除后可能出现 windowStart 超过最大起点）
  const maxStart = Math.max(0, openLogical.length - 6);
  if (windowStart > maxStart) windowStart = maxStart;
}

// 重写：手动/外部触发打开模式/视频（避免全量 renderVisible 引发的闪烁）
// 逻辑：
//   1. 若已存在 -> 仅滚动至可视 + reflowVisible（不销毁其它实例）
//   2. 若对应自动记录（recordList 中存在且 openLogical 中已有）-> 直接滚动显示
//   3. 否则作为新手动条目追加（默认追加到末尾），再最小化布局刷新
//   4. 使用 reflowVisible() 做“按需移动/实例化”而不是 renderVisible()，防止其它窗口被释放重建
function handleManualOpen(devId, devNo, modeId, streamIndex) {
  devId = Number(devId);
  const streamIdx = streamIndex || 0;
  const key = recordKey(devId, modeId, streamIdx);

  const existingIdx = openLogical.findIndex(e => e.key === key);
  if (existingIdx >= 0) {
    ensureIndexVisible(existingIdx);
    reflowVisible();
    updateArrowVisibility();
    updateIndexDisplay();
    eventBus.emit('toast:show', { type:'info', message:'已打开' });
    return;
  }

  const recordIdx = recordList.findIndex(r =>
    r.devId === devId &&
    r.modeId === modeId &&
    (r.streamIndex || 0) === streamIdx
  );
  if (recordIdx >= 0) {
    const recordLogicalIdx = openLogical.findIndex(e => e.kind === 'record' && e.recordIndex === recordIdx);
    if (recordLogicalIdx >= 0) {
      ensureIndexVisible(recordLogicalIdx);
      reflowVisible();
      updateArrowVisibility();
      updateIndexDisplay();
      eventBus.emit('toast:show', { type:'info', message:'已存在' });
      return;
    }
  }

  const newEntry = {
    kind: 'manual',
    recordIndex: -1,
    devId,
    devNo,
    devName: __lookupDevName(devId) || '',
    modeId,
    streamIndex: streamIdx,
    key,
    inst: null,
    __videoCleanup: null,
    __slot: undefined
  };
  openLogical.push(newEntry);

  const newLogicalIdx = openLogical.length - 1;
  ensureIndexVisible(newLogicalIdx);

  reflowVisible();
  updateArrowVisibility();
  updateIndexDisplay();
}

function insertRecordLogical(recordIndex){
  if (openLogical.some(e=>e.kind==='record' && e.recordIndex===recordIndex)) return;
  const r = recordList[recordIndex];
  openLogical.push({
    kind:'record',
    recordIndex,
    devId:r.devId, devNo:r.devNo,
    modeId:r.modeId,
    streamIndex:r.streamIndex||0,
    key: recordKey(r.devId, r.modeId, r.streamIndex||0),
    inst:null,__videoCleanup:null
  });
  if (recordIndex >= nextRecordCursor) nextRecordCursor = recordIndex + 1;
}
// MOD: 新增 - 移动窗口 DOM 与状态（不销毁实例，不重建数据）
function __moveEntryDOM(entry, fromSlot, toSlot){
  if(!entry) return;
  if(entry.__slot !== fromSlot){
    eventBus.emit('toast:show',{ type:'warn', message:'窗口移动异常：槽位不一致'});
    return;
  }
  if(fromSlot === toSlot) return;
  const fromBody  = document.getElementById('mediaBody'+fromSlot);
  const toBody    = document.getElementById('mediaBody'+toSlot);
  const fromTitle = document.getElementById('mediaTitle'+fromSlot);
  const toTitle   = document.getElementById('mediaTitle'+toSlot);
  const fromHd    = fromBody ? fromBody.parentElement.querySelector('.sp-cell-hd') : null;
  const toHd      = toBody ? toBody.parentElement.querySelector('.sp-cell-hd') : null;
  if(!fromBody || !toBody){
    eventBus.emit('toast:show',{ type:'warn', message:'窗口移动失败：DOM缺失'});
    return;
  }

  // 清空目标槽
  toBody.innerHTML='';
  toBody.setAttribute('data-free','0');
  if(toHd && toHd.style.display==='none') toHd.style.display='flex';

  // 迁移内容
  while(fromBody.firstChild){
    toBody.appendChild(fromBody.firstChild);
  }
  // 迁移标题
  if(toTitle && fromTitle) toTitle.textContent = fromTitle.textContent;

  // 调整关闭按钮 data-close
  const toCloseBtn = toHd ? toHd.querySelector('[data-close]') : null;
  if(toCloseBtn) toCloseBtn.setAttribute('data-close', String(toSlot));

  // 将源槽位置为空
  fromBody.innerHTML = '<div style="color:#567;font-size:12px;">视频流/模式</div>';
  fromBody.setAttribute('data-free','1');
  if(fromTitle) fromTitle.textContent='';
  if(fromHd) fromHd.style.display='none';

  entry.__slot = toSlot;
}

// 强化版 reflowVisible：严格保证 0..5 槽连续填充逻辑窗口；只移动/最小化实例化；不重复释放可见窗口
function reflowVisible() {
  const maxVisible = windowStart + 5;

  // 1. 期望槽位 -> 目标逻辑条目数组
  const desired = [];
  for (let s=0; s<6; s++) {
    const li = windowStart + s;
    desired[s] = li < openLogical.length ? openLogical[li] : null;
  }

  // 2. 先把已经在错误槽位但仍然可见的条目挪到正确位置（可减少后续冲突）
  for (let s=0; s<6; s++) {
    const targetEntry = desired[s];
    if (!targetEntry) continue;
    if (targetEntry.__slot != null && targetEntry.__slot !== s) {
      // 如果目标槽已被其它 entry 占用且那个 entry 也是可见且未到它自己的槽位，暂时跳过，后续它被挪走后再补
      const occupant = openLogical.find(e => e.__slot === s);
      if (occupant && occupant !== targetEntry) {
        const occLi = openLogical.indexOf(occupant);
        const occDesired = occLi - windowStart;
        if (occDesired >=0 && occDesired <6 && occDesired !== s) {
          // 让占位者先去自己的位置（若空）
          if (!openLogical.find(e=>e.__slot === occDesired)) {
            __moveEntryDOM(occupant, s, occDesired);
          }
        }
      }
      // 再次检查目标槽是否空闲
      if (!openLogical.find(e=>e.__slot === s)) {
        __moveEntryDOM(targetEntry, targetEntry.__slot, s);
      }
    }
  }

  // 3. 为每个槽位确保实例存在或清空
  for (let s=0; s<6; s++) {
    const targetEntry = desired[s];
    const occupant = openLogical.find(e => e.__slot === s);
    if (!targetEntry) {
      // 不需要显示 -> 清空（如果有占用且它逻辑不在范围则释放）
      if (occupant) {
        const occLi = openLogical.indexOf(occupant);
        if (occLi < windowStart || occLi > maxVisible) {
          releaseSlot(s);
          const body = document.getElementById('mediaBody'+s);
          const title= document.getElementById('mediaTitle'+s);
            const hd = body ? body.parentElement.querySelector('.sp-cell-hd') : null;
          if (body) {
            body.innerHTML='<div style="color:#567;font-size:12px;">视频流/模式</div>';
            body.setAttribute('data-free','1');
          }
          if (title) title.textContent='';
          if (hd) hd.style.display='none';
        }
      } else {
        // 没占用保持空
        const body = document.getElementById('mediaBody'+s);
        if (body && body.getAttribute('data-free') !== '1') {
          const title= document.getElementById('mediaTitle'+s);
          const hd = body ? body.parentElement.querySelector('.sp-cell-hd') : null;
          body.innerHTML='<div style="color:#567;font-size:12px;">视频流/模式</div>';
          body.setAttribute('data-free','1');
          if (title) title.textContent='';
          if (hd) hd.style.display='none';
        }
      }
      continue;
    }

    // 需要显示
    if (targetEntry.__slot === s) {
      // 已就位
      continue;
    }
    if (targetEntry.__slot != null) {
      // 就位于别的槽（应该在第 2 步被挪动，如果仍存在冲突，此时强制移动/交换）
      const occ = openLogical.find(e => e.__slot === s);
      if (occ && occ !== targetEntry) {
        // 尝试把占位者送去它的目标槽
        const occLi = openLogical.indexOf(occ);
        const occDesired = occLi - windowStart;
        if (occDesired >=0 && occDesired < 6 && !openLogical.find(e=>e.__slot === occDesired)) {
          __moveEntryDOM(occ, s, occDesired);
        } else {
          // 找个空槽
            let free = -1;
            for (let t=0;t<6;t++){
              if (!openLogical.find(e=>e.__slot === t)) { free = t; break; }
            }
            if (free >=0) {
              __moveEntryDOM(occ, s, free);
            } else {
              // 实在没位置：释放占位者（它会在后续自己的槽位再次被实例化）
              releaseSlot(s);
            }
        }
      }
      if (targetEntry.__slot != null && targetEntry.__slot !== s) {
        __moveEntryDOM(targetEntry, targetEntry.__slot, s);
      }
      continue;
    }

    // 尚未实例化 -> 直接实例化（槽位若有无关占用，上面逻辑已处理）
    __ensureEntryInst(targetEntry, s);
  }

  // 4. 第二次清理：释放仍然占用槽位但逻辑不在当前窗口范围的 entry（保险）
  openLogical.forEach(e=>{
    if (e.__slot == null) return;
    const li = openLogical.indexOf(e);
    if (li < windowStart || li > maxVisible) {
      releaseSlot(e.__slot);
    }
  });

  // 5. 重建 visibleOrder
  const newVis = [];
  for (let s=0;s<6;s++){
    const e = openLogical.find(en=>en.__slot===s);
    if (e) {
      const li = openLogical.indexOf(e);
      if (li>=0) newVis.push(li);
    }
  }
  visibleOrder = newVis;

  updateIndexDisplay();
  updateArrowVisibility();
  try {
    const { summary, total } = __openLogicalSummaryWithCount
      ? __openLogicalSummaryWithCount()
      : { summary: __dumpOpenLogicalSummaryNew(), total: openLogical.length };
    console.log(`[SitePage][REFLOW] windowStart=${windowStart} visibleOrder=[${visibleOrder.join(',')}] openLogicalSize=${openLogical.length} summary=${summary} totalModes=${total}`);
  } catch {}
}


// 重写：closeSlot —— 纯压缩 + 最少操作（不触发其它窗口重建，不闪烁）
// 说明：
//   1. 仅释放被关闭窗口的实例；
//   2. 从 openLogical 中移除对应逻辑条目；
//   3. 根据剩余 openLogical 和 windowStart 调整（若末尾不足则回退 windowStart）；
//   4. 调用 reflowVisible() 让右侧窗口整体左移并按需补足；
//   5. 全程不对未受影响的可见窗口做销毁与重建。
function closeSlot(idx) {
  const entry = openLogical.find(e => e.__slot === idx);
  if (!entry) {
    // 兜底：槽位 DOM 可能仍显示残留
    const body = document.getElementById('mediaBody' + idx);
    if (body && body.getAttribute('data-free') !== '1') {
      const title = document.getElementById('mediaTitle' + idx);
      const hd = body ? body.parentElement.querySelector('.sp-cell-hd') : null;
      body.innerHTML = '<div style="color:#567;font-size:12px;">视频流/模式</div>';
      body.setAttribute('data-free', '1');
      if (title) title.textContent = '';
      if (hd) hd.style.display = 'none';
    }
    return;
  }

  // 1. 日志（关闭前）
  __logClose(entry, 'user');

  // 2. 释放该实例（不影响其它）
  if (entry.__slot != null) {
    releaseSlot(entry.__slot); // 将清除 __slot
  }

  // 3. 从逻辑数组移除
  const logicalIdx = openLogical.indexOf(entry);
  if (logicalIdx >= 0) {
    openLogical.splice(logicalIdx, 1);
  }

  // 4. 修正 windowStart 避免越界
  if (windowStart > Math.max(0, openLogical.length - 6)) {
    windowStart = Math.max(0, openLogical.length - 6);
  }

  // 5. 可视区域重新布局（移动 + 按需实例化）
  reflowVisible();
}

function closeAllWindowsAndClearRecords(clearRecord) {
  for (let i=0;i<openLogical.length;i++){
    if (openLogical[i].__slot != null) releaseSlot(openLogical[i].__slot);
  }
  openLogical = [];
  visibleOrder = [];
  windowStart = 0;
  if (clearRecord) {
    recordList = [];
    nextRecordCursor = 0;
  }
  for (let slot=0;slot<6;slot++){
    const body = document.getElementById('mediaBody'+slot);
    const title= document.getElementById('mediaTitle'+slot);
    const hd   = body ? body.parentElement.querySelector('.sp-cell-hd') : null;
    if (body) {
      body.innerHTML='<div style="color:#567;font-size:12px;">视频流/模式</div>';
      body.setAttribute('data-free','1');
    }
    if (title) title.textContent='';
    if (hd) hd.style.display='none';
  }
  updateIndexDisplay();
  updateArrowVisibility();
}

/* ========================================================================== *
 *  拖拽重排 & 点击打开详情
 * ========================================================================== */
function enableGridDragReorder(grid) {
  if (!grid) return;
  Array.from(grid.querySelectorAll('.sp-cell-hd')).forEach(hd=>{
    hd.setAttribute('draggable', 'true');
    const btn = hd.querySelector('[data-close]');
    if (btn) {
      btn.setAttribute('draggable', 'false');
      btn.addEventListener('dragstart', e=>e.stopPropagation());
      btn.addEventListener('mousedown', e=>e.stopPropagation());
    }
  });

  let dragSrcCell = null;
  let dragOverCell = null;
  let headerDragging = false;
  let suppressHeaderClickUntil = 0;

  const showMoveCursor = on => {
    const v = on ? 'move' : '';
    try { document.documentElement.style.cursor = v; } catch {}
    try { document.body.style.cursor = v; } catch {}
  };
  const releaseMoveCursor = () => showMoveCursor(false);

  grid.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const hd = e.target.closest('.sp-cell-hd');
    if (!hd) return;
    if (e.target.closest('[data-close]')) return;
    showMoveCursor(true);
  }, true);
  window.addEventListener('mouseup', releaseMoveCursor, true);

  grid.addEventListener('dragstart', e => {
    const hd = e.target.closest('.sp-cell-hd');
    if (!hd || e.target.closest('[data-close]')) { e.preventDefault(); return; }
    dragSrcCell = hd.closest('.sp-cell');
    if (!dragSrcCell) return;
    try { e.dataTransfer.setData('text/plain', dragSrcCell.getAttribute('data-idx') || ''); } catch {}
    e.dataTransfer.effectAllowed = 'move';
    dragSrcCell.classList.add('dragging');
    headerDragging = true;
    showMoveCursor(true);
  });

  grid.addEventListener('dragend', () => {
    if (dragSrcCell) dragSrcCell.classList.remove('dragging');
    if (dragOverCell) dragOverCell.classList.remove('drag-target');
    dragSrcCell = null; dragOverCell = null;
    headerDragging = false;
    suppressHeaderClickUntil = performance.now() + 180;
    releaseMoveCursor();
    updateIndexDisplay();
  });

  grid.addEventListener('dragover', e => {
    if (!dragSrcCell) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const cell = e.target.closest('.sp-cell');
    if (!cell || cell === dragSrcCell) {
      if (dragOverCell) dragOverCell.classList.remove('drag-target');
      dragOverCell = null;
      return;
    }
    if (dragOverCell !== cell) {
      if (dragOverCell) dragOverCell.classList.remove('drag-target');
      dragOverCell = cell;
      dragOverCell.classList.add('drag-target');
    }
  });

  grid.addEventListener('drop', e => {
    if (!dragSrcCell) return;
    e.preventDefault();
    const targetCell = e.target.closest('.sp-cell');
    if (!targetCell || targetCell === dragSrcCell) return;
    const rect = targetCell.getBoundingClientRect();
    const insertAfter = (e.clientX > rect.left + rect.width / 2);
    const parent = grid;
    if (insertAfter) {
      const ref = targetCell.nextElementSibling;
      parent.insertBefore(dragSrcCell, ref);
    } else {
      parent.insertBefore(dragSrcCell, targetCell);
    }
    dragSrcCell.classList.remove('dragging');
    if (dragOverCell) dragOverCell.classList.remove('drag-target');

    // 计算新的可见逻辑顺序
    const newOrderLogical = [];
    Array.from(parent.children).forEach(cell=>{
      const slotIdx = Number(cell.getAttribute('data-idx'));
      const entry = openLogical.find(e => e.__slot === slotIdx);
      if (!entry) return;
      const logicalIndex = openLogical.indexOf(entry);
      if (logicalIndex >=0) newOrderLogical.push(logicalIndex);
    });

    while (newOrderLogical.length < 6) newOrderLogical.push(undefined);
    visibleOrder = newOrderLogical;

    // 同步更新 openLogical 的全局顺序（仅调整当前窗口范围内的条目相对顺序）
    const windowLogicalIndices = [];
    for (let i=0;i<6;i++){
      const li = windowStart + i;
      if (li < openLogical.length) windowLogicalIndices.push(li);
    }
    // 映射：逻辑索引 -> entry
    const indexToEntry = new Map();
    windowLogicalIndices.forEach(li => indexToEntry.set(li, openLogical[li]));

    // 构造新的顺序（仅替换窗口部分）
    const reorderedEntries = [];
    newOrderLogical.forEach(li => {
      if (typeof li === 'number' && indexToEntry.has(li)) {
        reorderedEntries.push(indexToEntry.get(li));
      }
    });
    // 追加那些仍在窗口但未被 newOrderLogical（理论上不会发生）
    windowLogicalIndices.forEach(li => {
      const e = indexToEntry.get(li);
      if (e && !reorderedEntries.includes(e)) reorderedEntries.push(e);
    });

    // 应用到 openLogical
    for (let i=0;i<reorderedEntries.length;i++){
      const globalIdx = windowStart + i;
      if (globalIdx < openLogical.length) {
        openLogical[globalIdx] = reorderedEntries[i];
      }
    }

    dragSrcCell = null; dragOverCell = null;
    headerDragging = false;
    suppressHeaderClickUntil = performance.now() + 180;
    releaseMoveCursor();
    updateIndexDisplay();
  });

  grid.__wasHeaderDraggedRecently__ = () => headerDragging || performance.now() < suppressHeaderClickUntil;
}

function enableGridClickOpen(grid) {
  if (!grid) return;

  grid.addEventListener('mouseover', e => {
    const hd = e.target.closest('.sp-cell-hd');
    if (hd) { hd.style.cursor = 'pointer'; return; }
    const body = e.target.closest('.sp-cell-bd');
    if (body) body.style.cursor = 'pointer';
  }, true);

  grid.addEventListener('mouseout', e => {
    const hd = e.target.closest('.sp-cell-hd');
    if (hd) hd.style.cursor = '';
    const body = e.target.closest('.sp-cell-bd');
    if (body) body.style.cursor = '';
  }, true);

  grid.addEventListener('click', e => {
    const hd = e.target.closest('.sp-cell-hd');
    if (!hd) return;
    if (typeof grid.__wasHeaderDraggedRecently__ === 'function' && grid.__wasHeaderDraggedRecently__()) return;
    if (e.target.closest('[data-close]')) return;
    const cell = hd.closest('.sp-cell');
    if (!cell) return;
    const idx = Number(cell.getAttribute('data-idx'));
    const entry = openLogical.find(en => en.__slot === idx);
    if (!entry) return;
    if (entry.modeId === 4) {
      if (!entry.inst || !entry.inst.hasFirstFrame) {
        eventBus.emit('toast:show', { type:'info', message:'视频加载中，暂不能进入详情' });
        return;
      }
      openVideoDetailOverlay(entry.devId, entry.devNo, entry.streamIndex===1?'sub':'main');
    } else {
      openModeDetailOverlay(entry.devId, entry.devNo, entry.modeId);
    }
  }, true);

  grid.addEventListener('click', e => {
    const body = e.target.closest('.sp-cell-bd');
    if (!body) return;
    const cell = body.closest('.sp-cell'); if (!cell) return;
    const idx = Number(cell.getAttribute('data-idx'));
    const entry = openLogical.find(en => en.__slot === idx);
    if (!entry) return;

    try {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (path && path.some(n => n && n.getAttribute && n.hasAttribute('data-refresh-btn'))) return;
    } catch {}

    if (entry.modeId === 4) {
      if (!entry.inst || !entry.inst.hasFirstFrame) {
        eventBus.emit('toast:show', { type:'info', message:'视频加载中，暂不能进入详情' });
        return;
      }
      try { requestHighQuality(entry.devId, 1, entry.streamIndex===1 ? 1 : 0); } catch {}
      openVideoDetailOverlay(entry.devId, entry.devNo, entry.streamIndex===1?'sub':'main');
    } else {
      const instEl = entry.inst && entry.inst.el;
      if (instEl && (instEl.dataset.suspended === '1' || !instEl.dataset.hasData)) {
        eventBus.emit('toast:show', { type:'info', message:'暂无数据，无法进入详情' });
        return;
      }
      openModeDetailOverlay(entry.devId, entry.devNo, entry.modeId);
    }
  }, true);
}

/* ========================================================================== *
 *  数据装配
 * ========================================================================== */
async function bootstrapData(summaryEl, notifyEl) {
  const [typesRes, modesRes, onlineRes, summaryRes] = await Promise.allSettled([
    apiDevTypes(),
    apiDevModes(),
    apiOnlineList(),
    apiDeviceSummary()
  ]);

  const types   = typesRes.status==='fulfilled' ? (typesRes.value || {}) : {};
  const modes   = modesRes.status==='fulfilled' ? (modesRes.value || {}) : {};
  const online  = onlineRes.status==='fulfilled' ? (onlineRes.value || {}) : { list: [] };
  const summary = summaryRes.status==='fulfilled' ? (summaryRes.value || {}) : { stateList: [] };

  let filters = {};
  try { filters = getFiltersFromTree(); siteState.set({ filters }); } catch {}

  function computeTypeArr(devType) {
    const allowedTypeIds = Array.isArray(types.devTypeList)
      ? types.devTypeList.map(t => Number(t.typeId)).filter(Boolean)
      : [1,2,3,4];
    return Number(devType) === 0 ? allowedTypeIds : [Number(devType)].filter(Boolean);
  }
  function computeModeArr(devType, devMode, devModeIdArr) {
    if (Array.isArray(devModeIdArr) && devModeIdArr.length) return devModeIdArr;
    const dm = Number(devMode || 0);
    const dt = Number(devType || 0);
    if (dm > 0) return [dm];
    if (dt === 4) return [4];
    if (dt === 0) return [1,2,3,4];
    return [1,2,3];
  }

  const [groupedRes, ungroupedRes] = await Promise.allSettled([
    apiGroupedDevices({
      searchStr: filters.searchStr,
      filterOnline: filters.filterOnline,
      devTypeIdArr: computeTypeArr(filters.devType),
      devModeIdArr: computeModeArr(filters.devType, filters.devMode, filters.devModeIdArr)
    }),
    apiUngroupedDevices({
      searchStr: filters.searchStr,
      filterOnline: filters.filterOnline,
      devTypeIdArr: computeTypeArr(filters.devType),
      devModeIdArr: computeModeArr(filters.devType, filters.devMode, filters.devModeIdArr)
    })
  ]);

  const grouped   = groupedRes.status==='fulfilled'
    ? (groupedRes.value || { userList:[], devList:[] })
    : { userList:[], devList:[] };
  const ungrouped = ungroupedRes.status==='fulfilled'
    ? (ungroupedRes.value || { devList:[] })
    : { devList:[] };

  reRoot(grouped);

  try {
    tree.setData({
      userList: grouped.userList || [],
      devList: grouped.devList || [],
      ungroupedDevices: ungrouped.devList || [],
      expandLevel: 2,
      devTypes: (types.devTypeList || []),
      devModes: (modes.devModeList || [])
    });
  } catch {}

  try {
    const all = [].concat(grouped.devList || [], ungrouped.devList || []);
    mapView.setMarkers(all);
  } catch {}

  try { renderSummary(summaryEl, summary); } catch {}
  try { renderNotify(notifyEl, (online.list || []).slice(0,50)); } catch {}

  try {
    window.__LAST_SITE_DEVS = []
      .concat(grouped.devList || [])
      .concat(ungrouped.devList || []);
  } catch {}
}

async function reloadByFilters() {
  let filters = {};
  try { filters = getFiltersFromTree(); siteState.set({ filters }); } catch {}

  const typesRes = await apiDevTypes()
    .catch(() => ({ devTypeList: [{typeId:1},{typeId:2},{typeId:3},{typeId:4}] }));
  const allTypeIds = Array.isArray(typesRes.devTypeList)
    ? typesRes.devTypeList.map(t=>Number(t.typeId)).filter(Boolean)
    : [1,2,3,4];

  function computeTypeArr(devType) {
    return Number(devType) === 0 ? allTypeIds : [Number(devType)].filter(Boolean);
  }
  function computeModeArr(devType, devMode, devModeIdArr) {
    if (Array.isArray(devModeIdArr) && devModeIdArr.length) return devModeIdArr;
    const dm = Number(devMode || 0);
    const dt = Number(devType || 0);
    if (dm > 0) return [dm];
    if (dt === 4) return [4];
    if (dt === 0) return [1,2,3,4];
    return [1,2,3];
  }

  const [groupedRes, ungroupedRes] = await Promise.allSettled([
    apiGroupedDevices({
      searchStr: filters.searchStr,
      filterOnline: filters.filterOnline,
      devTypeIdArr: computeTypeArr(filters.devType),
      devModeIdArr: computeModeArr(filters.devType, filters.devMode, filters.devModeIdArr)
    }),
    apiUngroupedDevices({
      searchStr: filters.searchStr,
      filterOnline: filters.filterOnline,
      devTypeIdArr: computeTypeArr(filters.devType),
      devModeIdArr: computeModeArr(filters.devType, filters.devMode, filters.devModeIdArr)
    })
  ]);

  const grouped   = groupedRes.status==='fulfilled'
    ? (groupedRes.value || { userList:[], devList:[] })
    : { userList:[], devList:[] };
  const ungrouped = ungroupedRes.status==='fulfilled'
    ? (ungroupedRes.value || { devList:[] })
    : { devList:[] };

  reRoot(grouped);

  try {
    tree.setData({
      userList: grouped.userList || [],
      devList: grouped.devList || [],
      ungroupedDevices: ungrouped.devList || [],
      expandLevel: 2
    });
  } catch {}

  try {
    const all = [].concat(grouped.devList || [], ungrouped.devList || []);
    mapView.setMarkers(all);
  } catch {}

  try {
    window.__LAST_SITE_DEVS = []
      .concat(grouped.devList || [])
      .concat(ungrouped.devList || []);
  } catch {}
}

function reRoot(grouped){
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
}

/* ========================================================================== *
 *  通知轮询
 * ========================================================================== */
function startNotifyPoll(el) {
  if (notifyTimer) clearInterval(notifyTimer);
  notifyTimer = setInterval(async () => {
    try {
      const onlineRes = await apiOnlineList();
      renderNotify(el, (onlineRes.list || []).slice(0,50));
    } catch {}
  }, 5000);
}

/* ========================================================================== *
 *  渲染辅助
 * ========================================================================== */
function renderSummary(el, summary) {
  const list = (summary && summary.stateList) || [];
  if (!el) return;
  el.innerHTML = list.map(item=>{
    const offline = item.total - item.onlineCount;
    return `<div style="margin:6px 0;">
      <div style="font-size:12px;margin-bottom:4px;">${escapeHTML(item.typeName || '')}</div>
      <div style="display:flex;gap:4px;height:16px;">
        <div style="flex:${item.onlineCount||0};background:#3d89ff;color:#fff;text-align:center;font-size:11px;line-height:16px;border-radius:3px;">${item.onlineCount||0}</div>
        <div style="flex:${offline||0};background:#324153;color:#dde;text-align:center;font-size:11px;line-height:16px;border-radius:3px;">${offline||0}</div>
      </div>
    </div>`;
  }).join('');
}
function renderNotify(el, list) {
  if (!el) return;
  el.innerHTML = (list || []).map(l=>{
    const name = l.uname || l.uid;
    return `<div style="padding:4px 0;border-bottom:1px dashed rgba(255,255,255,.06);font-size:12px;">
      ${fmt(l.time)} ${escapeHTML(String(name))} ${l.online ? '上线' : '下线'}
    </div>`;
  }).join('');
}

/* ========================================================================== *
 *  通用工具
 * ========================================================================== */
function debounce(fn, wait){ let t; return function(){ const args=arguments; clearTimeout(t); t=setTimeout(()=>fn.apply(null,args), wait||300); }; }
function getFiltersFromTree(){ return tree.getFilterValues(); }
function escapeHTML(str){ return String(str||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmt(ts){ if(!ts) return ''; const d=new Date(ts); const p=n=>n<10?'0'+n:n; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }
function bindTreeDeviceClick(treeEl){
  const handler = async e =>{
    const devId = (e && e.detail && (e.detail.devId || e.detail.id)) || e.devId || e.id;
    const devNo = (e && e.detail && (e.detail.devNo || e.detail.no)) || e.devNo || e.no;
    const lastLocation = e && e.detail && e.detail.lastLocation;
    if (!devId) { console.warn('[Site][tree] device click missing devId', e); return; }
    try{
      const data = await apiDeviceInfo(devId);
      mapView.openDevice({ devInfo:(data && data.devInfo)?data.devInfo:{ id:devId, no:devNo, lastLocation }, followCenterWhenNoLocation:true });
    }catch{
      mapView.openDevice({ devInfo:{ id:devId, no:devNo, lastLocation }, followCenterWhenNoLocation:true });
    }
  };
  ['deviceclick','deviceClick','devclick','dev:click'].forEach(evt=>{
    try { treeEl.addEventListener(evt, handler); } catch {}
  });
}
function fitMainHeight(main) {
  const top = main.getBoundingClientRect().top;
  const h = window.innerHeight - top;
  if (h > 0) main.style.height = h + 'px';
}

/* ========================================================================== *
 *  树折叠
 * ========================================================================== */
function applyLeftCollapsed(flag){
  const leftWrap = document.getElementById('spLeft');
  const root = document.getElementById('spRoot');
  const toggle = document.getElementById('spTreeToggle');
  const handle = document.getElementById('spTreeHandle');
  if (!leftWrap || !toggle || !root || !handle) return;

  if (flag) {
    if (!leftWrap.dataset.prevW) {
      const w = leftWrap.getBoundingClientRect().width;
      if (w > 0) leftWrap.dataset.prevW = w + 'px';
    }
    leftWrap.classList.add('collapsed');
    root.classList.add('left-collapsed');
    toggle.textContent = '»'; toggle.title = '展开树状栏';
    handle.textContent = '»'; handle.title = '展开树状栏';
  } else {
    leftWrap.classList.remove('collapsed');
    root.classList.remove('left-collapsed');
    toggle.textContent = '«'; toggle.title = '折叠树状栏';
    handle.textContent = '«'; handle.title = '折叠树状栏';
    leftWrap.style.width = leftWrap.dataset.prevW || '320px';
  }
}
function loadCollapsed(){ try{ return localStorage.getItem(KEY_TREE_COLLAPSED) === '1'; } catch { return false; } }
function saveCollapsed(v){ try{ localStorage.setItem(KEY_TREE_COLLAPSED, v?'1':'0'); } catch {} }

/* ========================================================================== *
 *  Overlay
 * ========================================================================== */
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
        try {
          const payload = Object.assign({ t:'init' }, (__overlay.initParams || {}));
          iframe.contentWindow?.postMessage(Object.assign({ __detail:true }, payload), '*');
        } catch {}
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
function openOverlay(url, params){
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
    if (__overlay.chUnsub) {
      for (const un of __overlay.chUnsub.values()) { try { un(); } catch {} }
      __overlay.chUnsub.clear?.();
    }
    __overlay.chKey && __overlay.chKey.clear?.();
  } catch {}
  __overlay.host.style.display = 'none';
  try { __overlay.iframe.src = 'about:blank'; } catch {}
}
function openDeviceDetailOverlay(devId, devNo){
  openOverlay('/modules/features/pages/details/device-detail.html', { devId: devId, devNo: devNo });
}
function openVideoDetailOverlay(devId, devNo, stream){
  openOverlay('/modules/features/pages/details/video-detail.html', { devId: devId, devNo: devNo, stream: stream || 'main' });
}
function openModeDetailOverlay(devId, devNo, modeId){
  const mid = Number(modeId);
  const url = mid===1 ? '/modules/features/pages/details/mode-tilt-detail.html'
            : mid===2 ? '/modules/features/pages/details/mode-disp-tilt-detail.html'
            : '/modules/features/pages/details/mode-audio-detail.html';
  openOverlay(url, { devId: devId, devNo: devNo, modeId: mid });
}

/* ========================================================================== *
 *  调试命令
 * ========================================================================== */
window.__fixSiteLayout = function(){
  console.log('[SitePage][manualFix] start');
  ensureSitePageStyle();
  const main = document.getElementById('mainView');
  if (!main) { console.warn('[SitePage][manualFix] mainView missing'); return; }
  if (!rootEl) {
    const retain = window.__PAGE_RETENTION.site;
    if (retain && retain.root) {
      console.log('[SitePage][manualFix] re-append retained root manually');
      if (retain.timer) { clearTimeout(retain.timer); retain.timer = null; }
      main.appendChild(retain.root);
      if (retain.style && !document.contains(retain.style)) main.insertBefore(retain.style, retain.root);
      rootEl = retain.root;
      mapView = retain.mapView;
      tree = retain.tree;
      siteStyleEl = retain.style;
    } else {
      console.warn('[SitePage][manualFix] no retained root to restore');
      return;
    }
  }
  restoreAfterReuse(main);
  console.log('[SitePage][manualFix] done');
};

window.__dumpSiteLayout = function(){
  const root = document.getElementById('spRoot');
  if (!root) { console.log('[SitePage][dump] root missing'); return; }
  const center = root.querySelector('.sp-center');
  const bottom = root.querySelector('.sp-bottom');
  const grid   = root.querySelector('#mediaGrid');
  console.log('[SitePage][dump] root', root.getBoundingClientRect());
  center && console.log('[SitePage][dump] center', center.getBoundingClientRect());
  bottom && console.log('[SitePage][dump] bottom', bottom.getBoundingClientRect());
  grid && console.log('[SitePage][dump] grid', grid.getBoundingClientRect(), 'children=', grid.children.length);
  console.log('[SitePage][dump] has style?', !!Array.from(document.querySelectorAll('style')).find(s=>s.textContent.includes('.sp-root')));
};


/* ================= Logging Helpers ================= */
// 聚合：返回 summary 字符串；内部也计算总 token 数供新函数使用
function __openLogicalSummaryFor(list){
  const groups = new Map(); // key -> Set of tokens
  list.forEach(e=>{
    if(!e || e.devId==null || e.modeId==null) return;
    const letter = e.kind === 'manual' ? 'M' : 'A';
    const gkey = String(e.devId) + letter;
    if(!groups.has(gkey)) groups.set(gkey, new Set());
    const token = e.modeId === 4 ? `4(${e.streamIndex||0})` : String(e.modeId);
    groups.get(gkey).add(token);
  });

  const orderedKeys = Array.from(groups.keys()).sort((a,b)=>{
    const aNum = parseInt(a,10); const bNum = parseInt(b,10);
    if(aNum!==bNum) return aNum-bNum;
    return a[a.length-1].localeCompare(b[b.length-1]); // A 在 M 前
  });

  const parts = orderedKeys.map(k=>{
    const arr = Array.from(groups.get(k));
    arr.sort((x,y)=>{
      const xIs4 = /^4\(/.test(x);
      const yIs4 = /^4\(/.test(y);
      if(xIs4 && !yIs4) return 1;
      if(!xIs4 && yIs4) return -1;
      const xn = parseInt(x,10); const yn = parseInt(y,10);
      if(!isNaN(xn) && !isNaN(yn) && xn!==yn) return xn-yn;
      return x.localeCompare(y);
    });
    return `${k}:[${arr.join(',')}]`;
  });

  return `{${parts.join(', ')}}`;
}

// 新增：返回 { summary, total } 其中 total 为 summary 中所有 token（去重后的模式/视频项）数量
function __openLogicalSummaryWithCount() {
  // 复用已有 builder 但重新遍历一次以得到 total
  const groups = new Map();
  openLogical.forEach(e=>{
    if(!e || e.devId==null || e.modeId==null) return;
    const letter = e.kind === 'manual' ? 'M' : 'A';
    const gkey = String(e.devId) + letter;
    if(!groups.has(gkey)) groups.set(gkey, new Set());
    const token = e.modeId === 4 ? `4(${e.streamIndex||0})` : String(e.modeId);
    groups.get(gkey).add(token);
  });
  let total = 0;
  groups.forEach(set => total += set.size);

  // 若你想把 total 改成 openLogical.length（实际打开窗口条目总数），
  // 只需将上一行计算替换为： total = openLogical.length;

  const summary = __openLogicalSummaryFor(openLogical);
  return { summary, total };
}

// 更新日志函数：增加 totalModes 输出
function __logOpen(entry, kind){
  try {
    const { summary, total } = __openLogicalSummaryWithCount();
    console.log(
      `[SitePage][OPEN][${kind}] ` +
      `${entry.devId}/${entry.modeId}/${entry.modeId===4?(entry.streamIndex||0):0} ` +
      `summary=${summary} totalModes=${total}`
    );
  } catch {}
}
function __logClose(entry, reason){
  try {
    const { summary, total } = __openLogicalSummaryWithCount();
    console.log(
      `[SitePage][CLOSE][${reason||'release'}] ` +
      `${entry.devId}/${entry.modeId}/${entry.modeId===4?(entry.streamIndex||0):0} ` +
      `summary=${summary} totalModes=${total}`
    );
  } catch {}
}

/* === 在文件顶层（任意使用它的函数之前）新增：__lookupDevName === */
/* 用于根据 devId 查找设备名称；未找到返回空字符串 */
function __lookupDevName(devId){
  try{
    const list = Array.isArray(window.__LAST_SITE_DEVS) ? window.__LAST_SITE_DEVS : [];
    for(const item of list){
      const di = item && item.devInfo;
      if(di && Number(di.id) === Number(devId)){
        return di.name || '';
      }
    }
  }catch(e){}
  return '';
}
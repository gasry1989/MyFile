import { mountTopbar, detailBridge, useDetailContext, setupTopbarControls } from './common/detail-common.js';
import { STREAMS } from '/config/streams.js';
import { createVideoPreview } from '../modes/VideoPreview.js';
import { createModeTilt } from '../modes/ModeTilt.js';
import { createModeDispTilt } from '../modes/ModeDispTilt.js';
import { createModeAudio } from '../modes/ModeAudio.js';
import { apiDeviceInfo } from '@api/deviceApi.js';
import { authLoadToken } from '@core/auth.js';
import { eventBus } from '@core/eventBus.js';
import { androidWsApi } from '@api/androidWSApi.js';
import { createStreamThumbnail, requestHighQuality } from '@utils/streamThumbManager.js';

try { authLoadToken(); } catch {}

const bridge = detailBridge();
const ctx = await useDetailContext(bridge, { page:'device' });

/* ---------- devId 统一工具 ---------- */
let devIdRaw = ctx.devId ?? null; // 初始（可能为空）
function getDevId(){
  return (ctx.devId != null && ctx.devId !== '') ? String(ctx.devId)
       : (devIdRaw != null && devIdRaw !== '' ? String(devIdRaw) : '');
}
function getDevIdNum(){
  const s = getDevId();
  if(!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
async function waitDevId(maxMs=3000){
  const start = Date.now();
  while(!getDevId()){
    if(Date.now()-start > maxMs) break;
    await new Promise(r=>setTimeout(r,100));
  }
  devIdRaw = getDevId() || devIdRaw;
}

const ui = mountTopbar(document.body);
/* 替换原直接赋值：初始仅有 devId / devNo 时先行显示（名称未知保持空位） */
// ui.lblDevNo.textContent = buildTopbarDevLabel(getDevId(), '', ctx.devNo || '');
// 统一顶部栏控制
const topbarHelper = setupTopbarControls({
  ui,
  page:'device',
  getDevIdNum: ()=>getDevIdNum(),
  bridge
});
const main = document.createElement('div'); main.className='main';
main.innerHTML = `
  <div class="left" id="leftPane">
    <div id="secScreen" class="section">
      <h3>设备屏幕</h3>
      <div class="rail video" id="rowScreen" style="--cols:1;">
        <div class="card" id="cellScreen"><div class="label">屏幕</div></div>
      </div>
    </div>

    <div id="secMedia" class="section">
      <h3>媒体流</h3>
      <div class="rail video" id="rowMedia" style="--cols:2;">
        <div class="card" id="cellMain"><div class="label">主码流</div></div>
        <div class="card" id="cellSub"><div class="label">副码流</div></div>
      </div>
    </div>

    <div id="secModes" class="section modes">
      <h3>设备模式</h3>
      <div class="rail mode" id="rowModes" style="--cols:3;">
        <div class="card mode" id="cellModeTilt"></div>
        <div class="card mode" id="cellModeDispTilt"></div>
        <div class="card mode" id="cellModeAudio"></div>
      </div>
    </div>
  </div>

  <div class="right">
    <div class="kv"><div>设备ID：</div><div id="devIdLbl">--</div></div>
    <div class="kv"><div>设备名称：</div><div id="devNameLbl">--</div></div>
    <div class="kv"><div>设备类型：</div><div id="devTypeLbl">--</div></div>
    <div class="kv"><div>支持模式：</div><div id="devModesLbl">--</div></div>
    <div class="kv"><div>所属用户ID：</div><div id="ownerIdLbl">--</div></div>
    <div class="kv"><div>所属用户帐号：</div><div id="ownerAccLbl">--</div></div>

    <div class="btnLine" style="margin-top:18px;">
      <button class="btn" id="btnEditInfo">编辑信息</button>
      <button class="btn" id="btnEditOwner">编辑属主</button>
    </div>
  </div>
`;
document.body.appendChild(main);

/* ---------- 预览与模式缩略图 ---------- */
const mountedPreviews = [];
/* ===== 替换：mountPreview（去掉本地引用计数封装，destroy 时直接 stop） ===== */
/* ===== 替换：mountPreview（保证 beforeunload 调用 destroy 时发送一次 stop） ===== */
function mountPreview(cellId){
  const cell = document.getElementById(cellId);
  if(!cell || cell.dataset.mountedPreview==='1') return;

  const isScreen = (cellId === 'cellScreen');
  const hardwareType = isScreen ? 0 : 1;
  const hardwareIndex = (cellId === 'cellSub') ? 1 : 0;
  cell.dataset.mountedPreview='1';

  function startWhenReady(){
    const idNum = getDevIdNum();
    if(idNum == null){
      setTimeout(startWhenReady, 120);
      return;
    }

    const thumb = createStreamThumbnail({
      container: cell,
      devId: idNum,
      hardwareType,
      hardwareIndex,
      createPreview: ()=>createVideoPreview({ objectFit:'fill' }),
      wantLow: !isScreen
    });

    /* 关键点：
       1. 不再只保存 thumb.preview，而是保存 thumb 对象本身，确保 beforeunload 时调用到 thumb.destroy()
       2. 不再额外手动包装 pushStream stop，避免与 createStreamThumbnail 内部 destroy(若已实现 stop) 重复。
         如果你的 createStreamThumbnail 版本尚未内置 stop，请在其 destroy 内添加一次 stop，而不要在这里再包一层。 */
    mountedPreviews.push(thumb);

    if(!cell.__cleanup){
      cell.__cleanup = ()=> {
        try { thumb.destroy(); } catch {}
      };
    }
  }
  startWhenReady();
}

const mountedModes = [];
const modeInstMap = new Map();
function mountMode(cellId, factory){
  const cell = document.getElementById(cellId);
  if(!cell || cell.dataset.mountedMode==='1') return;
  const mp = factory({ devId: getDevId() });
  try {
    if (mp.el) {
      mp.el.style.width='100%';
      mp.el.style.height='100%';
      mp.el.style.display='block';
    }
  } catch {}
  cell.appendChild(mp.el);
  try {
    if (mp && mp.showLoading && !cell.dataset.hasData) {
      mp.showLoading();
    }
  } catch {}
  try { mp.start && mp.start(); } catch {}
  mountedModes.push({ id:cellId, mp });
  modeInstMap.set(cellId, mp);
  cell.dataset.mountedMode='1';
}

async function initModeThumbnails(){
  await waitDevId();
  const idNum = getDevIdNum();
  if(idNum==null){
    retryUntilDevId(initModeThumbnails);
    return;
  }
  if(!document.getElementById('cellModeTilt')?.classList.contains('hide')) mountMode('cellModeTilt', createModeTilt);
  if(!document.getElementById('cellModeDispTilt')?.classList.contains('hide')) mountMode('cellModeDispTilt', createModeDispTilt);
  if(!document.getElementById('cellModeAudio')?.classList.contains('hide')) mountMode('cellModeAudio', createModeAudio);
}

function setCols(el,n){ if(el) el.style.setProperty('--cols', String(Math.max(0,n))); }
function hide(el,flag){ if(el) el.classList.toggle('hide', !!flag); }

/* ---------------- 追加：devId 延迟获取补偿 ---------------- */
let __devIdRetryTimer = null;
function retryUntilDevId(cb){
  if(typeof cb!=='function') return;
  let tries = 0;
  if(__devIdRetryTimer){ return; }
  __devIdRetryTimer = setInterval(()=>{
    const n = getDevIdNum();
    if(n!=null){
      clearInterval(__devIdRetryTimer);
      __devIdRetryTimer = null;
      try { cb(); } catch(e){}
      return;
    }
    tries++;
    if(tries>40){
      clearInterval(__devIdRetryTimer);
      __devIdRetryTimer = null;
    }
  },250);
}

let currentDeviceInfo = null;

/* 修改函数：loadDeviceInfoAndLayout —— 获取设备信息后刷新顶栏标签为 设备ID 设备名称 设备编号 */
async function loadDeviceInfoAndLayout(){
  await waitDevId();
  const idNum = getDevIdNum();
  if(idNum==null){
    retryUntilDevId(loadDeviceInfoAndLayout);
    return;
  }
  try{
    const resp = await apiDeviceInfo(idNum);
    const d = resp?.devInfo || {};
    currentDeviceInfo = d;

    /* 顶栏标签更新：设备ID 设备名称 设备编号（名称可能为空） */
    // try {
    //   ui.lblDevNo.textContent = buildTopbarDevLabel(d.id!=null?d.id:idNum, d.name||'', d.no||d.devNo||'');
    // } catch {}

    document.getElementById('devIdLbl').textContent   = d.id ?? idNum ?? '--';
    document.getElementById('devNameLbl').textContent = d.name || d.no || '--';
    document.getElementById('devTypeLbl').textContent = d.typeName || '--';

    let modeNames='--';
    if(Array.isArray(d.modeList) && d.modeList.length){
      modeNames = d.modeList
        .map(m => (m && (m.modeName ?? m.name)) || '')
        .filter(Boolean).join(',');
    }
    document.getElementById('devModesLbl').textContent = modeNames;
    document.getElementById('ownerIdLbl').textContent  = (d.parentUserId ?? d.ownerUserId ?? '--');
    document.getElementById('ownerAccLbl').textContent = (d.parentUserAccount ?? d.ownerUserAccount ?? '无');

    const screenCount = Number(d?.hardwareInfo?.screenCount ?? 0);
    const cameraCount = Number(d?.hardwareInfo?.cameraCount ?? 0);
    const modeIds = Array.isArray(d.modeList)
      ? d.modeList.map(m => Number(m?.modeId ?? m?.id)).filter(n=>Number.isFinite(n))
      : [];

    const hasScreen = screenCount>0;
    if(hasScreen) mountPreview('cellScreen', STREAMS.screen);
    hide(document.getElementById('secScreen'), !hasScreen);
    setCols(document.getElementById('rowScreen'), hasScreen?1:0);

    const hasMode4 = modeIds.includes(4);
    const showMediaSection = hasMode4 && cameraCount>0;
    const showMain = showMediaSection && cameraCount>=1;
    const showSub  = showMediaSection && cameraCount>=2;

    if(showMain){ mountPreview('cellMain', STREAMS.main); hide(document.getElementById('cellMain'), false); }
    else hide(document.getElementById('cellMain'), true);
    if(showSub){ mountPreview('cellSub', STREAMS.sub); hide(document.getElementById('cellSub'), false); }
    else hide(document.getElementById('cellSub'), true);

    hide(document.getElementById('secMedia'), !showMediaSection);
    setCols(document.getElementById('rowMedia'), showMediaSection ? (showSub?2:1) : 0);

    const supportTilt     = modeIds.includes(1);
    const supportDispTilt = modeIds.includes(2);
    const supportAudio    = modeIds.includes(3);
    const showModes = supportTilt || supportDispTilt || supportAudio;

    hide(document.getElementById('cellModeTilt'), !supportTilt);
    hide(document.getElementById('cellModeDispTilt'), !supportDispTilt);
    hide(document.getElementById('cellModeAudio'), !supportAudio);

    hide(document.getElementById('secModes'), !showModes);
    if(showModes){
      const cnt = (supportTilt?1:0)+(supportDispTilt?1:0)+(supportAudio?1:0);
      setCols(document.getElementById('rowModes'), Math.max(1,cnt));
    } else {
      setCols(document.getElementById('rowModes'),0);
    }
    adjustLayout();
    initModeThumbnails();
  }catch{
    /* 获取失败时仍按已有信息更新顶栏（名称为空） */
    // try { ui.lblDevNo.textContent = buildTopbarDevLabel(idNum, '', ctx.devNo||''); } catch {}
    mountPreview('cellScreen', STREAMS.screen);
    mountPreview('cellMain', STREAMS.main);
    mountPreview('cellSub' , STREAMS.sub);
    adjustLayout();
    initModeThumbnails();
  }
}
function adjustLayout(){
  try{
    const left = document.getElementById('leftPane');
    if(!left) return;
    const secScreen = document.getElementById('secScreen');
    const secMedia  = document.getElementById('secMedia');
    const secModes  = document.getElementById('secModes');

    const sections = [secScreen, secMedia, secModes].filter(s => s && !s.classList.contains('hide'));
    const n = sections.length || 1;

    sections.forEach(s=>{
      s.style.flex = '1 1 0';
      s.style.display='flex';
      s.style.flexDirection='column';
      s.style.minHeight='0';
    });
    [secScreen, secMedia, secModes].forEach(s=>{
      if(!s) return;
      if(sections.includes(s)) return;
      s.style.flex='0 0 auto';
    });

    requestAnimationFrame(()=>{
      sections.forEach(sec=>{
        const h3 = sec.querySelector('h3');
        const headingH = h3 ? h3.getBoundingClientRect().height : 0;
        const contentH = sec.getBoundingClientRect().height - headingH - 8;
        if(contentH <= 0) return;

        const isVideoSec = (sec === secScreen) || (sec === secMedia);
        if(isVideoSec){
          const cards = Array.from(sec.querySelectorAll('.card:not(.mode):not(.hide)'));
            cards.forEach(card=>{
              card.style.height = contentH + 'px';
              const w = Math.round(contentH * 16 / 9);
              card.style.width = w + 'px';
            });
          const rail = sec.querySelector('.rail.video');
          if(rail){
            rail.style.height = contentH + 'px';
            rail.style.alignItems='center';
          }
        }

        if(sec === secModes){
          const modeCells = Array.from(sec.querySelectorAll('.card.mode')).filter(c=>!c.classList.contains('hide'));
          const rail = sec.querySelector('#rowModes');
          if(rail){
            const cnt = Math.max(1, modeCells.length);
            rail.style.display='grid';
            rail.style.gridTemplateColumns = `repeat(${cnt}, 1fr)`;
            rail.style.height = contentH + 'px';
          }
          modeCells.forEach(c=>{
            c.style.height='100%';
            c.style.width='100%';
          });
        }
      });
    });
  }catch{}
}
await loadDeviceInfoAndLayout();

/* ---------- Left Pane Click（含刷新按钮拦截） ---------- */
function onLeftPaneClick(e){
  const t = e.target.closest('.card'); if(!t || t.classList.contains('hide')) return;

  try {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.some(n => n && n.getAttribute && n.hasAttribute('data-refresh-btn'))) return;
  } catch {}

  const id = t.id;
  const devIdStr = getDevId();
  const devNo = ctx.devNo || '';
  if(id==='cellScreen'){
    try{
      let target = t.querySelector('video,canvas') || t;
      target?.requestFullscreen?.();
    }catch{}
    return;
  }else if(id==='cellMain'){
    const card = document.getElementById('cellMain');
    if (!card || !card.hasAttribute('data-thumb-ready')) {
      eventBus.emit('toast:show', { type:'info', message:'主码流加载中，暂不能进入详情' });
      return;
    }
    try { requestHighQuality(getDevIdNum(),1,0); } catch {}
    location.href = `/modules/features/pages/details/video-detail.html?devId=${encodeURIComponent(devIdStr)}&devNo=${encodeURIComponent(devNo)}&stream=main&streamId=0`;
    return;
  }else if(id==='cellSub'){
    const card = document.getElementById('cellSub');
    if (!card || !card.hasAttribute('data-thumb-ready')) {
      eventBus.emit('toast:show', { type:'info', message:'副码流加载中，暂不能进入详情' });
      return;
    }
    try { requestHighQuality(getDevIdNum(),1,1); } catch {}
    location.href = `/modules/features/pages/details/video-detail.html?devId=${encodeURIComponent(devIdStr)}&devNo=${encodeURIComponent(devNo)}&stream=sub&streamId=1`;
    return;
  }else if(id==='cellModeTilt' || id==='cellModeDispTilt' || id==='cellModeAudio'){
    const inst = modeInstMap.get(id);
    const hostEl = inst && inst.el;
    const hasData = !!(hostEl && hostEl.dataset.hasData);
    if(!hasData){
      try { inst && inst.forceRefresh && inst.forceRefresh(); } catch {}
      return;
    }
    const modeId = (id==='cellModeTilt') ? 1 : (id==='cellModeDispTilt' ? 2 : 3);
    parent.postMessage({ __detail:true, t:'openMode', devId:devIdStr, devNo, modeId }, '*');
  }
}
document.getElementById('leftPane').addEventListener('click', onLeftPaneClick);

/* ---------- WS Channel（仅用于顶部按钮示例） ---------- */
await waitDevId();
const devIdNum = getDevIdNum();
let wsCh = null;
if(devIdNum!=null){
  wsCh = await bridge.wsOpen({ kind:'device', devId: devIdNum });
  topbarHelper.updateWsChannel(wsCh);
}


/* 编辑按钮（调用后重新加载） */
document.getElementById('btnEditInfo').onclick = async ()=>{
  if(!currentDeviceInfo) return;
  const mod = await import('../modals/EditDeviceInfoModal.js');
  const ok = await mod.openEditDeviceInfoModal({ dev: currentDeviceInfo });
  if(ok) loadDeviceInfoAndLayout();
};
document.getElementById('btnEditOwner').onclick = async ()=>{
  if(!currentDeviceInfo) return;
  const mod = await import('../modals/EditDeviceOwnerModal.js');
  const ok = await mod.openEditDeviceOwnerModal({ dev: currentDeviceInfo });
  if(ok) loadDeviceInfoAndLayout();
};

window.addEventListener('resize', ()=>adjustLayout());

window.addEventListener('beforeunload', ()=>{
  try{ mountedPreviews.forEach(p=>p.destroy && p.destroy()); }catch{}
  try{ mountedModes.forEach(x=>x.mp && x.mp.destroy && x.mp.destroy()); }catch{}
});

/* （下方旧推流管理保留以满足“未改动无关代码”约束；实际缩略图已改用 createStreamThumbnail，不再直接调用这些函数） */
const __DD_STREAM_RC = (function(){
  try {
    if (window.top && window.top !== window) {
      if (!window.top.__DD_STREAM_RC_SHARED__) window.top.__DD_STREAM_RC_SHARED__ = {};
      return window.top.__DD_STREAM_RC_SHARED__;
    }
  } catch {}
  if (!window.__DD_STREAM_RC_SHARED__) window.__DD_STREAM_RC_SHARED__ = {};
  return window.__DD_STREAM_RC_SHARED__;
})();

function __ddKey(devId, ht, hi){ return devId+':'+ht+':'+hi; }
function __ddStreamReused(devId, ht, hi){
  const e = __DD_STREAM_RC[__ddKey(devId,ht,hi)];
  return !!(e && e.streamURI);
}
/* ===== 替换：__ddEnsureStream（前端不计引用，单次 start） ===== */
async function __ddEnsureStream(devId, hardwareType, hardwareIndex, { wantLow = true, forceStart = false } = {}) {
  if (devId == null) throw new Error('no devId');
  const toMs = (window.VIDEO_WS_RESPONSE_TIMEOUT_MS || 3000);
  let timeoutId;
  try {
    await new Promise((res,rej)=>{
      timeoutId = setTimeout(()=>rej(new Error('timeout')), toMs);
      androidWsApi.pushStream({
        toId: devId,
        startFlag:true,
        hardwareType,
        hardwareIndex
      }).then(resp=>{
        if(!resp || resp.code!==0 || !resp.data?.streamURI){
          rej(new Error(resp?.msg || 'pushStream fail'));
          return;
        }
        clearTimeout(timeoutId);
        res(resp.data.streamURI);
      }).catch(err=>{
        clearTimeout(timeoutId);
        rej(err);
      });
    });
    // wantLow 逻辑：直接附加请求（失败忽略）
    if (wantLow && hardwareType === 1) {
      androidWsApi.pushStreamResolution({ toId:devId, streamURI:'', quality:'low' }).catch(()=>{});
    }
  } catch(e){
    throw e;
  }
}

/* ===== 替换：__ddRequestHigh（保留接口，直接发 high） ===== */
function __ddRequestHigh(devId, hardwareType, hardwareIndex){
  androidWsApi.pushStreamResolution({ toId:devId, streamURI:'', quality:'high' }).catch(()=>{});
}
/* ===== 替换：__ddReleaseStream（每次调用都发送 stop） ===== */
function __ddReleaseStream(devId, hardwareType, hardwareIndex){
  // try {
  //   androidWsApi.pushStream({
  //     toId:devId,
  //     startFlag:false,
  //     hardwareType,
  //     hardwareIndex
  //   }).catch(()=>{});
  // } catch {}
}

window.addEventListener('beforeunload', ()=>{
  try {
    const n = getDevIdNum();
    if (n!=null){
      [ [0,0], [1,0], [1,1] ].forEach(([ht,hi])=>__ddReleaseStream(n,ht,hi));
    }
  } catch {}
});

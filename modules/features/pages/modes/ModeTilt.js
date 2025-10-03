/**
 * 倾角模式（modeId=1）预览
 * (首帧加载圈修复：tplReady 结束后若 loadingCount>0 立即显示)
 * 其余说明见前版本注释。
 *
 * Added: devId 迟到自恢复（start-wait 重试 + setDevId）
 */
import { androidWsApi, AndroidTopics } from '@api/androidWSApi.js';
import { modePoller } from './mode-poller.js';
import { FAIL_TOAST_PREFIX } from '/config/constants.js';

const DISP_THRESH = [0.003,0.005,0.015,0.035,0.065,0.100];
const ANGLE_THRESH = [0.3,0.5,1.0,2.0,4.0,8.0];

function mapBattery7(b){
  const v = Math.max(0, Math.min(100, Number(b)||0));
  if(v===0) return 0;
  if(v===100) return 6;
  if(v<20) return 1;
  if(v<40) return 2;
  if(v<60) return 3;
  if(v<80) return 4;
  if(v<100) return 5;
  return 6;
}
function formatAngle2(v){
  const x = Number(v)||0;
  const s = x>=0?'+':'-';
  const a = Math.abs(x).toFixed(2); // 如 0.23
  return `${s}${a}°`;
}
function thresholdValue(devType, thresholdIndex){
  const idx = Number(thresholdIndex);
  if(devType===0){
    const i = (idx>=0 && idx<DISP_THRESH.length)?idx:0;
    return DISP_THRESH[i].toFixed(3)+'m';
  }else{
    const i = (idx>=0 && idx<ANGLE_THRESH.length)?idx:0;
    return ANGLE_THRESH[i].toFixed(1)+'°';
  }
}
function formatMove(devType, moveValue){
  const v = Number(moveValue)||0;
  return devType===0 ? v.toFixed(3)+'m' : v.toFixed(1)+'°';
}

export function createModeTilt({ devId } = {}) {
  const host = document.createElement('div');
  host.style.alignSelf = 'stretch';
  host.style.width = '100%';
  host.style.height = '100%';
  host.style.position = 'relative';

  const root = host.attachShadow({ mode: 'open' });

  let wrapEl = null, listEl = null, emptyEl = null, ro = null;
  let offTopic = null;
  let unSubPoll = null;
  let offSuspend = null;
  let offResume = null;
  let __destroyed = false;

  let refreshBtn = null;
  let loadingEl = null;
  let suspended = false;
  let loadingCount = 0;

  const INSTANCE_ID = Math.random().toString(36).slice(2, 8);
  let lastSig = '__INIT__'; // 修复首次空数组未渲染“无探头”

  let pendingDevId = devId;
  let startedOk = false;
  let retryTimer = null;
  let retryCount = 0;
  function clearRetry(){ if(retryTimer){ clearInterval(retryTimer); retryTimer=null; } }
  function scheduleRetry(){
    if(retryTimer || startedOk) return;
    retryTimer = setInterval(()=>{
      if(__destroyed){ clearRetry(); return; }
      if(startedOk){ clearRetry(); return; }
      if(retryCount++ > 40){ clearRetry(); console.warn('[ModeTilt][start-abort] devId still invalid'); return; }
      if(Number.isFinite(Number(pendingDevId))){
        console.log('[ModeTilt][retry-start] devId=', pendingDevId);
        clearRetry();
        start();
      }
    },250);
  }

  // === A 方案新增：逻辑打开 & 订阅控制 ===
  let __opened=false;
  let __pollSubscribed=false;
  function ensureSubscribe(n){
    if(__destroyed || !__opened) return;
    if(__pollSubscribed) return;
    unSubPoll = modePoller.subscribe({ cmd: 'dipOneChannel', devId: n, intervalMs: 300 });
    try { modePoller.resume('dipOneChannel', n, { immediate:true }); } catch {}
    __pollSubscribed=true;
  }
  function ensureUnsubscribe(){
    if(!__pollSubscribed) return;
    if(typeof unSubPoll === 'function'){ try{ unSubPoll(); }catch{} }
    unSubPoll=null;
    __pollSubscribed=false;
  }
  function setOpened(v){
    if(__destroyed) return;
    v=!!v;
    if(v===__opened) return;
    __opened=v;
    if(__opened){
      if(startedOk && Number.isFinite(Number(devId))) ensureSubscribe(Number(devId));
    }else{
      ensureUnsubscribe();
    }
  }

  const tplReady = (async () => {
    const html = await fetch('/modules/features/pages/modes/mode-tilt.html', { cache: 'no-cache' }).then(r => r.text());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const frag = doc.querySelector('#tpl-mode-tilt').content.cloneNode(true);

    const styleExtra = document.createElement('style');
    styleExtra.textContent = `
    .row{
      /* 5 等分：名称 / 灯帽 / 监控图标 / 移动值 / 电量 */
      grid-template-columns: repeat(5, 1fr);
    }
    .row .batt7{width:var(--batt-w);height:var(--batt-h);display:block;object-fit:contain}
    .row .deg{min-width:0;text-align:center;}
    `;
    frag.appendChild(styleExtra);

    const auxWrap = document.createElement('div');
    auxWrap.style.position = 'absolute';
    auxWrap.style.top = '4px';
    auxWrap.style.right = '4px';
    auxWrap.style.display = 'flex';
    auxWrap.style.gap = '6px';
    auxWrap.style.zIndex = '10';

    refreshBtn = document.createElement('div');
    refreshBtn.textContent = '⟳';
    refreshBtn.title = '刷新';
    refreshBtn.setAttribute('data-refresh-btn','');
    Object.assign(refreshBtn.style, {
      width:'22px', height:'22px', lineHeight:'22px', textAlign:'center',
      fontSize:'14px', background:'#123', color:'#9ec3ff', border:'1px solid #345',
      borderRadius:'4px', cursor:'pointer', display:'none', userSelect:'none'
    });
    refreshBtn.onclick = () => {
      if (suspended) {
        modePoller.resume('dipOneChannel', devId, { immediate:true });
        hideRefresh();
      } else {
        forceFetch();
      }
    };

    loadingEl = document.createElement('div');
    loadingEl.title = '加载中';
    Object.assign(loadingEl.style, {
      width:'22px', height:'22px', border:'3px solid #2a5b8a',
      borderTopColor:'#9ec3ff', borderRadius:'50%',
      animation:'spin 0.8s linear infinite', display:'none'
    });

    const styleSpin = document.createElement('style');
    styleSpin.textContent = `@keyframes spin{to{transform:rotate(360deg)}}`;
    root.appendChild(styleSpin);

    auxWrap.appendChild(refreshBtn);
    auxWrap.appendChild(loadingEl);
    frag.appendChild(auxWrap);

    root.appendChild(frag);
    wrapEl = root.querySelector('.wrap');
    listEl = root.getElementById('list');
    emptyEl = root.getElementById('empty');

    if (loadingCount > 0 && !suspended) {
      loadingEl.style.display = 'block';
    }

    ro = new ResizeObserver(()=> applySizing());
    ro.observe(wrapEl);
    applySizing();
  })();

  function showLoading() {
    if (suspended) return;
    loadingCount++;
    if (loadingEl && loadingEl.style.display !== 'block') loadingEl.style.display = 'block';
  }
  function hideLoading() {
    loadingCount = Math.max(0, loadingCount - 1);
    if (loadingCount === 0 && loadingEl) loadingEl.style.display = 'none';
  }
  // MOD: showRefresh 增强：tplReady 后补
  function showRefresh() {
    loadingCount = 0;
    if (loadingEl) loadingEl.style.display = 'none';
    if (refreshBtn) refreshBtn.style.display = 'block';
    try { host.dataset.suspended = '1'; } catch {}
    tplReady.then(()=>{
      if(suspended && refreshBtn && refreshBtn.style.display==='none'){
        refreshBtn.style.display='block';
      }
    });
  }
  function hideRefresh() {
    if (refreshBtn) refreshBtn.style.display = 'none';
    try { delete host.dataset.suspended; } catch {}
  }
  function forceFetch() {
    if (suspended) return;
    if(!startedOk){
      start();
      if(!startedOk) return;
    }
    const n = Number(devId);
    if (!Number.isFinite(n)) {
      console.warn('[ModeTilt][force-fetch-skip] invalid devId', devId);
      return;
    }
    showLoading();
    androidWsApi.forceListFetch('dipOneChannel', n);
  }

  function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

  function applySizing() {
     if (!wrapEl) return;
    const H = wrapEl.getBoundingClientRect().height;
    const TOTAL_ROWS = 12;
    const gapY = 1;
    const rowH = (H - gapY * (TOTAL_ROWS - 1)) / TOTAL_ROWS;

    const fs = clamp(rowH * 0.42, 8, 15);
    const icon = clamp(rowH * 0.58, 10, 18);
    const battH = clamp(rowH * 0.36, 6, 12);
    const battW = clamp(rowH * 1.35, 24, 44);
    const capW = clamp(battH * 0.38, 2.5, 5.5);
    const capH = clamp(battH * 0.78, 3, 8);
    const hgap = clamp(rowH * 0.35, 6, 14);

    host.style.setProperty('--fs', fs + 'px');
    host.style.setProperty('--icon', icon + 'px');
    host.style.setProperty('--batt-h', battH + 'px');
    host.style.setProperty('--batt-w', battW + 'px');
    host.style.setProperty('--cap-w', capW + 'px');
    host.style.setProperty('--cap-h', capH + 'px');
    host.style.setProperty('--hgap', hgap + 'px');
  }

  function makeRow() {
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('div'); name.className = 'name';
    const bulb = document.createElement('img'); bulb.className = 'icon bulb'; bulb.alt = 'alarm-hat'; bulb.src = '/res/hat_green.png';
    const siren = document.createElement('img'); siren.className = 'icon siren'; siren.alt = 'circle'; siren.src = '/res/circle_white.jpg';
    const deg = document.createElement('div'); deg.className = 'deg';
    const batt = document.createElement('img'); batt.className = 'batt7'; batt.alt = 'battery'; batt.src = '/res/bat6.png';
    row.append(name, bulb, siren, deg, batt);
    return { row, name, bulb, siren, deg, batt };
  }

  function signature(arr) {
    if (!Array.isArray(arr)) return '';
    return arr.map(it => [
      it?.code ?? '',
      Number(it?.devType) || 0,
      Number(it?.index) || 0,
      Number(it?.thresholdIndex) || 0,
      it?.alarm ? 1 : 0,
      it?.isAlarm ? 1 : 0,
      it?.isStartAlarm ? 1 : 0,
      Number(it?.battery) || 0
    ].join('|')).join(';');
  }

  function render(items) {
    if (!listEl || !emptyEl) return;
    const arr = Array.isArray(items) ? items : [];
    emptyEl.style.display = arr.length === 0 ? 'flex' : 'none';

    listEl.innerHTML = '';
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i];
      const r = makeRow();

      const prefix = Number(it?.devType) === 0 ? '位移' : '倾角';
      const idx = (it?.index != null) ? String(it.index) : String(i + 1);
      r.name.textContent = `${prefix}${idx}#`;

      const hatRed = Boolean(it?.isAlarm) && Boolean(it?.alarm);
      r.bulb.src = hatRed ? '/res/hat_red.png' : '/res/hat_green.png';

      r.siren.src = Boolean(it?.isStartAlarm) ? '/res/circle_red.jpg' : '/res/circle_white.jpg';

      r.deg.textContent = formatMove(Number(it?.devType)||0, it?.moveValue);

      const lvl7 = mapBattery7(it?.battery);
      r.batt.src = `/res/bat${lvl7}.png`;

      listEl.appendChild(r.row);
    }
  }

  async function setData(data) {
    await tplReady;
    hideLoading();
    const items = Array.isArray(data?.items) ? data.items : [];
    const sig = signature(items);
    if (sig === lastSig) return;
    lastSig = sig;
    render(items);
    if (items.length > 0) {
      try { host.dataset.hasData='1'; } catch {}
      if (!suspended) { try { delete host.dataset.suspended; } catch {} }
    }
  }

  // MOD: start 增加 watchdog
  function start() {
    if(__destroyed) return;
    const n = Number(pendingDevId);
    if (!Number.isFinite(n)) {
      console.warn('[ModeTilt][start-wait] invalid devId', pendingDevId);
      scheduleRetry();
      return;
    }
    devId = n;
    startedOk = true;
    clearRetry();

    offTopic = androidWsApi.onByDev(AndroidTopics.DipOneChannelResponse, n, (msg) => {
      if (msg && (msg.code == null || msg.code === 0)) {
        const isEmptyObj = msg.data && typeof msg.data==='object' && !Array.isArray(msg.data) && Object.keys(msg.data).length===0;
        const list = Array.isArray(msg.data)? msg.data : (isEmptyObj || msg.data==null ? [] : null);
        if(list){
          modePoller.markSuccess('dipOneChannel', n, msg.requestId);
          setData({ items: list });
          hideLoading();
        }
      }
    });

    ensureSubscribe(n);

    offSuspend = modePoller.on('suspend', ({ cmd, devId: d }) => {
      if (cmd === 'dipOneChannel' && String(d) === String(n)) {
        suspended = true;
        hideLoading();
        showRefresh();
        try {
          window.eventBus?.emit('toast:show', { type:'warn', message: `${FAIL_TOAST_PREFIX}${n}` });
        } catch {}
      }
    });
    offResume = modePoller.on('resume', ({ cmd, devId: d }) => {
      if (cmd === 'dipOneChannel' && String(d) === String(n)) {
        suspended = false;
        hideRefresh();
        showLoading();
      }
    });
    autoDisposeWhenRemoved();

    setTimeout(()=>{
      if(__destroyed) return;
      if(suspended && refreshBtn && refreshBtn.style.display==='none'){
        refreshBtn.style.display='block';
      }
    },600);

    setOpened(true); // start 默认逻辑打开
  }
    
  function destroy() {
    if(__destroyed) return;
    __destroyed = true;
    ensureUnsubscribe();
    clearRetry();
    try { ro?.disconnect(); } catch {}
    try { if (typeof offTopic === 'function') offTopic(); } catch {}
    try { if (typeof offSuspend === 'function') offSuspend(); } catch {}
    try { if (typeof offResume === 'function') offResume(); } catch {}
    try { host.remove(); } catch {}
  }

  function autoDisposeWhenRemoved(){
    if(host.__autoDisposeBound) return;
    host.__autoDisposeBound=true;
    const mo=new MutationObserver(()=>{
      if(!host.isConnected){
        try{ destroy(); }catch{}
        try{ mo.disconnect(); }catch{}
      }
    });
    try{ mo.observe(document.documentElement,{ childList:true, subtree:true }); }catch{}
  }

  return {
    el: host, start, setData, destroy, __devId: devId, __modeId: 1,
    forceRefresh: () => forceFetch(),
    showLoading, hideLoading,
    setOpened, // 方案A新增
    setDevId(v){
      if(v!=null && v!==''){
        pendingDevId = v;
        if(!startedOk && !__destroyed) start();
      }
    }
  };

}
/**
 * 位移·倾角模式（modeId=2）缩略图
 * 修复：tplReady 完成后若 loadingCount>0 显示加载圈
 *
 * Added: devId 迟到自恢复（start-wait 重试 + setDevId）
 */
import { androidWsApi, AndroidTopics } from '@api/androidWSApi.js';
import { modePoller } from './mode-poller.js';
import { FAIL_TOAST_PREFIX } from '/config/constants.js';

export function createModeDispTilt({ devId } = {}) {
  const MAX_ITEMS = 12;
  const TOTAL_ROWS = 12;

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
      if(retryCount++ > 40){ clearRetry(); console.warn('[ModeDispTilt][start-abort] devId still invalid'); return; }
      if(Number.isFinite(Number(pendingDevId))){
        console.log('[ModeDispTilt][retry-start] devId=', pendingDevId);
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
    unSubPoll = modePoller.subscribe({ cmd: 'dipTwoChannel', devId: n, intervalMs: 300 });
    try { modePoller.resume('dipTwoChannel', n, { immediate:true }); } catch {}
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
    const html = await fetch('/modules/features/pages/modes/mode-disp-tilt.html', { cache: 'no-cache' }).then(r => r.text());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const frag = doc.querySelector('#tpl-mode-disp-tilt').content.cloneNode(true);

    const addStyle = document.createElement('style');
    addStyle.textContent = `
          .wave{height:12px;display:block;object-fit:contain;margin:0;}
          .val-box{
            display:flex;
            flex-direction:row;
            align-items:center;
            justify-content:center;
            min-width:0;
            padding:0;
            width:100%;
            height:100%;
          }
          .row{
            grid-template-columns: 1fr var(--badge-d) var(--batt-w) var(--icon) 1fr !important;
            align-items:stretch;
          }
          .lab{
            white-space:nowrap;
            overflow:hidden;
            text-overflow:ellipsis;
            padding-right:4px;
            display:flex;
            align-items:center;
          }
          .val-box:not(.tilt-box) .val{
            text-align:center;
            width:100%;
            font-weight:600;
          }
          .tilt-box{
            flex-direction:column !important;
            align-items:center !important;
            justify-content:center !important;
            gap:2px;
            padding:0;
          }
          .tilt-box .val{
            width:100%;
            text-align:center;
            font-weight:600;
            line-height:1.1;
          }
          .tilt-box .wave{
            height:10px !important;
            width:36px !important;
            max-width:36px !important;
            object-fit:contain;
            margin:0;
          }
    `;
    frag.appendChild(addStyle);

    const auxWrap = document.createElement('div');
    auxWrap.style.position='absolute';
    auxWrap.style.top='4px'; auxWrap.style.right='4px';
    auxWrap.style.display='flex'; auxWrap.style.gap='6px'; auxWrap.style.zIndex='10';

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
        modePoller.resume('dipTwoChannel', devId, { immediate:true });
        hideRefresh();
      } else forceFetch();
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
      loadingEl.style.display='block';
    }

    ro = new ResizeObserver(()=> applySizing());
    ro.observe(wrapEl);
    applySizing();
  })();

  function mapBattery7(b){
    const v=Math.max(0,Math.min(100,Number(b)||0));
    if(v===0) return 0;
    if(v===100) return 6;
    if(v<20) return 1;
    if(v<40) return 2;
    if(v<60) return 3;
    if(v<80) return 4;
    if(v<100) return 5;
    return 6;
  }
  function formatDisp(mm){
    const m = Number(mm)||0;
    return (m).toFixed(3)+'m';
  }

  function showLoading(){
    if (suspended) return;
    loadingCount++;
    if (loadingEl && loadingEl.style.display!=='block') loadingEl.style.display='block';
  }
  function hideLoading(){
    loadingCount=Math.max(0,loadingCount-1);
    if (loadingCount===0 && loadingEl) loadingEl.style.display='none';
  }
  // MOD: showRefresh 增强：tplReady 后补
  function showRefresh(){
    loadingCount = 0;
    if (loadingEl) loadingEl.style.display='none';
    if (refreshBtn) refreshBtn.style.display='block';
    try{ host.dataset.suspended='1'; }catch{}
    tplReady.then(()=>{
      if(suspended && refreshBtn && refreshBtn.style.display==='none'){
        refreshBtn.style.display='block';
      }
    });
  }
  function hideRefresh(){
    if (refreshBtn) refreshBtn.style.display='none';
    try{ delete host.dataset.suspended; }catch{}
  }
  function forceFetch(){
    if (suspended) return;
    if(!startedOk){
      start();
      if(!startedOk) return;
    }
    const n = Number(devId);
    if (!Number.isFinite(n)) {
      console.warn('[ModeDispTilt][force-fetch-skip] invalid devId', devId);
      return;
    }
    showLoading();
    androidWsApi.forceListFetch('dipTwoChannel', n);
  }

  function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

  function applySizing() {
    if (!wrapEl) return;
    const H = wrapEl.getBoundingClientRect().height;
    const gapY = 1;
    const rowH = (H - gapY * (TOTAL_ROWS - 1)) / TOTAL_ROWS;

    const fs = clamp(rowH * 0.40, 8, 15);
    const icon = clamp(rowH * 0.56, 10, 18);
    const badgeD = clamp(rowH * 0.62, 14, rowH - 2);
    const badgeFS = clamp(badgeD * 0.56, 7.5, 12);
    const battH = clamp(rowH * 0.34, 6, 12);
    const battW = clamp(rowH * 1.30, 24, 44);
    const capW = clamp(battH * 0.38, 2.5, 5.5);
    const capH = clamp(battH * 0.78, 3, 8);
    const hgap = clamp(rowH * 0.35, 6, 14);

    host.style.setProperty('--fs', fs + 'px');
    host.style.setProperty('--icon', icon + 'px');
    host.style.setProperty('--badge-d', badgeD + 'px');
    host.style.setProperty('--badge-fs', badgeFS + 'px');
    host.style.setProperty('--batt-h', battH + 'px');
    host.style.setProperty('--batt-w', battW + 'px');
    host.style.setProperty('--cap-w', capW + 'px');
    host.style.setProperty('--cap-h', capH + 'px');
    host.style.setProperty('--hgap', hgap + 'px');
  }

  function makeRow() {
    const row = document.createElement('div'); row.className = 'row';
    const lab = document.createElement('div'); lab.className = 'lab';
    const badge = document.createElement('div'); badge.className = 'badge';
    const batt = document.createElement('div'); batt.className = 'batt';
    const fill = document.createElement('div'); fill.className = 'fill'; batt.appendChild(fill);
    const siren = document.createElement('img'); siren.className = 'icon'; siren.alt='alarm';
    const valBox = document.createElement('div'); valBox.className='val-box';
    const val = document.createElement('div'); val.className = 'val';
    const wave = document.createElement('img'); wave.className='wave'; wave.style.display='none';
    valBox.appendChild(val);
    valBox.appendChild(wave);
    row.append(lab, badge, batt, siren, valBox);
    return { row, lab, badge, batt, fill, siren, val, wave, valBox };
  }

  let rows = [];
  let currentItems = [];

  function render(items) {
    currentItems = items;
    if (!listEl || !emptyEl) return;

    const n = items.length|0;
    emptyEl.style.display = n === 0 ? 'flex' : 'none';

    if (rows.length !== n) {
      listEl.innerHTML = '';
      rows = items.map(() => makeRow());
      rows.forEach(r => listEl.appendChild(r.row));
      applySizing();
    }
    for (let i = 0; i < n; i++) {
      const it = items[i], r = rows[i];
      const isDisp = Number(it.devType)===0;
      r.lab.textContent = isDisp ? '位移' : '倾角';
      r.badge.textContent = (it.number == null || Number(it.number) < 0) ? '--' : String(it.number);
      const pBatt = Math.max(0, Math.min(100, Number(it.battery) || 0)) / 100;
      r.fill.style.transform = `scaleX(${pBatt})`;

      const monitorOn = Number(it?.offsetInfo?.offsetMoniterState)===1 || Number(it?.angleInfo?.moniterState)===1;
      const alarm = [
        it?.offsetInfo?.offsetAlarmState,
        it?.offsetInfo?.findState,
        it?.offsetInfo?.lGasAlarmState,
        it?.offsetInfo?.rGasAlarmState,
        it?.angleInfo?.is_vibration_alarm,
        it?.angleInfo?.is_angle_alarm,
        it?.angleInfo?.alarmState
      ].some(v=>Number(v));

      if(alarm){
        r.siren.src = '/res/mon_red.png';
        r.siren.removeAttribute('data-mdt-blink');
      }else if(monitorOn){
        r.siren.setAttribute('data-mdt-blink','1');
        r.siren.src = window.__mdtBlinkPhase ? '/res/mon_white.png' : '/res/mon_green.png';
      }else{
        r.siren.src = '/res/mon_white.png';
        r.siren.removeAttribute('data-mdt-blink');
      }

      if(isDisp){
        r.valBox.classList.remove('tilt-box');
        r.wave.style.display='none';
        const offState = Number(it?.offsetInfo?.offsetState);
        if(offState>0 && offState<6){
          r.val.textContent='错误';
          r.val.style.color='#ff6b6b';
        }else{
          const diff = it?.offsetInfo?.offsetValueDiff;
          r.val.textContent = formatDisp(diff);
          r.val.style.color = Number(it?.offsetInfo?.offsetAlarmState)===0 ? '#2eff67' : '#ff6b6b';
        }
      }else{
        r.valBox.classList.add('tilt-box');
        const change = Number(it?.angleInfo?.angle_change);
        const txt = Number.isFinite(change)? change.toFixed(2)+'°':'0.00°';
        r.val.textContent = txt;
        r.val.style.color = Number(it?.angleInfo?.is_angle_alarm)===0 ? '#2eff67' : '#ff6b6b';
        const vib = Number(it?.angleInfo?.is_vibration_alarm)||0;
        r.wave.src = vib? '/res/wave_red.png':'/res/wave_green.png';
        r.wave.style.display='block';
      }
    }
  }

  async function setDataFromResponse(list) {
    await tplReady;
    hideLoading();
    const items = Array.isArray(list) ? list.slice(0, MAX_ITEMS) : [];
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
      console.warn('[ModeDispTilt][start-wait] invalid devId', pendingDevId);
      scheduleRetry();
      return;
    }
    devId = n;
    startedOk = true;
    clearRetry();

    const off = androidWsApi.onByDev(AndroidTopics.DipTwoChannelResponse, n, (msg) => {
      if (msg && msg.code === 0) {
        const isEmptyObj = msg.data && typeof msg.data==='object' && !Array.isArray(msg.data) && Object.keys(msg.data).length===0;
        const list = Array.isArray(msg.data)? msg.data : (isEmptyObj || msg.data==null ? [] : null);
        if(list){
          modePoller.markSuccess('dipTwoChannel', n, msg.requestId);
          setDataFromResponse(list);
          hideLoading();
        }
      }
    });
    offTopic = off;

    ensureSubscribe(n);

    offSuspend = modePoller.on('suspend', ({ cmd, devId: d }) => {
      if (cmd === 'dipTwoChannel' && String(d) === String(n)) {
        suspended = true;
        hideLoading();
        showRefresh();
        try { window.eventBus?.emit('toast:show', { type:'warn', message: `${FAIL_TOAST_PREFIX}${n}` }); } catch {}
      }
    });
    offResume = modePoller.on('resume', ({ cmd, devId: d }) => {
      if (cmd === 'dipTwoChannel' && String(d) === String(n)) {
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
    el: host, start, setData: ()=>{}, destroy, __devId: devId, __modeId: 2,
    forceRefresh: () => forceFetch(),
    showLoading, hideLoading,
    setOpened,  // 方案A新增
    setDevId(v){
      if(v!=null && v!==''){
        pendingDevId = v;
        if(!startedOk && !__destroyed) start();
      }
    }
  };
}
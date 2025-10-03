/**
 * ModeAudio v2025-09-29-2 + autoDispose patch + ear request timeout (2025-10-02)
 *  - 保留 v2025-09-29-2 中的电量防闪烁增量刷新实现
 *  - autoDisposeWhenRemoved: 组件被直接从 DOM 移除时自动 destroy
 *  - offSuspend / offResume: 保存轮询事件注销函数，destroy 时清理
 *  - __destroyed 标记 & start()/scheduleRetry() 守卫
 *  - 新增：耳朵(L/R)点击请求 5 秒超时；成功 / 失败 / 超时均解除“按下”禁止再次点击
 *  - 新增：在 setData 中保留旧探头的请求中标记与定时器，避免轮询刷新时丢失 pending 状态
 *  - 新增：destroy 清理耳朵请求定时器
 *  - 其它业务逻辑未改
 */
import { androidWsApi, AndroidTopics } from '@api/androidWSApi.js';
import { modePoller } from './mode-poller.js';
import { FAIL_TOAST_PREFIX, SLOT_COUNT } from '/config/constants.js';

console.log('[ModeAudio] loaded version v2025-09-29-2+autoDispose+earTimeout');

const EAR_IMG = {
  L: { normal:'/res/ear_left_normal.png',  press:'/res/ear_left_press.png',  select:'/res/ear_left_select.png' },
  R: { normal:'/res/ear_right_normal.png', press:'/res/ear_right_press.png', select:'/res/ear_right_select.png' }
};
const WIFI_IMG = '/res/wifi4.png';
const DBG = () => (window.__AUDIO_EAR_DBG === true);

function preloadImages(){
  [EAR_IMG.L.normal,EAR_IMG.L.press,EAR_IMG.L.select,
   EAR_IMG.R.normal,EAR_IMG.R.press,EAR_IMG.R.select,
   WIFI_IMG].forEach(src=>{ const im=new Image(); im.src=src; });
}
preloadImages();

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

// --- 新增：耳机请求超时管理 ---
const EAR_REQUEST_TIMEOUT_MS = 5000;

function startEarRequestTimer(p, side, rollbackFn){
  clearEarRequestTimer(p, side);
  const timer = setTimeout(()=>{
    if(side==='L' && p.leftRequestingFlag){
      rollbackFn(p,'L');
      try{ window.eventBus?.emit('toast:show',{ type:'error', message:'左耳操作超时' }); }catch{}
    }else if(side==='R' && p.rightRequestingFlag){
      rollbackFn(p,'R');
      try{ window.eventBus?.emit('toast:show',{ type:'error', message:'右耳操作超时' }); }catch{}
    }
  }, EAR_REQUEST_TIMEOUT_MS);
  if(side==='L') p.leftTimer = timer; else p.rightTimer = timer;
}

function clearEarRequestTimer(p, side){
  if(side==='L' && p.leftTimer){
    clearTimeout(p.leftTimer); p.leftTimer=null;
  }else if(side==='R' && p.rightTimer){
    clearTimeout(p.rightTimer); p.rightTimer=null;
  }
}

export function createModeAudio({ devId, layout='thumb' } = {}) {
  const MAX = SLOT_COUNT;
  const isDetail = layout === 'detail';

  const host = document.createElement('div');
  const root = host.attachShadow({ mode:'open' });
  host.style.position='relative';

  let cv=null, ctx=null, emptyEl=null;
  let refreshBtn=null, loadingEl=null, bottomWrap=null;
  let suspended=false, loadingCount=0;

  let pendingDevId = devId;
  let startedOk=false;
  let retryTimer=null, retryCount=0;

  // 事件注销函数 & 销毁标记
  let offSuspend=null;
  let offResume=null;
  let __destroyed=false;

  // 音频播放
  let audioPlayer=null;
  let currentStreamURI=null;

  // === A 方案新增：逻辑打开 & 订阅控制 ===
  let __opened=false;
  let __pollSubscribed=false;
  let __pollUnsub=null;
  function ensureSubscribe(n){
    if(__destroyed || !__opened) return;
    if(__pollSubscribed) return;
    const unsub=modePoller.subscribe({ cmd:'audioOneChannel', devId:n, intervalMs:300 });
    try{ modePoller.resume('audioOneChannel', n, { immediate:true }); }catch{}
    __pollUnsub = () => { try{unsub();}catch{}; __pollSubscribed=false; __pollUnsub=null; };
    __pollSubscribed=true;
  }
  function ensureUnsubscribe(){
    if(!__pollSubscribed) return;
    if(__pollUnsub){ try{__pollUnsub();}catch{} }
    __pollSubscribed=false;
    __pollUnsub=null;
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

  async function ensureAudioLib(){
    if(window.SrsRtcPlayerAsync) return;
    await new Promise((res,rej)=>{
      const s=document.createElement('script'); s.src='/js/adapter-7.4.0.min.js';
      s.onload=res; s.onerror=()=>rej(new Error('adapter load fail'));
      document.head.appendChild(s);
    }).catch(()=>{});
    if(window.SrsRtcPlayerAsync) return;
    await new Promise((res,rej)=>{
      const s=document.createElement('script'); s.src='/js/srs.sdk.js';
      s.onload=res; s.onerror=()=>rej(new Error('srs sdk load fail'));
      document.head.appendChild(s);
    }).catch(()=>{});
  }
  async function startAudioPlay(uri){
    if(!uri) return false;
    await ensureAudioLib();
    if(!window.SrsRtcPlayerAsync){
      toast('error','音频组件缺失');
      return false;
    }
    try{
      await stopAudioPlay();
      audioPlayer = new SrsRtcPlayerAsync();
      const a=document.createElement('audio');
      a.autoplay=true; a.controls=false; a.muted=false; a.style.display='none';
      document.body.appendChild(a);
      a.srcObject=audioPlayer.stream;
      await audioPlayer.play(uri);
      currentStreamURI = uri;
      return true;
    }catch(e){
      console.warn('[ModeAudio] startAudioPlay fail', e);
      toast('error','音频播放失败');
      try{ stopAudioPlay(); }catch{}
      return false;
    }
  }
  async function stopAudioPlay(){
    try{
      if(audioPlayer && audioPlayer.close) audioPlayer.close();
      if(audioPlayer?.stream?.getTracks){
        audioPlayer.stream.getTracks().forEach(t=>{ try{t.stop();}catch{} });
      }
    }catch{}
    audioPlayer=null;
    currentStreamURI=null;
  }

  function toast(type,message){
    try{ window.eventBus?.emit('toast:show',{ type, message }); }
    catch{ console.log('[ModeAudio][Toast]', type, message); }
  }

  function clearRetry(){ if(retryTimer){ clearInterval(retryTimer); retryTimer=null; } }
  function scheduleRetry(){
    if(retryTimer || startedOk) return;
    retryTimer=setInterval(()=>{
      if(__destroyed){ clearRetry(); return; }
      if(startedOk){ clearRetry(); return; }
      if(retryCount++>40){ clearRetry(); console.warn('[ModeAudio][start-abort] devId invalid still'); return; }
      if(Number.isFinite(Number(pendingDevId))){ start(); clearRetry(); }
    },250);
  }

  const tplReady = (async()=>{
    const html = await fetch('/modules/features/pages/modes/mode-audio.html',{cache:'no-cache'}).then(r=>r.text());
    const doc  = new DOMParser().parseFromString(html,'text/html');
    const frag = doc.querySelector('#tpl-mode-audio').content.cloneNode(true);

    const auxWrap = document.createElement('div');
    Object.assign(auxWrap.style,{position:'absolute',top:'4px',right:'4px',display:'flex',gap:'6px',zIndex:'10'});
    refreshBtn = document.createElement('div');
    refreshBtn.textContent='⟳'; refreshBtn.title='刷新';
    refreshBtn.setAttribute('data-refresh-btn','');
    Object.assign(refreshBtn.style,{
      width:'22px',height:'22px',lineHeight:'22px',textAlign:'center',
      fontSize:'14px',background:'#123',color:'#9ec3ff',border:'1px solid #345',
      borderRadius:'4px',cursor:'pointer',display:'none',userSelect:'none'
    });
    refreshBtn.onclick=()=>{
      if(suspended){ modePoller.resume('audioOneChannel', devId, { immediate:true }); hideRefresh(); }
      else forceFetch();
    };
    loadingEl = document.createElement('div');
    Object.assign(loadingEl.style,{
      width:'22px',height:'22px',border:'3px solid #2a5b8a',
      borderTopColor:'#9ec3ff',borderRadius:'50%',animation:'spin .8s linear infinite',display:'none'
    });
    const spinStyle=document.createElement('style');
    spinStyle.textContent='@keyframes spin{to{transform:rotate(360deg)}}';
    root.appendChild(spinStyle);
    auxWrap.append(refreshBtn,loadingEl);
    frag.appendChild(auxWrap);

    bottomWrap = document.createElement('div');
    Object.assign(bottomWrap.style,{
      position:'absolute',left:'0',right:'0',bottom:'0',
      display:'grid',gridTemplateColumns:`repeat(${MAX},1fr)`,
      alignItems:'end',padding:'0 4px 4px 4px',fontSize:'12px',pointerEvents:'auto'
    });

    const style = document.createElement('style');
    style.textContent=`
      .slot-wrap{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:2px;color:#fff;user-select:none;padding:0 2px;}
      .slot-simple{display:flex;flex-direction:column;align-items:center;gap:4px;}
      .slot-simple .batt{width:24px;height:12px;}
      .slot-simple .batt img{width:100%;height:100%;display:block;object-fit:contain;}
      .slot-simple .probe-id{font-size:12px;font-weight:600;}
      .top-icons{display:flex;align-items:center;justify-content:center;gap:6px;min-height:16px;line-height:1;}
      .top-icons img{display:block;object-fit:contain;}
      .top-icons img.wifi{width:24px;height:16px;}
      .top-icons img.batt{width:24px;height:12px;}
      .ears{display:flex;align-items:center;justify-content:center;gap:6px;min-height:32px;}
      .ears img.ear{width:28px;height:24px;object-fit:contain;display:block;cursor:pointer;transition:transform .12s;}
      .ears img.ear.disabled{cursor:not-allowed;filter:grayscale(.5);opacity:.6;}
      .ears .pid{font-size:12px;font-weight:700;line-height:1;padding:0 2px;position:relative;top:0;}
    `;
    root.appendChild(style);

    root.appendChild(frag);
    root.appendChild(bottomWrap);

    cv = root.getElementById('cv');
    emptyEl = root.getElementById('empty');
    ctx = cv.getContext('2d');

    if(loadingCount>0 && !suspended) loadingEl.style.display='block';

    drawBars([],MAX);
    window.addEventListener('resize', onResize, { passive:true });
    initResizeObserver();
  })();

  const state={ probes:[], values:new Array(MAX).fill(0) };
  let rafPending=false;

  function showLoading(){ if(suspended)return; loadingCount++; if(loadingEl && loadingEl.style.display!=='block') loadingEl.style.display='block'; }
  function hideLoading(){ loadingCount=Math.max(0,loadingCount-1); if(loadingCount===0 && loadingEl) loadingEl.style.display='none'; }
  function showRefresh(){
    loadingCount=0;
    if(loadingEl) loadingEl.style.display='none';
    if(refreshBtn) refreshBtn.style.display='block';
    host.dataset.suspended='1';
    tplReady.then(()=>{
      if(suspended && refreshBtn && refreshBtn.style.display==='none'){
        refreshBtn.style.display='block';
      }
    });
  }
  function hideRefresh(){ if(refreshBtn) refreshBtn.style.display='none'; delete host.dataset.suspended; }
  function forceFetch(){
    if(suspended) return;
    if(!startedOk){ start(); if(!startedOk) return; }
    const n=Number(devId);
    if(!Number.isFinite(n)){ console.warn('[ModeAudio][force-fetch-skip] invalid devId', devId); return; }
    if(DBG()) console.log('[ModeAudio][forceFetch]');
    showLoading();
    androidWsApi.forceListFetch('audioOneChannel', n);
  }

  function fitCanvas(){
    if(!cv) return 1;
    const dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1));
    const w=Math.round(cv.clientWidth*dpr), h=Math.round(cv.clientHeight*dpr);
    if(cv.width!==w || cv.height!==h){ cv.width=w; cv.height=h; }
    return dpr;
  }
  function __getBottomTopCss(){
    try{
      if(!cv || !bottomWrap) return null;
      const rc=cv.getBoundingClientRect(), rb=bottomWrap.getBoundingClientRect();
      return rb.top - rc.top;
    }catch{return null;}
  }
  function __stabilizedRedraw(maxFrames=8){
    let frame=0,last=null;
    function step(){
      frame++;
      const t=__getBottomTopCss();
      drawBars(state.values,MAX);
      if(t==null){ if(frame<maxFrames) requestAnimationFrame(step); return; }
      if(last!=null && Math.abs(t-last)<0.5) return;
      last=t;
      if(frame<maxFrames) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function onResize(){
    if(rafPending) return;
    rafPending=true;
    requestAnimationFrame(()=>{ rafPending=false; drawBars(state.values,MAX); __stabilizedRedraw(); });
  }
  let ro=null;
  function initResizeObserver(){
    if(typeof ResizeObserver!=='function' || ro) return;
    ro=new ResizeObserver(()=>__stabilizedRedraw());
    try{ ro.observe(bottomWrap);}catch{}
    try{ ro.observe(cv);}catch{}
  }

  function drawBars(values,totalSlots){
    if(!cv || !ctx) return;
    const dpr=fitCanvas(); const W=cv.width,H=cv.height;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle='#000'; ctx.fillRect(0,0,W,H);

    const bottomTopCss=__getBottomTopCss();
    const marginTop=14*dpr, gap=2*dpr, originX=28*dpr;
    let originY;
    if(bottomTopCss==null || bottomTopCss<10){
      originY = H - (gap + (isDetail?26:14)*dpr);
      if(!drawBars.__retry){
        drawBars.__retry=true;
        requestAnimationFrame(()=>{ drawBars.__retry=false; drawBars(state.values,MAX); });
      }
    }else{
      originY = bottomTopCss*dpr - gap;
    }
    let chartH=originY - marginTop;
    if(chartH<10*dpr){ chartH=10*dpr; originY=marginTop+chartH; }

    try{
      const lp=(originX/dpr);
      if(bottomWrap && bottomWrap.style.paddingLeft!==lp+'px') bottomWrap.style.paddingLeft=lp+'px';
    }catch{}

    ctx.strokeStyle='rgba(255,255,255,0.30)';
    ctx.lineWidth=1*dpr;
    ctx.fillStyle='#fff';
    ctx.font=`${10*dpr}px system-ui,Segoe UI,Roboto`;
    ctx.textAlign='right'; ctx.textBaseline='middle';
    const ticks=[0,20,40,60,80,100];
    for(const v of ticks){
      const yy=originY - (v/100)*chartH;
      ctx.beginPath(); ctx.moveTo(originX,Math.round(yy)+0.5); ctx.lineTo(W-2,Math.round(yy)+0.5); ctx.stroke();
      ctx.fillText(String(v), originX-4*dpr, v===0? yy - 4*dpr : yy);
    }
    ctx.beginPath(); ctx.moveTo(originX+0.5,originY); ctx.lineTo(originX+0.5,originY-chartH); ctx.stroke();

    const slotW=(W-originX-2)/MAX;
    const innerGap=Math.min(slotW*0.15,6*dpr);
    const barW=Math.max(2*dpr, slotW - innerGap*2);
    ctx.textAlign='center'; ctx.textBaseline='bottom';
    ctx.font=`${12*dpr}px system-ui,Segoe UI,Roboto`;

    const active=state.probes.length;
    for(let i=0;i<active && i<MAX;i++){
      const v=Math.max(0,Math.min(100,Number(values[i])||0));
      const slotLeft=originX + i*slotW;
      const h=(v/100)*chartH;
      const x=Math.round(slotLeft + innerGap);
      const y=Math.round(originY - h);
      ctx.fillStyle='#fff';
      ctx.fillRect(x,y,Math.round(barW),Math.round(h));
      ctx.fillStyle='#fff';
      ctx.fillText(String(Math.round(v)), slotLeft + slotW/2, y - 2*dpr);
    }
  }

  function buildSlot(p,i){
    const slot=document.createElement('div');
    slot.className='slot-wrap';
    slot.dataset.index=String(i);
    slot.dataset.probeId=String(p.probeId||'');
    if(isDetail){
      const topIcons=document.createElement('div');
      topIcons.className='top-icons';
      const wifi=document.createElement('img'); wifi.className='wifi'; wifi.src=WIFI_IMG;
      const batt=document.createElement('img'); batt.className='batt'; batt.dataset.level='';
      topIcons.append(wifi,batt);

      const ears=document.createElement('div');
      ears.className='ears';
      const earL=document.createElement('img');
      earL.className='ear left'; earL.dataset.side='L'; earL.draggable=false;
      const earR=document.createElement('img');
      earR.className='ear right'; earR.dataset.side='R'; earR.draggable=false;
      const pid=document.createElement('div');
      pid.className='pid'; pid.textContent=String(p.probeId);
      ears.append(earL,pid,earR);
      slot.append(topIcons, ears);
    }else{
      const simple=document.createElement('div');
      simple.className='slot-simple';
      const battDiv=document.createElement('div'); battDiv.className='batt';
      const battImg=document.createElement('img'); battImg.dataset.level='';
      battDiv.appendChild(battImg);
      const pid=document.createElement('div'); pid.className='probe-id'; pid.textContent=String(p.probeId);
      simple.append(battDiv,pid);
      slot.append(simple);
    }
    return slot;
  }

  function updateBatteries(){
    const list=state.probes;
    const len=Math.min(list.length, bottomWrap.children.length);
    for(let i=0;i<len;i++){
      const p=list[i];
      const slot=bottomWrap.children[i];
      if(!slot) continue;
      const battImg = slot.querySelector('img.batt') || slot.querySelector('.batt img');
      if(battImg){
        const lvl=`${mapBattery7(p.battery)}`;
        if(battImg.dataset.level!==lvl){
          battImg.dataset.level=lvl;
          battImg.src=`/res/bat${lvl}.png`;
        }
      }
    }
  }

  function rebuildBottomIfNeeded(){
    if(!bottomWrap) return;
    const list=state.probes;
    const needRebuild = bottomWrap.children.length !== Math.min(list.length,MAX);
    if(needRebuild){
      bottomWrap.innerHTML='';
      for(let i=0;i<list.length && i<MAX;i++){
        bottomWrap.appendChild(buildSlot(list[i],i));
      }
      if(isDetail) bindEarEvents();
    }
    updateBatteries();
    refreshAllEarIcons();
  }

  function refreshEarIconByProbe(p, slot){
    if(!slot) return;
    const earL = slot.querySelector('img.ear.left');
    const earR = slot.querySelector('img.ear.right');
    if(earL){
      const req = !!p.leftRequestingFlag;
      earL.src = req ? EAR_IMG.L.press :
        (p.isLeftHeadset ? EAR_IMG.L.select : EAR_IMG.L.normal);
      earL.classList.toggle('disabled', req);
    }
    if(earR){
      const req = !!p.rightRequestingFlag;
      earR.src = req ? EAR_IMG.R.press :
        (p.isRightHeadset ? EAR_IMG.R.select : EAR_IMG.R.normal);
      earR.classList.toggle('disabled', req);
    }
  }
  function refreshAllEarIcons(){
    if(!isDetail || !bottomWrap) return;
    const list=state.probes;
    for(let i=0;i<list.length && i<MAX;i++){
      const slot=bottomWrap.children[i];
      refreshEarIconByProbe(list[i], slot);
    }
  }

  function bindEarEvents(){
    if(!bottomWrap || bottomWrap.__earBound) return;
    bottomWrap.__earBound=true;
    bottomWrap.addEventListener('click', (e)=>{
      const img=e.target.closest('img.ear');
      if(!img) return;
      const slot=img.closest('.slot-wrap'); if(!slot) return;
      const idx=Number(slot.dataset.index);
      const p=state.probes[idx];
      if(!p) return;
      const side=img.dataset.side==='L'?'L':'R';
      if(side==='L'){
        if(p.leftRequestingFlag) return;
        handleEarToggle(p, idx, 'L');
      }else{
        if(p.rightRequestingFlag) return;
        handleEarToggle(p, idx, 'R');
      }
    });
  }

  // 替换: 加入超时定时器
  // 替换: handleEarToggle —— 补上 toId，其他逻辑保持
  function handleEarToggle(p, idx, side){
    const devNum=Number(devId);
    if(!Number.isFinite(devNum)){ console.warn('[ModeAudio] invalid devId'); return; }
    const isLeft = side==='L';
    const listening = isLeft ? !!p.isLeftHeadset : !!p.isRightHeadset;

    if(isLeft){
      p.__prevLeft = p.isLeftHeadset;
      p.leftRequestingFlag = true;
    }else{
      p.__prevRight = p.isRightHeadset;
      p.rightRequestingFlag = true;
    }
    refreshEarIconByProbe(p, bottomWrap.children[idx]);

    const ts=Math.floor(Date.now()/1000);

    const payload = {
      probeId: p.probeId,
      timestamp: ts
    };
    if(isLeft){
      payload.isLeftHeadset = true;
      payload.isStart = !listening;
    }else{
      payload.isRightHeadset = true;
      payload.isStart = !listening;
    }

    if(listening){
      stopAudioPlay().catch(()=>{});
    }

    if(DBG()) console.log('[ModeAudio] controlAudioProbe send', { toId: devNum, ...payload });

    // 启动超时
    startEarRequestTimer(p, side, rollbackEar);

    androidWsApi.controlAudioProbe({ toId: devNum, ...payload }).then(()=>{
      // 响应统一由 ControlAudioProbeResponse 处理
    }).catch(err=>{
      if(DBG()) console.warn('[ModeAudio] controlAudioProbe fail (promise rejection)', err);
      clearEarRequestTimer(p, side);
      rollbackEar(p, side);
    });
  }

  // 替换：rollbackEar 清除定时器
  function rollbackEar(p, side){
    if(side==='L'){
      clearEarRequestTimer(p,'L');
      if(p.__prevLeft !== undefined) p.isLeftHeadset = p.__prevLeft;
      p.leftRequestingFlag = false;
    }else{
      clearEarRequestTimer(p,'R');
      if(p.__prevRight !== undefined) p.isRightHeadset = p.__prevRight;
      p.rightRequestingFlag = false;
    }
    refreshAllEarIcons();
  }

  // 替换：applySuccess 清除定时器
  function applySuccess(p, side, started, streamURI){
    if(side==='L'){
      clearEarRequestTimer(p,'L');
      p.isLeftHeadset = started;
      p.leftRequestingFlag = false;
    }else{
      clearEarRequestTimer(p,'R');
      p.isRightHeadset = started;
      p.rightRequestingFlag = false;
    }
    if(started && streamURI){
      startAudioPlay(streamURI);
    }else if(!started){
      stopAudioPlay();
    }
    refreshAllEarIcons();
  }

  // 替换：setData 保留旧的请求标记和定时器
  // 替换：setData —— 复用旧对象引用，避免计时器回滚丢失；请求中不覆盖请求侧耳朵状态
  function setData(list){
    hideLoading();
    const arr = Array.isArray(list) ? list.slice(0,MAX) : [];
    const oldMap = new Map();
    state.probes.forEach(o=>oldMap.set(String(o.probeId), o));

    const newProbes = [];
    for(let i=0;i<arr.length;i++){
      const raw = arr[i];
      const key = String(raw.probeId);
      let obj = oldMap.get(key);
      if(!obj){
        obj = {
          probeId: raw.probeId,
          volume:0,
          battery:0,
          isLeftHeadset:false,
          isRightHeadset:false,
          leftRequestingFlag:false,
          rightRequestingFlag:false,
            __prevLeft:undefined,
          __prevRight:undefined,
          leftTimer:null,
          rightTimer:null
        };
      }
      obj.volume = Number(raw.volume)||0;
      obj.battery = Number(raw.battery)||0;

      // 正在请求的那一侧不覆盖（防止 300ms 轮询打断“按下”过程）
      if(!obj.leftRequestingFlag){
        obj.isLeftHeadset = !!raw.isLeftHeadset;
      }
      if(!obj.rightRequestingFlag){
        obj.isRightHeadset = !!raw.isRightHeadset;
      }

      newProbes.push(obj);
    }

    state.probes = newProbes;
    state.values = new Array(MAX).fill(0);
    for(let i=0;i<newProbes.length;i++){
      state.values[i] = Math.max(0,Math.min(100,Number(newProbes[i].volume)||0));
    }

    if(emptyEl) emptyEl.style.display = newProbes.length>0 ? 'none':'flex';

    if(bottomWrap){
      rebuildBottomIfNeeded();
      drawBars(state.values,MAX);
      requestAnimationFrame(()=>drawBars(state.values,MAX));
    }else{
      tplReady.then(()=>{
        rebuildBottomIfNeeded();
        drawBars(state.values,MAX);
        requestAnimationFrame(()=>drawBars(state.values,MAX));
      });
    }

    if(newProbes.length>0){
      host.dataset.hasData='1';
      if(!suspended) delete host.dataset.suspended;
    }
  }

  // doStartAfterTpl（未改核心逻辑，只保留原来 + watchdog）
  function doStartAfterTpl(n){
    if(DBG()) console.log('[ModeAudio][doStartAfterTpl] devId=', n);
    const off1=androidWsApi.onByDev(AndroidTopics.AudioOneChannelResponse, n, msg=>{
      if(msg && msg.code===0){
        const isEmptyObj = msg.data && typeof msg.data==='object' && !Array.isArray(msg.data) && Object.keys(msg.data).length===0;
        const list = Array.isArray(msg.data) ? msg.data : (isEmptyObj || msg.data==null ? [] : null);
        if(list!==null){
          modePoller.markSuccess('audioOneChannel', n, msg.requestId);
            setData(list);
            hideLoading();
        }
      }
    });
    const off2=androidWsApi.onByDev(AndroidTopics.ControlAudioProbeResponse, n, msg=>{
      if(!msg) return;
      const ok = msg.code===0;
      const data = msg.data || {};
      const streamURI = data.streamURI;
      state.probes.forEach(p=>{
        let changed=false;
        if(p.leftRequestingFlag){
          const targetOn = !p.__prevLeft;
          if(ok){
            applySuccess(p,'L', targetOn, targetOn? streamURI: null);
          }else{
            rollbackEar(p,'L');
            toast('error',(FAIL_TOAST_PREFIX||'')+(msg.msg||'左耳操作失败'));
          }
          changed=true;
        }
        if(p.rightRequestingFlag){
          const targetOn = !p.__prevRight;
          if(ok){
            applySuccess(p,'R', targetOn, targetOn? streamURI: null);
          }else{
            rollbackEar(p,'R');
            toast('error',(FAIL_TOAST_PREFIX||'')+(msg.msg||'右耳操作失败'));
          }
          changed=true;
        }
        if(changed && DBG()) console.log('[ModeAudio] controlAudioProbeResponse handled',{ probeId:p.probeId, ok });
      });
    });

    // 订阅改为由 ensureSubscribe 控制
    ensureSubscribe(n);

    offSuspend = modePoller.on('suspend', ({cmd,devId:d})=>{
      if(cmd==='audioOneChannel' && String(d)===String(n)){
        suspended=true; hideLoading(); showRefresh();
        try{ window.eventBus?.emit('toast:show',{ type:'warn', message:`${FAIL_TOAST_PREFIX}${n}` }); }catch{}
      }
    });
    offResume = modePoller.on('resume', ({cmd,devId:d})=>{
      if(cmd==='audioOneChannel' && String(d)===String(n)){
        suspended=false; hideRefresh(); showLoading();
      }
    });
    host.__offList=[off1, off2];
    autoDisposeWhenRemoved();

    // watchdog: 若 600ms 后仍 suspended 且按钮未显示则强制显示
    setTimeout(()=>{
      if(__destroyed) return;
      if(suspended && refreshBtn && refreshBtn.style.display==='none'){
        refreshBtn.style.display='block';
      }
    },600);
  }

  function start(){
    if(__destroyed) return;
    const n=Number(pendingDevId);
    if(!Number.isFinite(n)){ console.warn('[ModeAudio][start-wait] invalid devId', pendingDevId); scheduleRetry(); return; }
    if(startedOk) return;
    devId=n; startedOk=true; clearRetry();
    tplReady.then(()=>doStartAfterTpl(n));
    window.addEventListener('resize', onResize, { passive:true });
    setOpened(true); // start 即视为逻辑打开
  }

  // 替换：destroy - 增加清理耳朵请求定时器
  function destroy(){
    if(__destroyed) return;
    __destroyed=true;
    // 确保逻辑关闭（幂等：若已关闭不会重复退订）
    try { setOpened(false); } catch {}
    ensureUnsubscribe();
    clearRetry();
    try{ window.removeEventListener('resize', onResize); }catch{}
    try{ host.__offList && host.__offList.forEach(fn=>fn&&fn()); }catch{}
    try{ if(typeof offSuspend==='function') offSuspend(); }catch{}
    try{ if(typeof offResume==='function') offResume(); }catch{}
    try{ ro && ro.disconnect(); }catch{}
    try{ stopAudioPlay(); }catch{}
    try{
      state.probes.forEach(p=>{
        if(p.leftTimer){ clearTimeout(p.leftTimer); p.leftTimer=null; }
        if(p.rightTimer){ clearTimeout(p.rightTimer); p.rightTimer=null; }
      });
    }catch{}
    try{ host.remove(); }catch{}
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
    el:host,
    start,
    setData:()=>{},    // 外部不直接调用内部 setData
    destroy,
    __devId:devId,
    __modeId:3,
    forceRefresh:()=>forceFetch(),
    showLoading,
    hideLoading,
    setOpened,          // 方案A新增
    setDevId(v){
      if(v!=null && v!==''){
        pendingDevId=v;
        if(!startedOk && !__destroyed) start();
      }
    }
  };
}
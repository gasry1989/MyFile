import { androidWsApi } from '@api/androidWSApi.js';
import { eventBus } from '@core/eventBus.js';
import { apiDeviceInfo } from '@api/deviceApi.js';
import { authLoadToken } from '@core/auth.js';
import { apiStreamUrl } from '@api/userApi.js';

const PAGE_MODEL_MAP = {
  'mode-tilt': 1,
  'mode-disp-tilt': 2,
  'mode-audio': 3,
  'video': 4,
  'device': 5
};

// === 再次仅替换 mountTopbar：修正编号(label)不再占满，把“在线 + 刷新”紧贴编号右侧 4px，编号可根据余量自动收缩省略；左侧整块贴左，右侧动作区靠右 ===
export function mountTopbar(container) {
  const bar = document.createElement('div');
  bar.id = 'detailTopbar';
  bar.innerHTML = `
    <style>
      #detailTopbar{
        height:48px;
        display:flex;
        align-items:center;
        padding:0 12px;
        background:#111c28;
        color:#e6f0ff;
        border-bottom:1px solid rgba(255,255,255,.12);
        font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;
        user-select:none;
        overflow:hidden;
      }
      #detailTopbar .btn{
        background:#1f7fb8;
        border:1px solid rgba(255,255,255,.25);
        color:#fff;
        border-radius:6px;
        height:32px;
        padding:0 12px;
        cursor:pointer;
        font-weight:600;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        line-height:1;
        white-space:nowrap;
        font-size:13px;
      }
      #detailTopbar .btn.secondary{ background:#1f497d; }
      #btnBack{ background:#2a8fbc; margin-right:8px; }

      /* 左块：紧贴左侧，内部元素自然排列，不拉伸留空 */
      .dc-left{
        flex:0 1 auto;
        display:flex;
        align-items:center;
        min-width:0;
        overflow:hidden;
      }
      /* 编号/名称标签：不再 flex-grow，允许收缩并省略；与后面状态保持只 4px 间距 */
      #lblDevNo{
        flex:0 1 auto;
        min-width:40px;
        max-width:60vw; /* 防止极端超长撑爆；可按需调整 */
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        font-weight:600;
      }
      /* 状态标签紧随编号，固定 margin-left:4px */
      #lblOnline{
        flex:0 0 auto;
        margin-left:4px;
        color:#aee6a7;
        font-weight:600;
        min-width:40px;
        font-size:13px;
        white-space:nowrap;
      }
      #lblOnline.offline{ color:#ff7979; }
      /* 刷新按钮紧跟状态，再 4px */
      #btnOnlineRefresh{
        flex:0 0 auto;
        width:32px;
        padding:0;
        font-size:16px;
        margin-left:4px;
      }

      /* 右侧动作区占剩余空间右对齐 */
      .dc-actions{
        flex:1 1 auto;
        display:flex;
        align-items:center;
        justify-content:flex-end;
        gap:8px;
        min-width:0;
        margin-left:16px; /* 与左块有一段缓冲，可按需改小/去掉 */
      }

      #btnVolume{
        font-size:0;
        line-height:1;
        cursor:pointer;
        background:transparent;
        border:none;
        width:32px;
        height:32px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        position:relative;
        padding:0;
      }
      #btnVolume img{width:24px;height:24px;display:block;}

      #lblConnTimer{
        color:#cfd8dc;
        opacity:.85;
        white-space:nowrap;
        font-size:12px;
        padding-left:4px;
      }

      #detailTopbar.offline .btn:not(#btnBack):not(#btnOnlineRefresh),
      #detailTopbar.offline #btnVolume{
        filter:grayscale(.6) brightness(.7);
        pointer-events:none;
        cursor:not-allowed;
      }
      #detailTopbar.offline #lblOnline{ color:#ff5d5d; }

      #btnVolume[aria-state="request"],
      #btnRecord[aria-busy="true"],
      #btnShot[aria-busy="true"],
      #btnTalk[aria-busy="true"]{
        opacity:.55; pointer-events:none;
      }
    </style>
    <button class="btn" id="btnBack">返回</button>
    <div class="dc-left">
      <div id="lblDevNo">--</div>
      <div id="lblOnline" class="offline">离线</div>
      <button class="btn secondary" id="btnOnlineRefresh" title="刷新在线状态">⟳</button>
    </div>
    <div class="dc-actions">
      <button class="btn secondary" id="btnShot">拍照</button>
      <button class="btn secondary" id="btnRecord">开始录像</button>
      <button id="btnVolume" title="音频"><img id="icVolume" src="/res/volume_off.png" alt="音量"/></button>
      <button class="btn" id="btnTalk">开始对讲</button>
      <div id="lblConnTimer">未连接 00:00:00</div>
    </div>
  `;
  container.appendChild(bar);

  const els = {
    root: bar,
    btnBack: bar.querySelector('#btnBack'),
    lblDevNo: bar.querySelector('#lblDevNo'),
    lblOnline: bar.querySelector('#lblOnline'),
    btnOnlineRefresh: bar.querySelector('#btnOnlineRefresh'),
    btnShot: bar.querySelector('#btnShot'),
    btnRecord: bar.querySelector('#btnRecord'),
    btnVolume: bar.querySelector('#btnVolume'),
    icVolume: bar.querySelector('#icVolume'),
    btnTalk: bar.querySelector('#btnTalk'),
    lblConnTimer: bar.querySelector('#lblConnTimer')
  };
  els.btnBack.onclick = ()=> parent.postMessage({ __detail:true, t:'back' }, '*');
  return els;
}

function toast(type, message){
  try { eventBus.emit('toast:show', { type, message }); }
  catch { console.log('[toast-fallback]', type, message); }
}

// 替换函数：setupTopbarControls
// 新增：
// 1) refreshDeviceMeta()：刷新设备基础信息(设备ID / 名称 / 编号)，与在线刷新解耦；手动刷新按钮现在同时调用 refreshOnline + refreshDeviceMeta。
// 2) 监听 eventBus: 'device:updated' 事件（由编辑设备信息弹窗发出），当当前详情页设备匹配时立即刷新标题栏信息。
// 3) 将 buildDevLabel / tryFetchDevLabel 逻辑整合到可重复调用；标题栏改动后不会被后续在线刷新覆盖。
// 4) 返回对象新增 refreshDeviceMeta 方法（若外层还想手动触发）。
/* ===== 替换：setupTopbarControls（合并刷新；刷新按钮只请求一次 apiDeviceInfo） ===== */
export function setupTopbarControls(opts){
  const {
    ui,
    page,
    getDevIdNum,
    onVolumeToggle,
    extraToastPrefix=''
  } = opts || {};

  if(!ui || typeof getDevIdNum !== 'function'){
    console.warn('[setupTopbarControls] invalid args');
    return { updateWsChannel(){}, getState(){}, refreshOnline(){}, refreshDeviceMeta(){}, stopAll(){} };
  }

  /* ----- 顶栏设备标签逻辑（带重试） ----- */
  let __devLabelFetched = false;
  let __devLabelTries = 0;
  const __DEV_LABEL_MAX_TRIES = 20;
  const __DEV_LABEL_INTERVAL = 250;

  function buildDevLabel(id, name, no){
    const idPart  = (id!=null && id!=='') ? String(id) : '';
    const namePart= (name!=null) ? String(name) : '';
    const noPart  = (no!=null && no!=='') ? String(no) : '';
    return (idPart + ' ' + namePart + ' ' + noPart).trimEnd();
  }
  function applyDevInfoToLabel(di, fallbackId){
    if(!ui.lblDevNo) return;
    const label = buildDevLabel(
      di && di.id!=null ? di.id : fallbackId,
      di && di.name ? di.name : '',
      di && (di.no || di.devNo) ? (di.no || di.devNo) : ''
    );
    ui.lblDevNo.textContent = label || '--';
  }
  async function refreshDeviceMeta(force=false){
    const idNum = getDevIdNum();
    if(idNum == null) return;
    if(__devLabelFetched && !force) return;
    try{
      const resp = await apiDeviceInfo(idNum);
      const di = resp?.devInfo || {};
      applyDevInfoToLabel(di, idNum);
      __devLabelFetched = true;
      return di;
    }catch(e){
      if(force){
        console.warn('[detail][refreshDeviceMeta] failed', e);
      }else if(__devLabelTries < __DEV_LABEL_MAX_TRIES){
        setTimeout(()=>refreshDeviceMeta(false), __DEV_LABEL_INTERVAL);
      }
    }
  }
  async function tryFetchDevLabel(){
    if(__devLabelFetched || __devLabelTries >= __DEV_LABEL_MAX_TRIES) return;
    __devLabelTries++;
    const idNum = getDevIdNum();
    if(idNum == null){
      setTimeout(tryFetchDevLabel, __DEV_LABEL_INTERVAL);
      return;
    }
    if(ui.lblDevNo && ui.lblDevNo.textContent && ui.lblDevNo.textContent !== '--' && ui.lblDevNo.textContent.trim() !== ''){
      __devLabelFetched = true;
      return;
    }
    await refreshDeviceMeta(false);
  }
  tryFetchDevLabel();

  /* ====== 以下原逻辑保持：对讲、拍照、录像、音量等（未改动的部分略） ===== */
  const TALK_LOG = (...a)=>console.log('[Talk]', ...a);
  const PAGE_MODEL_MAP = {
    'mode-tilt': 1,'mode-disp-tilt': 2,'mode-audio': 3,'video': 4,'device': 5
  };
  const model = PAGE_MODEL_MAP[page] || 5;

  let recording=false;
  let volumeState='off';
  let volumeStreamURI=null;

  let talkState=0;
  let talkElapsed=0;
  let talkTimer=null;
  let publisher=null;
  let publisherTracks=[];
  let waitingTimeout=null;
  let currentDevOnline=false;
  let pullInFlight=false;
  let proxyRetryCount=0;

  const PULL_ACCEPT_TIMEOUT_MS = 5000;
  const MAX_PROXY_RETRY = 2;
  const PROXY_RETRY_DELAY = 120;

  function toast(type, message){
    try { eventBus.emit('toast:show', { type, message }); }
    catch { console.log('[toast-fallback]', type, message); }
  }
  const nowSec = ()=>Math.floor(Date.now()/1000);
  function guardDevId(){
    const id = getDevIdNum();
    if(id==null){
      toast('warn', extraToastPrefix+'设备未就绪');
      return null;
    }
    return id;
  }
  function fmtElapsed(){
    const h=String(Math.floor(talkElapsed/3600)).padStart(2,'0');
    const m=String(Math.floor((talkElapsed%3600)/60)).padStart(2,'0');
    const s=String(talkElapsed%60).padStart(2,'0');
    return `${h}:${m}:${s}`;
  }
  function talkText(s){
    return ({
      0:'未连接',1:'正在请求流地址',2:'请求流地址失败',3:'请求流地址成功,正在推流',
      4:'推流失败',5:'推流成功,正在等待对接接听',6:'推流成功,对方拒绝',
      7:'推流成功,超时无人接听',8:'正在对讲'
    }[s]) || '未连接';
  }
  function updateStatusLabel(){
    ui.lblConnTimer.textContent = talkText(talkState)+' '+(talkState===8?fmtElapsed():'00:00:00');
  }
  function startTimer(){ clearInterval(talkTimer); talkElapsed=0; talkTimer=setInterval(()=>{ talkElapsed++; updateStatusLabel(); },1000); }
  function stopTimer(){ clearInterval(talkTimer); talkTimer=null; talkElapsed=0; }
  function setTalkState(s,{start=false,reset=false}={}){
    talkState=s;
    if(reset) stopTimer();
    if(start) startTimer();
    if(s===8){
      ui.btnTalk.textContent='停止对讲'; ui.btnTalk.removeAttribute('aria-busy');
    }else if([1,3,5].includes(s)){
      ui.btnTalk.textContent='开始对讲'; ui.btnTalk.setAttribute('aria-busy','true');
    }else{
      ui.btnTalk.textContent='开始对讲'; ui.btnTalk.removeAttribute('aria-busy');
    }
    updateStatusLabel();
  }
  function cleanupTalkTimers(){
    clearTimeout(waitingTimeout); waitingTimeout=null;
    pullInFlight=false;
  }
  function releasePublisher(){
    try{ publisherTracks.forEach(t=>{ try{ t.stop(); }catch{} }); }catch{}
    publisherTracks=[];
    try{ publisher?.close?.(); }catch{}
    publisher=null;
  }
  async function stopTalk(targetState){
    cleanupTalkTimers();
    releasePublisher();
    if(targetState==null || targetState===8) targetState=0;
    if([2,4,6,7].includes(targetState)){
      setTalkState(targetState,{reset:true});
    }else{
      setTalkState(0,{reset:true});
    }
  }
  async function startTalk(){
    if(!currentDevOnline) return;
    if([1,3,5].includes(talkState)) return;
    const id=guardDevId(); if(id==null) return;

    cleanupTalkTimers();
    proxyRetryCount=0;
    setTalkState(1,{reset:true});

    let streamURL=null;
    try{
      const r=await apiStreamUrl({ devId:id, hardwareType:3, hardwareIndex:0 });
      if(r?.code===0 && r?.data?.streamUriBase && r?.data?.streamID){
        streamURL='webrtc://'+r.data.streamUriBase+'/'+r.data.streamID;
      }else{
        await stopTalk(2); toast('error','对讲失败,无法获取推流地址'); return;
      }
    }catch{
      await stopTalk(2); toast('error','对讲失败,无法获取推流地址'); return;
    }

    setTalkState(3);
    try{
      await ensureSrsPublisherLib();
      if(!window.SrsRtcPublisherAsync) throw new Error('sdk missing');
      publisher=new SrsRtcPublisherAsync();
      publisher.constraints={ audio:true, video:false };
      await publisher.publish(streamURL);
      try{ publisherTracks=(publisher?.stream?.getTracks?.()||[]).slice(); }catch{}
    }catch{
      await stopTalk(4); toast('error','推流失败'); return;
    }

    setTalkState(5);
    pullInFlight=true;
    const deadline = performance.now()+PULL_ACCEPT_TIMEOUT_MS;
    waitingTimeout=setTimeout(async ()=>{
      if(talkState!==5) return;
      await stopTalk(7);
      toast('warn','推流成功,超时无人接听');
    }, PULL_ACCEPT_TIMEOUT_MS);

    const sendPull=async ()=>{
      if(!pullInFlight || talkState!==5) return;
      try{
        const resp=await androidWsApi.pullStream({ toId:id, startFlag:true, streamType:1, streamURI:streamURL });
        if(talkState!==5) return;
        if(resp && resp.code===0){
          cleanupTalkTimers();
          setTalkState(8,{start:true});
        }else{
          cleanupTalkTimers();
          await stopTalk(6);
          toast('error','推流成功,对方拒绝');
        }
      }catch(err){
        if(err?.code===-100 && /^(NO_ACK|NO_MASTER|POST_MESSAGE_FAIL)$/.test(err?.reason||'')
           && proxyRetryCount < MAX_PROXY_RETRY
           && performance.now() < deadline){
          proxyRetryCount++;
          setTimeout(sendPull, PROXY_RETRY_DELAY);
          return;
        }
      }
    };
    sendPull();
  }
  ui.btnTalk.onclick=async ()=>{
    if(ui.btnTalk.getAttribute('aria-busy')) return;
    if(talkState===8){ await stopTalk(0); return; }
    startTalk();
  };

  /* ---- 在线 / 设备信息合并刷新 ---- */
  let __lastOnlineFlag = null;
  let __onlineReqInFlight = false;
  function applyOnlineVisual(online){
    if(__lastOnlineFlag === online) return;
    __lastOnlineFlag = online;
    currentDevOnline = online;
    ui.lblOnline.textContent = online ? '在线':'离线';
    ui.lblOnline.classList.toggle('offline', !online);

    const disable = !online;
    const disableBtns=[ui.btnShot, ui.btnRecord, ui.btnVolume, ui.btnTalk];
    disableBtns.forEach(b=>{
      if(!b) return;
      if(disable){
        b.setAttribute('data-disabled','1');
        b.style.pointerEvents='none';
        b.style.opacity='0.65';
      }else{
        b.removeAttribute('data-disabled');
        b.style.pointerEvents='';
        b.style.opacity='';
      }
    });
    [ui.btnOnlineRefresh, ui.btnBack].forEach(b=>{
      if(!b) return;
      b.removeAttribute('data-disabled');
      b.style.pointerEvents='';
      b.style.opacity='';
    });
  }
  async function refreshOnline(mergeDeviceMeta=false){
    if(__onlineReqInFlight) return;
    const id = getDevIdNum(); if(id==null) return;
    __onlineReqInFlight = true;
    ui.lblOnline.dataset.loading='1';
    try{
      const resp = await apiDeviceInfo(id);
      const online = !!resp?.devInfo?.onlineState;
      applyOnlineVisual(online);
      if(mergeDeviceMeta){
        try { applyDevInfoToLabel(resp?.devInfo||{}, id); __devLabelFetched=true; } catch {}
      }
    }catch{
      applyOnlineVisual(false);
    }finally{
      delete ui.lblOnline.dataset.loading;
      __onlineReqInFlight = false;
    }
  }

  // 刷新按钮：单次请求同时刷新在线与设备标签
  ui.btnOnlineRefresh.onclick = () => {
    refreshOnline(true);
  };

  // 初始合并刷新
  (function preloadOnline(){
    let tries=0, MAX=20;
    const loop=()=>{
      const id=getDevIdNum();
      if(id==null){
        if(++tries<MAX) return setTimeout(loop,200);
        return;
      }
      try{ authLoadToken(); }catch{}
      refreshOnline(true); // 一次
    };
    loop();
  })();

  /* ---- 拍照 ---- */
  function setBusy(btn,flag){ if(flag) btn.setAttribute('aria-busy','true'); else btn.removeAttribute('aria-busy'); }
  ui.btnShot.onclick=async ()=>{
    if(!currentDevOnline) return;
    const id=guardDevId(); if(id==null) return;
    if(ui.btnShot.getAttribute('aria-busy')) return;
    setBusy(ui.btnShot,true);
    try{
      await androidWsApi.photo({ toId:id, model, cameraIndex:0, timestamp:nowSec() });
      toast('success', extraToastPrefix+'拍照成功');
    }catch{
      toast('error', extraToastPrefix+'拍照失败');
    }finally{ setBusy(ui.btnShot,false); }
  };

  /* ---- 录像 ---- */
  function refreshRecordBtn(){ ui.btnRecord.textContent = recording ? '停止录像':'开始录像'; }
  refreshRecordBtn();
  ui.btnRecord.onclick=async ()=>{
    if(!currentDevOnline) return;
    const id=guardDevId(); if(id==null) return;
    if(ui.btnRecord.getAttribute('aria-busy')) return;
    setBusy(ui.btnRecord,true);
    const op = recording?1:0;
    try{
      await androidWsApi.recordVideo({ toId:id, model, operation:op, cameraIndex:0, timestamp:nowSec() });
      recording=!recording;
      refreshRecordBtn();
      toast('success', extraToastPrefix+(recording?'开始录像成功':'停止录像成功'));
    }catch{
      toast('error', extraToastPrefix+(recording?'停止录像失败':'开始录像失败'));
    }finally{ setBusy(ui.btnRecord,false); }
  };

  /* ---- 下行音频（与原逻辑相同，仅引用） ---- */
  function setVolumeIcon(state){
    volumeState=state;
    ui.btnVolume.setAttribute('aria-state', state);
    ui.icVolume.src = state==='on' ? '/res/volume_on.png'
                     : state==='request' ? '/res/volume_request.png'
                     : '/res/volume_off.png';
  }
  setVolumeIcon('off');
  function isValidStreamURI(u){
    if(!u || typeof u!=='string') return false;
    if(!u.startsWith('webrtc://')) return false;
    if(/\s/.test(u)) return false;
    const PAT = /^webrtc:\/\/[A-Za-z0-9.\-:_]+\/[A-Za-z0-9_\-]+/;
    if(!PAT.test(u)) return false;
    return u.length >= 24;
  }
  async function ensureSrsPlayerLib(){
    if(window.SrsRtcPlayerAsync) return;
    await new Promise((res,rej)=>{
      const s=document.createElement('script');
      s.src='/js/adapter-7.4.0.min.js'; s.onload=res; s.onerror=()=>rej();
      document.head.appendChild(s);
    }).catch(()=>{});
    if(window.SrsRtcPlayerAsync) return;
    await new Promise((res,rej)=>{
      const s=document.createElement('script');
      s.src='/js/srs.sdk.js'; s.onload=res; s.onerror=()=>rej();
      document.head.appendChild(s);
    }).catch(()=>{});
  }
  let audioPlayer=null;
  async function stopAudioPlay(){
    try{
      if(audioPlayer && audioPlayer.close) audioPlayer.close();
      if(audioPlayer?.stream?.getTracks) audioPlayer.stream.getTracks().forEach(t=>{ try{ t.stop(); }catch{} });
    }catch{}
    audioPlayer=null;
    if(volumeStreamURI){
      try{
        const id=guardDevId();
        if(id!=null){
          androidWsApi.pushStream({ toId:id, startFlag:false, hardwareType:2, hardwareIndex:0 }).catch(()=>{});
        }
      }catch{}
      volumeStreamURI=null;
    }
  }
  async function startAudioPlay(uri){
    await ensureSrsPlayerLib();
    if(!window.SrsRtcPlayerAsync){
      toast('error','音频组件缺失');
      return false;
    }
    try{
      audioPlayer=new SrsRtcPlayerAsync();
      const a=document.createElement('audio');
      a.autoplay=true; a.muted=false; a.controls=false; a.style.display='none';
      document.body.appendChild(a);
      a.srcObject=audioPlayer.stream;
      await audioPlayer.play(uri);
      const hasAudio = (audioPlayer.stream?.getAudioTracks?.()||[]).length>0;
      if(!hasAudio) toast('warn','该流无音频轨');
      return true;
    }catch{
      toast('error','音频播放失败');
      try{ stopAudioPlay(); }catch{}
      return false;
    }
  }
  const AUDIO_START_TIMEOUT_MS = 5000;
  ui.btnVolume.onclick=async ()=>{
    if(!currentDevOnline) return;
    if(volumeState==='request') return;
    const id=guardDevId(); if(id==null) return;

    if(volumeState==='off'){
      setVolumeIcon('request');
      let timeoutId=null;
      try{
        const startPromise = androidWsApi.pushStream({ toId:id, startFlag:true, hardwareType:2, hardwareIndex:0 });
        const resp = await Promise.race([
          startPromise,
          new Promise((_,rej)=>timeoutId=setTimeout(()=>rej(new Error('__AUDIO_PUSH_TIMEOUT__')), AUDIO_START_TIMEOUT_MS))
        ]);
        clearTimeout(timeoutId);
        if(resp?.code===0){
          const uri = resp?.data?.streamURI;
          if(!isValidStreamURI(uri)){
            toast('error','开启音频失败(地址无效)');
            setVolumeIcon('off');
            return;
          }
            const ok = await startAudioPlay(uri);
            if(ok){
              volumeStreamURI = uri;
              setVolumeIcon('on');
              if(typeof onVolumeToggle==='function') try{ onVolumeToggle(true); }catch{}
            }else{
              setVolumeIcon('off');
            }
        }else{
          toast('error',`开启音频失败(code:${resp?.code ?? '未知'})`);
          setVolumeIcon('off');
        }
      }catch(err){
        if(timeoutId) clearTimeout(timeoutId);
        if(err && err.message==='__AUDIO_PUSH_TIMEOUT__'){
          toast('error','开启音频超时');
        }else{
          toast('error','开启音频失败');
        }
        setVolumeIcon('off');
      }
    }else if(volumeState==='on'){
      setVolumeIcon('request');
      try{
        await stopAudioPlay();
        setVolumeIcon('off');
        if(typeof onVolumeToggle==='function') try{ onVolumeToggle(false); }catch{}
      }catch{
        setVolumeIcon('on');
      }
    }
  };

  async function ensureSrsPublisherLib(){
    if(window.SrsRtcPublisherAsync) return ensureSrsPlayerLib();
    await ensureSrsPlayerLib();
  }

  // 监听设备信息修改事件
  try {
    eventBus.on && eventBus.on('device:updated', payload=>{
      const idNum = getDevIdNum();
      if(!payload || idNum==null) return;
      if(Number(payload.devId) === Number(idNum)){
        refreshDeviceMeta(true);
      }
    });
  } catch(e){ console.warn('[detail] listen device:updated failed', e); }

  return {
    updateWsChannel(){},
    getState(){ return { model, recording, volumeState, talkState, online: currentDevOnline }; },
    refreshOnline,
    refreshDeviceMeta: ()=>refreshDeviceMeta(true),
    stopAll(){
      (async()=>{
        try{ await stopAudioPlay(); }catch{}
        try{ await stopTalk(0); }catch{}
      })();
    }
  };
}

/* ------------- bridge (保持原样) ------------- */
export function detailBridge() {
  const listeners = new Set();
  const chSet = new Set();
  const pendingOpen = new Map();
  const chByKey = new Map();
  const pendingByKey = new Map();
  let initData = null;
  const initWaiters = [];
  function keyOf({ kind, devId, modeId, extra }) {
    const ex = extra ? JSON.stringify(extra) : '';
    return `${kind||''}|${devId||''}|${modeId||''}|${ex}`;
  }
  function post(msg){ parent.postMessage(Object.assign({ __detail:true }, msg), '*'); }
  function onMsg(e){
    const m = e.data || {};
    if(!m || !m.__detail) return;
    switch(m.t){
      case 'init':
        initData = m;
        while(initWaiters.length){
          try{ initWaiters.shift()(initData); }catch{}
        }
        break;
      case 'ws:open:ok': {
        const p = pendingOpen.get(m.reqId);
        if(p){
          pendingOpen.delete(m.reqId);
          chSet.add(m.ch);
          if(p.key) chByKey.set(p.key, m.ch);
          p.resolve(m.ch);
        }
        break;
      }
      case 'ws:message':
        if(chSet.has(m.ch)){
          for(const fn of listeners){ try{ fn(m.data); }catch{} }
        }
        break;
      case 'ws:closed':
        chSet.delete(m.ch);
        for(const [k,v] of chByKey.entries()){
          if(v===m.ch) chByKey.delete(k);
        }
        break;
      case 'navigate':
        location.href = m.url;
        break;
    }
  }
  window.addEventListener('message', onMsg);
  return {
    ready({ page, devId, devNo, modeId }){ post({ t:'ready', page, devId, devNo, modeId }); },
    async wsOpen(params){
      const key = keyOf(params||{});
      const existing = chByKey.get(key);
      if(existing && chSet.has(existing)) return existing;
      if(pendingByKey.has(key)) return pendingByKey.get(key);
      const reqId = Date.now()+Math.floor(Math.random()*1000);
      const p = new Promise(resolve=> pendingOpen.set(reqId,{ resolve, key }));
      pendingByKey.set(key,p);
      post(Object.assign({ t:'ws:open', reqId }, params));
      try{ return await p; } finally { pendingByKey.delete(key); }
    },
    wsSend(ch,data){ post({ t:'ws:send', ch, data }); },
    wsClose(ch){ post({ t:'ws:close', ch }); },
    onWsMessage(fn){ listeners.add(fn); return ()=>listeners.delete(fn); },
    getInit(){ return initData; },
    waitInit(){ return initData ? Promise.resolve(initData) : new Promise(r=>initWaiters.push(r)); }
  };
}

/* ------------- useDetailContext (保持原样) ------------- */
export async function useDetailContext(bridge, opts = {}) {
  const { page, modeId: presetModeId, wantStream = false } = opts;
  const qs = new URLSearchParams(location.search);
  let ctx = {
    devId: (qs.get('devId') ?? '').trim() || null,
    devNo: (qs.get('devNo') ?? '').trim() || null,
    modeId: presetModeId != null ? String(presetModeId)
          : ((qs.get('modeId') ?? '').trim() || null),
    stream: wantStream ? ((qs.get('stream') ?? '').trim() || null) : null,
    streamId: wantStream ? ((qs.get('streamId') ?? '').trim() || null) : null
  };
  try {
    bridge.ready({ page, devId: ctx.devId || '', devNo: ctx.devNo || '', modeId: ctx.modeId || '' });
  } catch {}
  let devReadyResolve;
  const devReadyPromise = new Promise(r=>devReadyResolve=r);
  if(ctx.devId){
    devReadyResolve();
  }else{
    (async ()=>{
      try{
        const init = await bridge.waitInit();
        if(init){
          if(!ctx.devId && init.devId!=null && init.devId!=='') ctx.devId=String(init.devId);
          if(!ctx.devNo && init.devNo!=null && init.devNo!=='') ctx.devNo=String(init.devNo);
          if(!ctx.modeId && init.modeId!=null && init.modeId!=='') ctx.modeId=String(init.modeId);
          if(wantStream){
            if(!ctx.stream && init.stream) ctx.stream=String(init.stream);
            if(!ctx.streamId && init.streamId!=null) ctx.streamId=String(init.streamId);
          }
        }
      } finally {
        devReadyResolve();
      }
    })();
  }
  async function ensureDevId(timeoutMs=6000){
    if(ctx.devId) return ctx.devId;
    let to; const gate = new Promise((_,rej)=>{ to=setTimeout(()=>rej(new Error('DEV_ID_TIMEOUT')), timeoutMs); });
    try{ await Promise.race([devReadyPromise, gate]); } finally { clearTimeout(to); }
    if(!ctx.devId) throw new Error('DEV_ID_NOT_READY');
    return ctx.devId;
  }
  try {
    if(typeof window!=='undefined'){
      window.__detailCtx = {
        get devId(){ return ctx.devId; },
        get devNo(){ return ctx.devNo; },
        ensureDevId
      };
    }
  }catch{}
  return {
    get devId(){ return ctx.devId; },
    get devNo(){ return ctx.devNo; },
    get modeId(){ return ctx.modeId; },
    get stream(){ return ctx.stream; },
    get streamId(){ return ctx.streamId; },
    ensureDevId
  };
}
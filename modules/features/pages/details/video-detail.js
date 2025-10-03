/**
 * 视频详情页（devId 统一按整型发送；内部存取仍可字符串/空）
 * 关键点：
 *  - getDevId() 返回字符串（或空）
 *  - getDevIdNum() 返回发送用的 Number，若无效则返回 null
 *  - 所有 wsOpen / androidWsApi 调用使用 getDevIdNum()
 *  - 如果超过 JS 安全整数可能有精度问题，请确认服务端 ID 范围
 */
/**
 * 视频详情页（统一顶部栏：拍照 / 录像 / 对讲 / 音量）
 */
import { mountTopbar, detailBridge, useDetailContext, setupTopbarControls } from './common/detail-common.js';
import { STREAMS } from '/config/streams.js';
import { androidWsApi } from '@api/androidWSApi.js';
import { eventBus } from '@core/eventBus.js';
import { authLoadToken } from '@core/auth.js';

try { authLoadToken(); } catch {}

const VD_DEBUG = true;
const log  = (...a)=>VD_DEBUG && console.debug('[VD]', ...a);
const warn = (...a)=>VD_DEBUG && console.warn('[VD]', ...a);
const err  = (...a)=>VD_DEBUG && console.error('[VD]', ...a);

/* ---------------- 上下文 & devId 处理 ---------------- */
const bridge = detailBridge();
const ctx = await useDetailContext(bridge, { page:'video', wantStream:true });

let devId = ctx.devId ?? null; // 原始（可能为空/字符串）
function getDevId(){
  return (ctx.devId != null && ctx.devId !== '') ? String(ctx.devId)
       : (devId != null && devId !== '' ? String(devId) : '');
}
function getDevIdNum(){
  const s = getDevId();
  if(!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const devNo = ctx.devNo || '';
let streamId = ctx.streamId != null ? Number(ctx.streamId) : null;
let streamName = ctx.stream || '';
if(streamId == null){
  streamId = (streamName === 'sub') ? 1 : 0;
} else {
  streamName = streamId === 1 ? 'sub':'main';
}

const uiTop = mountTopbar(document.body);
// uiTop.lblDevNo.textContent = buildTopbarDevLabel(getDevId(), '', devNo || '');

// 统一顶部栏控制（音量按钮联动实际视频音量）
let bigPlayer; // 提前声明，实例稍后创建
const topbarHelper = setupTopbarControls({
  ui: uiTop,
  page:'video',
  getDevIdNum: ()=>getDevIdNum(),
  bridge,
  onVolumeToggle: (muted)=>{
    try{
      if(!bigPlayer) return;
      const v = bigPlayer.getVideoEl();
      v.muted = muted;
      if(muted) v.volume = 0;
      else if(v.volume===0) v.volume = 1;
      refreshVolumeUI();
    }catch{}
  }
});

bridge.ready({ page:'video', devId: getDevId(), devNo });

// /* 异步刷新 label（父页 init 后） */
// (function syncLabel(){
//   if(getDevId()) return;
//   const t = setInterval(()=>{
//     if(getDevId()){
//       uiTop.lblDevNo.textContent = devNo || getDevId() || '设备';
//       log('label refreshed with devId=', getDevId());
//       clearInterval(t);
//     }
//   },150);
// })();

/* Toast */
function toast(type,msg){ eventBus.emit('toast:show',{ type, message:msg }); }

/* 时间戳秒 */
const ts = ()=> Math.floor(Date.now()/1000);

/* 等待 devId */
async function waitDevId(maxWaitMs=3000){
  const start = Date.now();
  while(!getDevId()){
    if(Date.now()-start > maxWaitMs) break;
    await new Promise(r=>setTimeout(r,100));
  }
  if(getDevId()) log('waitDevId resolved devId=', getDevId());
  else warn('waitDevId timeout, still empty');
}

/* ---------------- 播放器核心（保持不变，略） ---------------- */
function makeRenderLoop(draw){
  let run=false;
  function loop(){ if(!run) return; draw(); requestAnimationFrame(loop); }
  return { start(){ if(!run){run=true; requestAnimationFrame(loop);} }, stop(){ run=false; } };
}
function createRtcCanvasPlayer(isPip,onResolution){
  const video=document.createElement('video');
  video.autoplay=true; video.muted=true; video.playsInline=true;
  video.style.position='absolute'; video.style.top='0'; video.style.left='0';
  video.style.width='1px'; video.style.height='1px'; video.style.opacity='0';
  document.body.appendChild(video);
  const canvas=document.createElement('canvas'); const ctx2=canvas.getContext('2d');
  canvas.width=1280; canvas.height=720;
  let sdk=null, rotation=0, mode='fit', stats={width:0,height:0,fps:0,vbit:0,abit:0,_hasV:false,_hasA:false};
  const loop=makeRenderLoop(()=>{
    const dispW=canvas.clientWidth||canvas.width;
    const dispH=canvas.clientHeight||canvas.height;
    const vw=video.videoWidth, vh=video.videoHeight;
    if(!vw||!vh) return;
    ctx2.clearRect(0,0,canvas.width,canvas.height);
    ctx2.save();
    ctx2.translate(canvas.width/2,canvas.height/2);
    ctx2.rotate(rotation*Math.PI/180);
    let vW=vw,vH=vh;
    if(rotation%180!==0) [vW,vH]=[vH,vW];
    let drawW=dispW, drawH=dispH;
    if(mode==='fit' && !isPip){
      const vr=vW/vH, cr=dispW/dispH;
      if(vr>cr){ drawW=dispW; drawH=dispW/vr; } else { drawH=dispH; drawW=dispH*vr; }
    }
    const scaleX=canvas.width/dispW, scaleY=canvas.height/dispH;
    if(rotation%180===0) ctx2.drawImage(video,-drawW/2*scaleX,-drawH/2*scaleY,drawW*scaleX,drawH*scaleY);
    else ctx2.drawImage(video,-drawH/2*scaleX,-drawW/2*scaleY,drawH*scaleX,drawW*scaleY);
    ctx2.restore();
  });
  function collectStats(pc){
    let last={}, firstLogged=false;
    setInterval(()=>pc&&pc.getStats().then(rs=>{
      rs.forEach(r=>{
        if(r.type==='inbound-rtp'&&r.kind==='video'){
          stats._hasV=true;
          const bytes=r.bytesReceived, frames=r.framesDecoded;
          const dBytes=last.v?bytes-last.v:0;
            const dFrames=last.f?frames-last.f:0;
          stats.vbit=(dBytes*8/1000).toFixed(1); stats.fps=dFrames;
          stats.width=r.frameWidth||stats.width; stats.height=r.frameHeight||stats.height;
          if(!firstLogged && (stats.width||stats.height)){firstLogged=true;}
          last.v=bytes; last.f=frames;
        }
        if(r.type==='inbound-rtp'&&r.kind==='audio'){
          stats._hasA=true;
          const bytes=r.bytesReceived; const d=last.a?bytes-last.a:0;
          stats.abit=(d*8/1000).toFixed(1); last.a=bytes;
        }
      });
      if(onResolution && stats.width && stats.height) onResolution(stats.width,stats.height,rotation);
    }).catch(()=>{}),1000);
  }
  async function play(url){
    if(!url) return;
    if(sdk){ try{sdk.close();}catch{} sdk=null; }
    try{
      sdk=new SrsRtcPlayerAsync();
      video.srcObject=sdk.stream;
      await sdk.play(url);
      loop.start();
      collectStats(sdk.pc);
    }catch(e){ toast('error','视频播放失败'); try{sdk&&sdk.close();}catch{} }
  }
  return {
    canvas, play,
    rotate:()=>{rotation=(rotation+90)%360;},
    toggleMode:()=>{mode=(mode==='fit'?'fill':'fit');},
    getMode:()=>mode,
    getRotation:()=>rotation,
    getStats:()=>({...stats}),
    mute:(m)=>{video.muted=m;},
    setVolume:(v)=>{video.volume=v;},
    getVideoEl:()=>video,
    attachToSlot:(slot)=>{slot.appendChild(canvas);},
    isPip:()=>isPip,
    setPip:(v)=>{isPip=v;}
  };
}

/* DOM 引用 */
const container=document.getElementById('video_container');
const slotMain=document.getElementById('slot_main');
const slotPip=document.getElementById('slot_pip');
const pipPlaceholder=document.getElementById('pip_placeholder');
const btnMute=document.getElementById('btn_mute');
const iconVol=document.getElementById('icon_volume');
const iconVolOff=document.getElementById('icon_volume_off');
const volumeSlider=document.getElementById('volume_slider');
const btnSwitch=document.getElementById('btn_switch');
const btnInfo=document.getElementById('btn_info');
const btnRotate=document.getElementById('btn_rotate');
const btnFitFill=document.getElementById('btn_fit_fill');
const iconFit=document.getElementById('icon_fit');
const iconFill=document.getElementById('icon_fill');
const btnFullscreen=document.getElementById('btn_fullscreen');
const iconFS=document.getElementById('icon_fullscreen');
const iconFSExit=document.getElementById('icon_fullscreen_exit');
const infoPanel=document.getElementById('info_panel');

/* 播放器实例 */
const playerA=createRtcCanvasPlayer(false);
const playerB=createRtcCanvasPlayer(true,onSmallResolution);
bigPlayer=playerA; let smallPlayer=playerB;
playerA.attachToSlot(slotMain);

let subVisible=false, pipUserMoved=false;

/* （优化）禁止初始静态多次协商：只通过后续动态 upgrade 获取流 */
const DO_STATIC_INIT_PLAY = false;
const urlMap={ main:STREAMS.main, sub:STREAMS.sub, screen:STREAMS.screen };
const mainUrl = streamId === 1 ? urlMap.sub : urlMap.main;
if(DO_STATIC_INIT_PLAY && mainUrl) playerA.play(mainUrl);
if(DO_STATIC_INIT_PLAY && STREAMS.sub){
  playerB.play(STREAMS.sub);
  playerB.attachToSlot(slotPip);
  slotPip.style.display='block';
  pipPlaceholder.style.display='none';
  subVisible=true;
  btnSwitch.style.display='inline-flex';
}

/* 若未静态播放，仍需展示 PiP 容器结构（占位） */
// if(!DO_STATIC_INIT_PLAY && STREAMS.sub){
//   playerB.attachToSlot(slotPip);
//   slotPip.style.display='block';
//   pipPlaceholder.style.display='none';
//   subVisible=true;
//   btnSwitch.style.display='inline-flex';
// }

/* 控制条显隐逻辑 */
function showControls(auto=true){
  container.classList.add('show-controls');
  if(showControls._t) clearTimeout(showControls._t);
  if(auto) showControls._t=setTimeout(()=>container.classList.remove('show-controls'),2500);
}
container.addEventListener('mousemove',()=>showControls(true));
container.addEventListener('mouseleave',()=>container.classList.remove('show-controls'));
showControls(true);

/* 音量 & 模式 UI */
function refreshVolumeUI(){
  const v=bigPlayer.getVideoEl();
  if(v.muted||v.volume===0){iconVol.style.display='none';iconVolOff.style.display='';}
  else {iconVol.style.display='';iconVolOff.style.display='none';}
  volumeSlider.value=v.volume;
}
btnMute.onclick=()=>{const v=bigPlayer.getVideoEl();v.muted=!v.muted;refreshVolumeUI();};
volumeSlider.oninput=()=>{
  const val=parseFloat(volumeSlider.value);
  bigPlayer.setVolume(val);
  if(val>0) bigPlayer.mute(false);
  refreshVolumeUI();
};
function refreshModeIcon(){
  if(bigPlayer.getMode()==='fit'){iconFit.style.display='';iconFill.style.display='none';}
  else {iconFit.style.display='none';iconFill.style.display='';}
}
btnFitFill.onclick=()=>{bigPlayer.toggleMode();refreshModeIcon();};
btnRotate.onclick=()=>bigPlayer.rotate();
btnFullscreen.onclick=()=>{
  if(!document.fullscreenElement) container.requestFullscreen&&container.requestFullscreen();
  else document.exitFullscreen&&document.exitFullscreen();
};
document.addEventListener('fullscreenchange',()=>{
  const fs=!!document.fullscreenElement;
  iconFS.style.display=fs?'none':'';
  iconFSExit.style.display=fs?'':'none';
  ensurePipInBounds(true);
});

btnInfo.onclick=()=>{
  if(infoPanel.style.display==='none'||!infoPanel.style.display){infoPanel.style.display='block';updateInfoPanel();}
  else infoPanel.style.display='none';
};
function statsLines(st,p){
  return `<div class="info-row"><span>分辨率</span><span>${st.width}x${st.height}</span></div>
  <div class="info-row"><span>帧率</span><span>${st.fps||'-'} fps</span></div>
  <div class="info-row"><span>视频码率</span><span>${st.vbit||'-'} kbps</span></div>
  <div class="info-row"><span>音频码率</span><span>${st.abit||'-'} kbps</span></div>
  <div class="info-row"><span>模式</span><span>${p.getMode()}</span></div>
  <div class="info-row"><span>旋转</span><span>${p.getRotation()}°</span></div>`;
}
function updateInfoPanel(){
  if(infoPanel.style.display==='none') return;
  const sb=bigPlayer.getStats();
  let html=`<h4>大画面 <span class="badge-role">${bigPlayer===playerA?(streamId===1?'副流':'主流'):(smallPlayer===playerA?(streamId===1?'副流':'主流'):'主流')}</span></h4>`;
  html+=statsLines(sb,bigPlayer);
  if(subVisible){
    const ss=smallPlayer.getStats();
    html+=`<h4 style="margin-top:6px;">小画面 <span class="badge-role secondary">${smallPlayer===playerA?(streamId===1?'副流':'主流'):(smallPlayer===playerB?'副流':'主流')}</span></h4>`;
    html+=statsLines(ss,smallPlayer);
  }
  infoPanel.innerHTML=html;
}
setInterval(updateInfoPanel,1000);

/* 交换主/副 */
btnSwitch.onclick=()=>{
  if(!subVisible) return;
  bigPlayer.setPip(true);
  smallPlayer.setPip(false);
  slotMain.appendChild(smallPlayer.canvas);
  slotPip.appendChild(bigPlayer.canvas);
  const prev=bigPlayer; bigPlayer=smallPlayer; smallPlayer=prev;
  refreshVolumeUI(); refreshModeIcon(); updateInfoPanel();
};

function onSmallResolution(w,h,rot){
  if(!subVisible) return;
  if(pipUserMoved) return;
  adjustPipSize(w,h,rot);
  ensurePipInBounds(true);
}
function adjustPipSize(w,h,rot){
  if(!w||!h) return;
  if(rot%180!==0)[w,h]=[h,w];
  const maxW=300,maxH=200;
  let aspect=w/h; let tw=maxW,th=tw/aspect;
  if(th>maxH){th=maxH;tw=th*aspect;}
  slotPip.style.width=Math.round(tw)+'px';
  slotPip.style.height=Math.round(th)+'px';
}
 function ensurePipInBounds(){}
/* ------------ 画中画拖动支持（恢复拖动能力） ------------ */
(function enablePipDrag(){
  const pip = slotPip;
  if(!pip) return;
  if(pip.dataset.dragEnabled==='1') return;
  pip.dataset.dragEnabled='1';
  let dragging=false, startX=0,startY=0,origLeft=0,origTop=0;

  function ensureBounds(){
    const parent = pip.parentElement || container;
    const pw = parent.clientWidth;
    const ph = parent.clientHeight;
    const rect = pip.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    let left = rect.left - parentRect.left;
    let top  = rect.top  - parentRect.top;
    left = Math.max(0,Math.min(left,pw-rect.width));
    top  = Math.max(0,Math.min(top ,ph-rect.height));
    pip.style.left = left + 'px';
    pip.style.top  = top  + 'px';
  }

  function toAbsIfNeeded(){
    const st = getComputedStyle(pip);
    if(st.right!=='auto' || st.bottom!=='auto'){
      const rect = pip.getBoundingClientRect();
      const parentRect = pip.parentElement.getBoundingClientRect();
      pip.style.left = (rect.left - parentRect.left) + 'px';
      pip.style.top  = (rect.top  - parentRect.top) + 'px';
      pip.style.right='auto';
      pip.style.bottom='auto';
    }
    if(st.position==='static'){
      pip.style.position='absolute';
    }
  }

  function onDown(e){
    const pt = (e.touches && e.touches[0]) ? e.touches[0] : e;
    dragging=true;
    toAbsIfNeeded();
    const rect = pip.getBoundingClientRect();
    const parentRect = (pip.parentElement||container).getBoundingClientRect();
    origLeft = rect.left - parentRect.left;
    origTop  = rect.top  - parentRect.top;
    startX=pt.clientX;
    startY=pt.clientY;
    pip.classList.add('dragging');
    document.addEventListener('mousemove',onMove,{passive:false});
    document.addEventListener('mouseup',onUp,{passive:false});
    document.addEventListener('touchmove',onMove,{passive:false});
    document.addEventListener('touchend',onUp,{passive:false});
    e.preventDefault();
  }
  function onMove(e){
    if(!dragging) return;
    const pt = (e.touches && e.touches[0]) ? e.touches[0] : e;
    const dx = pt.clientX - startX;
    const dy = pt.clientY - startY;
    let nl = origLeft + dx;
    let nt = origTop  + dy;
    const parent = pip.parentElement || container;
    const pw = parent.clientWidth;
    const ph = parent.clientHeight;
    const rect = pip.getBoundingClientRect();
    nl = Math.max(0, Math.min(nl, pw - rect.width));
    nt = Math.max(0, Math.min(nt, ph - rect.height));
    pip.style.left = nl + 'px';
    pip.style.top  = nt + 'px';
    e.preventDefault();
  }
  function onUp(){
    dragging=false;
    pip.classList.remove('dragging');
    document.removeEventListener('mousemove',onMove);
    document.removeEventListener('mouseup',onUp);
    document.removeEventListener('touchmove',onMove);
    document.removeEventListener('touchend',onUp);
    ensureBounds();
    pipUserMoved=true;
  }

  pip.addEventListener('mousedown',onDown,{passive:false});
  pip.addEventListener('touchstart',onDown,{passive:false});
  window.addEventListener('resize',()=>ensureBounds());
})();

/* 初始 UI 刷新 */
refreshModeIcon(); refreshVolumeUI();

/* ---------------- WS 渠道建立（确保数值 id） ---------------- */
log('wsOpen before, initial devId=', getDevId(), 'ctx.devId=', ctx.devId);
await waitDevId();
devId = getDevId() || devId;
const devIdNum = getDevIdNum();
if(devIdNum == null){
  warn('devId still invalid, wsOpen will proceed with empty (server may reject)');
}
const wsCh = await bridge.wsOpen({ kind:'video', devId: devIdNum });
log('wsOpen after channel=', wsCh, 'final devId(str)=', getDevId(), 'final devId(num)=', devIdNum);

topbarHelper.updateWsChannel(wsCh);

/* ---------------- 控制逻辑（保持原逻辑） ---------------- */
const blkZoom=document.getElementById('blkZoom');
const blkRotate=document.getElementById('blkRotate');
const blkLight=document.getElementById('blkLight');
const blkThermal=document.getElementById('blkThermal');
const blkSwitch=document.getElementById('blkSwitch');

const zoomMultipleEl=document.getElementById('zoomMultiple');
const btnZoomPlus=document.getElementById('btnZoomPlus');
const btnZoomMinus=document.getElementById('btnZoomMinus');
const zoomCamSubWrap=document.getElementById('zoomCamSubWrap');

let currentMultiple=1;
function formatMult(){ zoomMultipleEl.textContent='X'+currentMultiple; }
formatMult();
function nextMultiple(v){ return v===1?2:v===2?4:v===4?8:1; }
function prevMultiple(v){ return v===1?8:v===8?4:v===4?2:1; }
function selectedCameraIndex(){
  const r=document.querySelector('input[name="zoomCamera"]:checked');
  return r?Number(r.value)||0:0;
}

/* 缩放 */
btnZoomPlus.onclick=()=> doZoom(0,true);
btnZoomMinus.onclick=()=> doZoom(1,false);
async function doZoom(operation,isPlus){
  const idNum=getDevIdNum();
  if(idNum==null){ warn('doZoom skip: devId invalid'); return; }
  const camIdx=selectedCameraIndex();
  currentMultiple = isPlus ? nextMultiple(currentMultiple) : prevMultiple(currentMultiple);
  formatMult();
  try{
    const resp = await androidWsApi.cameraZoom({
      toId:idNum,
      model:4,
      cameraIndex:camIdx,
      operation,
      multiple:currentMultiple,
      timestamp:ts()
    });
    log('cameraZoom resp', resp);
  }catch(e){
    err('cameraZoom error', e);
    toast('error','缩放失败');
  }
}

/* 旋转 */
const dirButtons=[
  {el:document.getElementById('btnRotUp'),dir:1,base:'up'},
  {el:document.getElementById('btnRotDown'),dir:2,base:'down'},
  {el:document.getElementById('btnRotLeft'),dir:3,base:'left'},
  {el:document.getElementById('btnRotRight'),dir:4,base:'right'}
];
dirButtons.forEach(b=>{
  setDirBg(b.el,b.base,true);
  setupPress(b.el,(type)=>{
    const camIdx=selectedCameraIndex();
    if(type==='short'){
      sendProbeRotation({ direction:b.dir, operation:0, longPressStatus:0, cameraIndex:camIdx });
    }else if(type==='longStart'){
      sendProbeRotation({ direction:b.dir, operation:1, longPressStatus:0, cameraIndex:camIdx });
      setDirBg(b.el,b.base,false);
    }else if(type==='longEnd'){
      sendProbeRotation({ direction:b.dir, operation:1, longPressStatus:1, cameraIndex:camIdx });
      setDirBg(b.el,b.base,true);
    }
  });
});
function setDirBg(el,base,normal){
  if(!el)return;
  el.style.backgroundImage=`url(/res/${base}_${normal?'normal':'focus'}.png)`;
}
function setupPress(el,cb){
  const TH=350;
  let timer=null,long=false;
  el.addEventListener('mousedown',()=>{
    long=false;
    timer=setTimeout(()=>{ long=true; cb('longStart'); },TH);
  });
  ['mouseup','mouseleave'].forEach(evt=>{
    el.addEventListener(evt,()=>{
      if(timer){ clearTimeout(timer); timer=null; }
      if(long) cb('longEnd');
    });
  });
  el.addEventListener('click',()=>{ if(!long) cb('short'); });
}
async function sendProbeRotation({direction,operation,longPressStatus,cameraIndex}){
  const idNum=getDevIdNum();
  if(idNum==null){ warn('probeRotation skip: devId invalid'); return; }
  try{
    const resp=await androidWsApi.probeRotation({
      toId:idNum,
      model:4,
      direction,operation,longPressStatus,cameraIndex,
      timestamp:ts()
    });
    log('probeRotation resp', resp);
  }catch(e){
    err('probeRotation error', e);
    toast('error','旋转控制失败');
  }
}

/* 灯光控制 */
document.querySelectorAll('input[name="lightCtrl"]').forEach(r=>{
  r.addEventListener('change',()=>{
    if(!r.checked) return;
    const idNum=getDevIdNum(); if(idNum==null){ warn('light skip: devId invalid'); return; }
    const val=Number(r.value);
    const camIdx=selectedCameraIndex();
    androidWsApi.cameraLight({ toId:idNum, operation:val, cameraIndex:camIdx })
      .catch(()=>toast('error','灯光控制失败'));
  });
});

/* 伪彩 & 参数 */
const pseudoSel=document.getElementById('pseudoSel');
const btnPseudoNext=document.getElementById('btnPseudoNext');
const btnTiParams=document.getElementById('btnTiParams');
const PSEUDO_NAMES=['白热','黑热','聚变','彩虹','搜救','熔岩','铁红','脂珀','北极','暮焰','检测','彩熔','榴焰','医疗','韶光','朱明','金芒','清冷'];
function buildPseudoOptions(sel){
  pseudoSel.innerHTML=PSEUDO_NAMES.map((n,i)=>`<option value="${i}" ${i===sel?'selected':''}>${i}${n}</option>`).join('');
}
pseudoSel.addEventListener('change',()=>{
  const idNum=getDevIdNum(); if(idNum==null){ warn('pseudo change skip: devId invalid'); return; }
  const idx=Number(pseudoSel.value)||0;
  androidWsApi.setPseudoCM({ toId:idNum, next:1, number:idx })
    .catch(()=>toast('error','伪彩切换失败'));
});
btnPseudoNext.onclick=()=>{
  const idNum=getDevIdNum(); if(idNum==null){ warn('pseudo next skip: devId invalid'); return; }
  androidWsApi.setPseudoCM({ toId:idNum, next:0, number:0 })
    .catch(()=>toast('error','伪彩切换失败'));
};

btnTiParams.onclick=async ()=>{
  const idNum=getDevIdNum(); if(idNum==null){ toast('error','设备未就绪'); return; }
  let data=null;
  try{
    const res=await androidWsApi.getTIProbe({ toId:idNum });
    if(res.code!==0) throw new Error(res.msg||'获取失败');
    data=res.data||{};
  }catch(e){
    toast('error','获取热成像参数失败');
    return;
  }
  openTiParamModal(data);
};

function openTiParamModal(d){
  const mask=document.createElement('div'); mask.className='ti-mask';
  const modal=document.createElement('div'); modal.className='ti-modal';
  modal.innerHTML=`<style>
      .ti-mask{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:999;display:flex;align-items:center;justify-content:center;}
      .ti-modal{background:#11202c;border:1px solid #2b4558;border-radius:8px;min-width:420px;max-width:520px;padding:16px 18px;font-size:13px;color:#dde9f5;}
      .ti-modal h3{margin:0 0 12px;font-size:15px;font-weight:600;color:#bfe2ff;}
      .ti-form{display:grid;grid-template-columns:140px 1fr;row-gap:10px;column-gap:8px;align-items:center;}
      .ti-radio-group{display:flex;align-items:center;gap:14px;}
      .ti-actions{margin-top:16px;display:flex;justify-content:flex-end;gap:12px;}
      .btn{background:#1f7fb8;border:1px solid rgba(255,255,255,.25);color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:600;white-space:nowrap;font-size:13px;}
      .note{font-size:11px;color:#8aa5b6;}
      .warn{color:#ffb46c;font-size:12px;margin-top:4px;}
    </style>
    <h3>热成像参数配置</h3>
    <div class="ti-form">
      <label>测温开关</label>
      <div class="ti-radio-group">
        <label><input type="radio" name="ti_tempSwitch" value="0" ${Number(d.temperature_switch)===0?'checked':''}> 开</label>
        <label><input type="radio" name="ti_tempSwitch" value="1" ${Number(d.temperature_switch)===1?'checked':''}> 关</label>
      </div>
      <label>测温模式</label>
      <div class="ti-radio-group">
        <label><input type="radio" name="ti_tempMode" value="0" ${Number(d.temperature_measurement_model)===0?'checked':''}> 高温</label>
        <label><input type="radio" name="ti_tempMode" value="1" ${Number(d.temperature_measurement_model)===1?'checked':''}> 低温</label>
      </div>
      <label>高温跟踪</label>
      <div class="ti-radio-group">
        <label><input type="radio" name="ti_highTracking" value="0" ${Number(d.high_temperature_tracking)===0?'checked':''}> 开</label>
        <label><input type="radio" name="ti_highTracking" value="1" ${Number(d.high_temperature_tracking)===1?'checked':''}> 关</label>
      </div>
      <label>低温跟踪</label>
      <div class="ti-radio-group">
        <label><input type="radio" name="ti_lowTracking" value="0" ${Number(d.low_temperature_tracking)===0?'checked':''}> 开</label>
        <label><input type="radio" name="ti_lowTracking" value="1" ${Number(d.low_temperature_tracking)===1?'checked':''}> 关</label>
      </div>
      <label>中心温度显示</label>
      <div class="ti-radio-group">
        <label><input type="radio" name="ti_centralTemp" value="0" ${Number(d.central_temperature)===0?'checked':''}> 开</label>
        <label><input type="radio" name="ti_centralTemp" value="1" ${Number(d.central_temperature)===1?'checked':''}> 关</label>
      </div>
      <label>高温报警</label>
      <div class="ti-radio-group">
        <label><input type="radio" name="ti_highTempAlarm" value="0" ${Number(d.high_temperature_alarm)===0?'checked':''}> 开</label>
        <label><input type="radio" name="ti_highTempAlarm" value="1" ${Number(d.high_temperature_alarm)===1?'checked':''}> 关</label>
      </div>
      <label>高温阈值(°C)</label>
      <input type="number" id="ti_highTempVal" value="${Number(d.high_temperature_threshold)||0}" />
      <div style="grid-column:1/3;" class="note">高温模式范围: 10~500；低温模式范围:-20~150</div>
      <div id="ti_warn" class="warn" style="display:none;"></div>
    </div>
    <div class="ti-actions">
      <button class="btn" id="ti_cancel">取消</button>
      <button class="btn" id="ti_ok">确认</button>
    </div>`;
  mask.appendChild(modal); document.body.appendChild(mask);

  modal.querySelector('#ti_cancel').onclick=()=>{ try{mask.remove();}catch{} };
  modal.querySelector('#ti_ok').onclick=async ()=>{
    const idNum=getDevIdNum(); if(idNum==null){ toast('error','设备未就绪'); return; }
    const getVal=(name)=> Number(modal.querySelector(`input[name="\${name}"]:checked`)?.value);
    const tempSwitch=Number(modal.querySelector('input[name="ti_tempSwitch"]:checked')?.value);
    const tempMode=Number(modal.querySelector('input[name="ti_tempMode"]:checked')?.value);
    const highTracking=Number(modal.querySelector('input[name="ti_highTracking"]:checked')?.value);
    const lowTracking=Number(modal.querySelector('input[name="ti_lowTracking"]:checked')?.value);
    const centralTemp=Number(modal.querySelector('input[name="ti_centralTemp"]:checked')?.value);
    const highTempAlarm=Number(modal.querySelector('input[name="ti_highTempAlarm"]:checked')?.value);
    const highTempVal=Number(modal.querySelector('#ti_highTempVal').value);
    const warnEl=modal.querySelector('#ti_warn');
    let okRange = tempMode===0 ? (highTempVal>=10 && highTempVal<=500)
                               : (highTempVal>=-20 && highTempVal<=150);
    if(!okRange){
      warnEl.textContent='高温阈值不在合法范围';
      warnEl.style.display='block';
      toast('error','高温阈值不在合法范围');
      return;
    }
    warnEl.style.display='none';
    try{
      await androidWsApi.setTIProbe({
        toId:idNum,tempSwitch,tempMode,highTracking,lowTracking,centralTemp,
        highTempAlarm,highTempVal,pseudoColorMode:Number(pseudoSel.value)||0,timestamp:ts()
      });
      toast('success','参数已提交');
      mask.remove();
    }catch(e){
      toast('error','参数设置失败');
    }
  };
}

/* 切换控制（占位） */
document.getElementById('btnProbeSwitch').onclick=()=>{
  const idNum=getDevIdNum(); if(idNum==null){ toast('error','设备未就绪'); return; }
  androidWsApi.sendNoWait({ cmd:'probeSwitch', toId:idNum, data:{} });
  toast('info','已发送切换指令 (占位)');
};

/* 探头信息加载 */
const showSets = {
  zoom:new Set([1,2,3,4,5,6,7,8]),
  rotate:new Set([1,3,7,8]),
  light:new Set([1,3,4,5,6,7,8]),
  thermal:new Set([2]),
  switch:new Set([8])
};

/* ===== 替换：initProbeInfo（获取探头/数量后再决定是否启用副流） ===== */
async function initProbeInfo(retry=0){
  const idNum = getDevIdNum();
  log('initProbeInfo start retry=',retry,'devId(num)=',idNum,'devId(str)=',getDevId());
  if(idNum==null){
    if(retry<20){
      await new Promise(r=>setTimeout(r,150));
      return initProbeInfo(retry+1);
    }
    err('initProbeInfo abort: devId still invalid');
    return;
  }
  try{
    const res=await androidWsApi.avProbeInfo({ toId:idNum });
    log('initProbeInfo resp', res);
    if(res.code!==0){ warn('avProbeInfo code!=0', res.code, res.msg); return; }
    const info=res.data||{};
    const { probeType, lightingStatus, quantity } = info;

    // 统一得出cameraCount（缺省1）
    cameraCount = (Number(quantity)||0) > 0 ? Number(quantity) : 1;

    if(showSets.zoom.has(probeType)){
      blkZoom.style.display='block';
      if(cameraCount>=2) zoomCamSubWrap.style.display='';
      else zoomCamSubWrap.style.display='none';
    }
    if(showSets.rotate.has(probeType)) blkRotate.style.display='block';
    if(showSets.light.has(probeType)){
      blkLight.style.display='block';
      const radio=blkLight.querySelector(`input[name="lightCtrl"][value="${lightingStatus}"]`);
      if(radio) radio.checked=true;
    }
    if(showSets.thermal.has(probeType)){
      blkThermal.style.display='block';
      try{
        const tri=await androidWsApi.getTIProbe({ toId:idNum });
        if(tri.code===0){
          buildPseudoOptions(Number(tri.data?.pseudo_color_selection)||0);
        } else buildPseudoOptions(0);
      }catch{ buildPseudoOptions(0); }
    }
    if(showSets.switch.has(probeType)) blkSwitch.style.display='block';

    // 根据数量决定 PiP & 副流
    if(cameraCount >= 2){
      enableSubPipUI();
      // 可能主流已拉起 / 未拉起，都调用一次（内部幂等）
      upgradeToDynamicStreams();
    }else{
      // 单路：确保副流 UI 不显示
      const slotPip = document.getElementById('slot_pip');
      const btnSwitch = document.getElementById('btn_switch');
      if (slotPip) slotPip.style.display='none';
      if (btnSwitch) btnSwitch.style.display='none';
      subVisible=false;
    }
  }catch(e){
    err('initProbeInfo error', e);
  }
}
await initProbeInfo();

/* WS 回调 */
bridge.onWsMessage(m=>{
  if(m && m.cmd==='cameraZoomResponse' && m.code!==0){
    toast('error','缩放失败:'+ (m.msg||''));
  }
});

/* 兜底伪彩选项 */
if(!pseudoSel.options.length) buildPseudoOptions(0);

/* ============ 动态推流管理（优化协商次数） ============ */
let __currentMainDynamicURI = null;
let __currentSubDynamicURI = null;

setTimeout(upgradeToDynamicStreams, 0);// 主流会先尝试

/* ===== 在现有变量声明区域（playerA/playerB/subVisible 声明后）新增 3 个状态变量 ===== */
let cameraCount = 1;              // 设备摄像头数量（由 avProbeInfo.quantity 得出；缺省 1）
let __mainStreamStarted = false;  // 主码流是否已动态拉起
let __subStreamStarted  = false;  // 副码流是否已动态拉起

/* ===== 新增：仅在确认有两路及以上摄像头时，初始化 PiP UI（副流容器 + 按钮） ===== */
function enableSubPipUI(){
  if (subVisible) return;                // 已启用过
  const slotPip = document.getElementById('slot_pip');
  const pipPlaceholder = document.getElementById('pip_placeholder');
  const btnSwitch = document.getElementById('btn_switch');
  if (!slotPip || !btnSwitch) return;
  slotPip.style.display='block';
  if (pipPlaceholder) pipPlaceholder.style.display='none';
  btnSwitch.style.display='inline-flex';
  subVisible = true;
}

/* ===== 替换：upgradeToDynamicStreams  =====
 * 逻辑：
 *  1. 只要主流未启动且有 devId，就尝试主流。
 *  2. 副流只有在 cameraCount>=2 且未启动时才拉。
 *  3. 多次调用安全（幂等）。
 */
async function upgradeToDynamicStreams(){
  const idNum = getDevIdNum();
  if (idNum == null) return;

  // 主码流
  if(!__mainStreamStarted){
    try {
      const mainRes = await __vdEnsureStream(idNum, 1, 0, { wantLow:false });
      if (mainRes && mainRes.streamURI && mainRes.streamURI !== __currentMainDynamicURI){
        __currentMainDynamicURI = mainRes.streamURI;
        await playerA.play(mainRes.streamURI);
        __vdRequestHigh(idNum,1,0);
      }
      __mainStreamStarted = true;
    } catch {
      // 主流失败不阻塞后续再尝试，可以留给后续重试触发
    }
  }

  // 副码流（需 ≥2 摄像头）
  if(cameraCount >= 2 && !__subStreamStarted){
    enableSubPipUI();
    try {
      const subRes = await __vdEnsureStream(idNum, 1, 1, { wantLow:false });
      if (subRes && subRes.streamURI && subRes.streamURI !== __currentSubDynamicURI){
        __currentSubDynamicURI = subRes.streamURI;
        await playerB.play(subRes.streamURI);
        __vdRequestHigh(idNum,1,1);
      }
      __subStreamStarted = true;
    } catch {
      // 副流失败保持 subVisible 状态（UI 已出现），可根据需要后续加重试
    }
  }
}

/* ============ 新增：视频详情推流管理 (前缀 __vd ) ============ */
const __VD_STREAM_RC = (function(){
  try {
    if (window.top && window.top !== window) {
      if (!window.top.__VD_STREAM_RC_SHARED__) window.top.__VD_STREAM_RC_SHARED__ = {};
      return window.top.__VD_STREAM_RC_SHARED__;
    }
  } catch {}
  if (!window.__VD_STREAM_RC_SHARED__) window.__VD_STREAM_RC_SHARED__ = {};
  return window.__VD_STREAM_RC_SHARED__;
})();

function __vdKey(devId, ht, hi){ return devId+':'+ht+':'+hi; }
/* ===== 替换：__vdEnsureStream（去掉页面内引用计数，单次 start） ===== */
async function __vdEnsureStream(devId, hardwareType, hardwareIndex, { wantLow = false, forceStart = false } = {}) {
  const toMs = (window.VIDEO_WS_RESPONSE_TIMEOUT_MS || 3000);
  let timeoutId;
  return new Promise((resolve, reject)=>{
    timeoutId = setTimeout(()=>reject(new Error('timeout')), toMs);
    androidWsApi.pushStream({
      toId:devId,
      startFlag:true,
      hardwareType,
      hardwareIndex
    }).then(resp=>{
      clearTimeout(timeoutId);
      if(!resp || resp.code!==0 || !resp.data?.streamURI){
        reject(new Error(resp?.msg||'pushStream fail'));
        return;
      }
      const uri = resp.data.streamURI;
      if (wantLow && hardwareType===1) {
        androidWsApi.pushStreamResolution({ toId:devId, streamURI:uri, quality:'low' }).catch(()=>{});
      }
      resolve({ streamURI: uri });
    }).catch(err=>{
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}
  
function __vdRequestHigh(devId, hardwareType, hardwareIndex){
  const e = __VD_STREAM_RC[__vdKey(devId,hardwareType,hardwareIndex)];
  if(!e||!e.streamURI) return;
  if(hardwareType!==1) return;
  androidWsApi.pushStreamResolution({ toId:devId, streamURI:e.streamURI, quality:'high' }).catch(()=>{});
}
/* =====（可选检查）__vdReleaseStream：视频详情仍需一次 stop —— 若当前只有 beforeunload 调用，可保留原实现 =====
   如果你确认没有其它地方再调用它，可保持原函数不变。
   若想加入幂等防守，可用下面版本替换。 */
function __vdReleaseStream(devId, hardwareType, hardwareIndex){
  if(__vdReleaseStream.__sent) return;
  __vdReleaseStream.__sent = true;
  try {
    androidWsApi.pushStream({
      toId: devId,
      startFlag:false,
      hardwareType,
      hardwareIndex
    }).catch(()=>{});
  } catch {}
}

window.addEventListener('beforeunload', ()=>{
  try {
    const n=getDevIdNum();
    if(n!=null){
      [ [1,0],[1,1] ].forEach(([ht,hi])=>__vdReleaseStream(n,ht,hi));
    }
  } catch {}
});
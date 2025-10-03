/***********************
 * 位移·倾角模式详情(调试加日志版)
 * 日志开关:
 *   window.__DETAIL_DEBUG_CLICK = true;  // 点击委托
 *   window.__DETAIL_DEBUG_MODAL = true;  // 弹窗创建
 *   window.__DETAIL_DEBUG_STATE = true;  // 状态变更
 *   window.__DETAIL_DEBUG_LIST  = true;  // 列表渲染
 *   window.__DETAIL_DEBUG_WS    = true;  // WS 数据
 ***********************/
import { mountTopbar, detailBridge, useDetailContext, setupTopbarControls } from './common/detail-common.js';
import { androidWsApi, AndroidTopics } from '@api/androidWSApi.js';
import { modePoller } from '../modes/mode-poller.js';
import { FAIL_TOAST_PREFIX } from '/config/constants.js';
import { showToast } from '@ui/toast.js';
import { createModal } from '@ui/modal.js';

const LOG = (...a)=>console.log('[MDTD]',...a);
const WARN = (...a)=>console.warn('[MDTD]',...a);
const ERR = (...a)=>console.error('[MDTD]',...a);

LOG('script start load');

const PAGE_MODEL = 2; // 需求确认：本页面所有接口 model 固定为 2
const DISP_THRESH = [0.003,0.005,0.015,0.035,0.065,0.100];
const ANGLE_THRESH = [0.3,0.5,1.0,2.0,4.0,8.0]; // 保留(不再直接显示)
const LOG_PAGE_SIZE = 50;

function thrVal(devType, idx){
  idx = Number(idx);
  if(devType===0){
    const i=(idx>=0&&idx<DISP_THRESH.length)?idx:0;
    return DISP_THRESH[i].toFixed(3)+'m';
  }else{
    const i=(idx>=0&&idx<ANGLE_THRESH.length)?idx:0;
    return ANGLE_THRESH[i].toFixed(1)+'°';
  }
}
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
function fmtDisp(v){ return (Number(v)||0).toFixed(3); }

// 倾角显示：至少两位小数，不足补 2 位；若原值有超过 2 位小数则保留
function fmtAngleFlex(v){
  const n = Number(v);
  if(!Number.isFinite(n)) return '0.00';
  const raw = String(v);
  if(raw.includes('.')){
    const [i,d] = raw.split('.');
    if(d.length>=2) return raw;
    return n.toFixed(2);
  }
  return n.toFixed(2);
}
function fmtAngle(v){ return (Number(v)||0).toFixed(2); } // 旧函数保留（位移逻辑等可能引用）
function fmtGas(v){
  const n = Number(v);
  return Number.isFinite(n)? n.toFixed(1) : '--';
}

/* ---------- 上下文与设备 ID ---------- */
const bridge = detailBridge();
const ctx = await useDetailContext(bridge, { page:'mode-disp-tilt' });
LOG('context loaded', ctx);

let devIdRaw = ctx.devId ?? null;
function getDevId(){
  return ctx.devId!=null && ctx.devId!=='' ? String(ctx.devId)
       : devIdRaw!=null && devIdRaw!=='' ? String(devIdRaw) : '';
}
function getDevIdNum(){
  const s=getDevId(); if(!s) return null;
  const n=Number(s); return Number.isFinite(n)? n : null;
}
async function waitDevId(ms=3000){
  const st=Date.now();
  while(!getDevId()){
    if(Date.now()-st>ms) break;
    await new Promise(r=>setTimeout(r,100));
  }
  devIdRaw=getDevId()||devIdRaw;
  LOG('waitDevId result', getDevId());
}

/* ---------- 顶栏 ---------- */
const ui = mountTopbar(document.body);
/* 修改：初始顶栏标签（名称未知保持空） */
// ui.lblDevNo.textContent = buildTopbarDevLabel(getDevId(), '', ctx.devNo || '');

const topbarHelper = setupTopbarControls({
  ui,
  page:'mode-disp-tilt',
  getDevIdNum: ()=>getDevIdNum(),
  bridge
});



const wrap=document.querySelector('.wrap');
const spinner = wrap.querySelector('#spinner');
const btnRefreshNow = wrap.querySelector('#btnRefreshNow');
const leftList = wrap.querySelector('#leftList');
const rightDetail = wrap.querySelector('#rightDetail');

/* 顶层控制按钮 */
const btnListAB = wrap.querySelector('#btnListAB');
const btnListRefresh = wrap.querySelector('#btnListRefresh');
const btnListFind = wrap.querySelector('#btnListFind');
const swListMonitor = wrap.querySelector('#swListMonitor');

/* ---------- 运行时状态 ---------- */
let probes=[];
let selectedProbeId=null;
let suspended=false;
let loadingCount=0;

/* 日志状态 */
let logType=0;
let logLastId=0;
let logs=[];
let logNoMore=false;
let currentLogProbe=null;

/* ---------- 通用日志状态暴露 ---------- */
function debugState(tag){
  if(!window.__DETAIL_DEBUG_STATE) return;
  LOG(tag,'selectedProbeId=',selectedProbeId,'probes.len=',probes.length);
}

/* ---------- Loading ---------- */
function showSpinner(){ loadingCount++; if(spinner.style.display!=='block') spinner.style.display='block'; }
function hideSpinner(){ loadingCount=Math.max(0,loadingCount-1); if(loadingCount===0) spinner.style.display='none'; }
function showRefresh(){ btnRefreshNow.style.display='flex'; wrap.classList.add('suspended'); loadingCount=0; spinner.style.display='none'; LOG('poll suspended showRefresh'); }
function hideRefresh(){ btnRefreshNow.style.display='none'; wrap.classList.remove('suspended'); }

btnRefreshNow.onclick = () => {
  LOG('btnRefreshNow click suspended=',suspended);
  if (suspended){
    hideRefresh();
    showSpinner();
    modePoller.resume('dipTwoChannel', getDevId(), { immediate:true });
  } else {
    hideRefresh();
    forceFetch();
  }
};

function forceFetch(){
  if (suspended){ LOG('forceFetch ignore suspended'); return; }
  const idNum=getDevIdNum(); if(idNum==null){ WARN('forceFetch no devId'); return; }
  LOG('forceFetch send', idNum);
  showSpinner();
  androidWsApi.forceListFetch('dipTwoChannel', idNum);
}

function findProbe(pid){
  return probes.find(p=>String(p.probeId)===String(pid));
}

function getSelectedProbe(){
  if(!probes || !probes.length) return null;
  if(selectedProbeId == null) return null;
  return findProbe(selectedProbeId)||null;
}

function exposeState(){
  window.probes = probes;
  window.selectedProbeId = selectedProbeId;
  debugState('exposeState');
}

/* ---------- 闪烁 ---------- */
let __blinkPhase=false;
setInterval(()=>{
  __blinkPhase=!__blinkPhase;
  try{
    leftList.querySelectorAll('img[data-blink="1"]').forEach(img=>{
      img.src = __blinkPhase ? '/res/mon_white.png' : '/res/mon_green.png';
    });
  }catch(e){}
}, 300);

/* ---------- 汇总状态 ---------- */
function aggregateStates(){
  let anyNumberOn=false, anyAlarm=false, anyMonitorOn=false;
  for(const p of probes){
    if(Number(p.numberState)===1) anyNumberOn=true;

    const cs = computeBellState(p);
    if(cs.monitor) anyMonitorOn=true;
    if(cs.alarm) anyAlarm=true;
  }
  return { anyNumberOn, anyFindOn:anyAlarm, anyMonitorOn }; // anyFindOn 复用原字段名称
}

function refreshTotalControls(){
  const { anyNumberOn, anyFindOn, anyMonitorOn } = aggregateStates(); // anyFindOn = 统一报警
  wrap.querySelector('#btnListABImg').src = anyNumberOn ? '/res/ic_ab_on.png':'/res/ic_ab_off.png';
  // 总控：未报警使用原“off”图标；报警使用红色图标（假定资源 ic_find_red.png）
  wrap.querySelector('#btnListFindImg').src = anyFindOn ? '/res/ic_find_red.png':'/res/ic_find_off.png';
  btnListAB.classList.toggle('active',anyNumberOn);
  btnListFind.classList.toggle('active',anyFindOn);
  swListMonitor.classList.toggle('on', anyMonitorOn);
  if(window.__DETAIL_DEBUG_LIST) LOG('refreshTotalControls', { anyNumberOn, anyAlarm:anyFindOn, anyMonitorOn });
}

/* ---------- 铃铛三态 ---------- */
function computeBellState(p){
  // 监控开启：位移或倾角任一监控字段为 1
  const monitor = Number(p?.offsetInfo?.offsetMoniterState)===1 || Number(p?.angleInfo?.moniterState)===1;

  // 统一报警字段（任意非 0 即为报警）
  const alarm = [
    p?.offsetInfo?.offsetAlarmState,
    p?.offsetInfo?.findState,
    p?.offsetInfo?.lGasAlarmState,
    p?.offsetInfo?.rGasAlarmState,
    p?.angleInfo?.is_vibration_alarm,
    p?.angleInfo?.is_angle_alarm
  ].some(v=>Number(v));

  return { monitor, alarm };
}

/* ---------- 列表渲染(改造：电池加数字 / 倾角值垂直+波浪线) ---------- */
/* 修改函数：renderList （A1/A2 左侧列表最后一列显示逻辑同步缩略图：位移=移动值/错误；倾角=angle_change） */
function renderList(){
  if(window.__DETAIL_DEBUG_LIST) LOG('renderList start','probes',probes.length,'selected',selectedProbeId);
  leftList.innerHTML='';
  const arr=probes.slice(0,200);
  if(!selectedProbeId && arr.length){
    selectedProbeId=arr[0].probeId;
    debugState('renderList set first selected');
  }

  arr.forEach(p=>{
    const isSel = String(p.probeId)===String(selectedProbeId);
    const devType = Number(p.devType)||0;
    const row=document.createElement('div');
    row.className='probe-row'+(isSel?' selected':'');
    row.dataset.pid=String(p.probeId);
    const numberTxt = (p.number==null || Number(p.number)<0)?'--':p.number;
    const battLvl=mapBattery7(p.battery);
    const battNum=Math.round(Math.max(0,Math.min(100,Number(p.battery)||0)));

    const { monitor, alarm } = computeBellState(p);

    let monIconSrc='/res/mon_white.png';
    let blinkAttr='';
    if(alarm){
      monIconSrc='/res/mon_red.png';
    }else if(monitor){
      monIconSrc=__blinkPhase?'/res/mon_white.png':'/res/mon_green.png';
      blinkAttr=' data-blink="1"';
    }

    // A1 / A2: 计算显示文本与颜色
    let valueHtml='';
    if(devType===0){
      const offState = Number(p?.offsetInfo?.offsetState);
      if(offState>0 && offState<6){
        valueHtml = `<div class="value-box" style="justify-content:center;width:100%;"><span style="color:#ff6b6b">错误</span></div>`;
      }else{
        const diffTxt = fmtDisp(p?.offsetInfo?.offsetValueDiff)+'m';
        const diffColor = Number(p?.offsetInfo?.offsetAlarmState)===0 ? '#2eff67' : '#ff6b6b';
        valueHtml = `<div class="value-box" style="justify-content:center;width:100%;"><span style="color:${diffColor}">${diffTxt}</span></div>`;
      }
    }else{
      const changeTxt = fmtAngleFlex(p?.angleInfo?.angle_change)+'°';
      const changeColor = Number(p?.angleInfo?.is_angle_alarm)===0 ? '#2eff67':'#ff6b6b';
      valueHtml = `
        <div class="value-box-tilt">
          <span style="color:${changeColor}">${changeTxt}</span>
          <img class="wave" src="/res/${Number(p?.angleInfo?.is_vibration_alarm)?'wave_red':'wave_green'}.png">
        </div>
      `;
    }

    row.innerHTML=`
      <div>${devType===0?'位移':'倾角'}</div>
      <div style="border:1px solid #48c2ff;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-weight:700;">${numberTxt}</div>
      <div><img src="/res/wifi${p.wifiGrade||p.wifiStrength||0}.png" style="width:28px;height:18px;"></div>
      <div>
        <div class="batt-wrap">
          <img src="/res/bat${battLvl}.png" style="width:32px;height:14px;">
          <span>${battNum}</span>
        </div>
      </div>
      <div><img src="${monIconSrc}"${blinkAttr} style="width:24px;height:24px;"></div>
      ${valueHtml}
    `;
    leftList.appendChild(row);
  });

  if(!arr.length){
    const emp=document.createElement('div');
    emp.style.color='#678';
    emp.style.textAlign='center';
    emp.style.padding='40px 0';
    emp.textContent='暂无探头';
    leftList.appendChild(emp);
  }
  refreshTotalControls();
  exposeState();
  if(window.__DETAIL_DEBUG_LIST) LOG('renderList end');
}

function handleSelect(e){
  if(wrap.classList.contains('suspended')){ LOG('handleSelect ignore suspended'); return; }
  const row=e.target.closest('.probe-row'); if(!row) return;
  const newPid=row.dataset.pid;
  if(!newPid) return;
  const changed = String(selectedProbeId)!==String(newPid);
  if(!changed){ if(window.__DETAIL_DEBUG_LIST) LOG('handleSelect same pid'); return;}
  selectedProbeId=newPid;
  exposeState();
  renderList();
  renderDetail(true);
  LOG('handleSelect changed',newPid);
}
leftList.addEventListener('mousedown', handleSelect);
leftList.addEventListener('click', handleSelect);

/* ---------- 顶部按钮逻辑 ---------- */
btnListAB.onclick = ()=>{
  LOG('btnListAB click');
  if(wrap.classList.contains('suspended')) return;
  const idNum=getDevIdNum(); if(idNum==null || probes.length===0) return;
  const { anyNumberOn } = aggregateStates();
  showSpinner();
  androidWsApi.controlDip({
    toId:idNum,
    operation:anyNumberOn?0:1,
    commandType:3,
    probeId:probes.map(p=>p.probeId),
    timestamp:Math.floor(Date.now()/1000)
  }).finally(forceFetch);
};
btnListRefresh.onclick = ()=>{
  LOG('btnListRefresh click');
  probes=[]; selectedProbeId=null;
  exposeState();
  renderList(); renderDetail(true);
  forceFetch();
};
btnListFind.onclick = ()=>{
  LOG('btnListFind click');
  if(wrap.classList.contains('suspended')) return;
  const idNum=getDevIdNum(); if(idNum==null || probes.length===0) return;
  const { anyFindOn } = aggregateStates();
  showSpinner();
  androidWsApi.controlDip({
    toId:idNum,
    operation:anyFindOn?0:1,
    commandType:4,
    probeId:probes.map(p=>p.probeId),
    timestamp:Math.floor(Date.now()/1000)
  }).finally(forceFetch);
};
swListMonitor.onclick = ()=>{
  LOG('swListMonitor click');
  if(wrap.classList.contains('suspended')) return;
  const idNum=getDevIdNum(); if(idNum==null || probes.length===0) return;
  const { anyMonitorOn } = aggregateStates();
  showSpinner();
  androidWsApi.controlDip({
    toId:idNum,
    operation:anyMonitorOn?0:1,
    commandType:5,
    probeId:probes.map(p=>p.probeId),
    timestamp:Math.floor(Date.now()/1000)
  }).finally(forceFetch);
};

/* ---------- 日志渲染 ---------- */
function updateLogUI(){
  const logBox = rightDetail.querySelector('#logBox');
  if(!logBox) return;
  const listHtml = logs.map(l=>`<div class="log-item">${l.logContent||''}</div>`).join('');
  let footer='';
  if(logNoMore){
    footer='<div class="log-footer"><div class="log-end">没有更多了</div></div>';
  }else{
    footer='<div class="log-footer"><button class="log-more-btn" id="btnLogUpdate">更多</button></div>';
  }
  logBox.innerHTML =  (listHtml  ) + footer;
  if(!logNoMore){
    const btn=logBox.querySelector('#btnLogUpdate');
    if(btn){ btn.onclick=()=>fetchLogs(); }
  }
  if(window.__DETAIL_DEBUG_STATE) LOG('updateLogUI logs.len=',logs.length,'noMore=',logNoMore);
}

function fetchLogs(initial=false){
  const p=getSelectedProbe();
  if(!p){ LOG('fetchLogs no selected probe'); return; }
  if(!initial && currentLogProbe===String(p.probeId) && logs.length && logNoMore){
    return;
  }
  const logBox = rightDetail.querySelector('#logBox');
  const prevScrollTop = logBox ? logBox.scrollTop : 0;
  const atBottom = logBox ? (logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 4) : false;

  const idNum=getDevIdNum(); if(idNum==null){ WARN('fetchLogs no devId'); return; }
  const model = Number(p.devType)===0 ? PAGE_MODEL : PAGE_MODEL; // 固定 2
  if(window.__DETAIL_DEBUG_STATE) LOG('fetchLogs send',{probeId:p.probeId, model, logType, last:logLastId});
  androidWsApi.getProbeLog({
    toId:idNum,
    model,
    logType,
    probeId:String(p.probeId),
    logId: logLastId || 0,
    quantity:LOG_PAGE_SIZE,
    timestamp:Math.floor(Date.now()/1000)
  }).then(resp=>{
    const arr = resp?.data?.logInfos || resp?.data || resp?.list || resp?.logs || [];
    if(!logLastId){ logs=[]; logNoMore=false; }
    if(Array.isArray(arr) && arr.length){
      logs = logs.concat(arr);
      logLastId = arr[arr.length-1].id;
      if(arr.length<LOG_PAGE_SIZE) logNoMore=true;
    }else{
      if(!logs.length) logNoMore=true; else logNoMore=true;
    }
    currentLogProbe=String(p.probeId);
    updateLogUI();
    const newLogBox = rightDetail.querySelector('#logBox');
    if(newLogBox){
      if(logLastId && !atBottom){
        newLogBox.scrollTop = prevScrollTop;
      }else if(atBottom){
        newLogBox.scrollTop = newLogBox.scrollHeight;
      }
    }
  }).catch(err=>{
    ERR('fetchLogs error',err);
  });
}


/* 修改函数：ensureAngleDetailStyles
 * 仅新增气体名称不换行显示规则（加宽并禁止换行），其它内容不动
 */
function ensureAngleDetailStyles(){
  const id='__angle_detail_patch_style';
  if(document.getElementById(id)) return;
  const css = `
  /* 统一模块边框 */
  .angle-module-box,
  .gas-module-box,
  .vibration-module-box,
  .disp-tilt-module-box{
    border:1px solid #2ea6a6;
    border-radius:4px;
    padding:8px 10px;
  }
  /* 角度模块布局 */
  .angle-module-content{
    display:flex;
    gap:24px;
  }
  .angle-left-col{
    flex:1;
    display:flex;
    flex-direction:column;
    gap:4px;
    font-size:14px;
  }
  .angle-left-col .angle-line{
    line-height:1.9;
    padding:2px 0;
  }
  .angle-left-col .angle-line-divider{
    height:1px;
    background:#2a2f33;
    margin:0;
  }
  /* 右侧报警/移动列 */
  .angle-right-col{
    width:190px;
    display:flex;
    flex-direction:column;
    align-items:center;
    gap:14px;
    padding-top:2px;
  }
  .angle-right-title{
    font-size:14px;
    font-weight:700;
    color:#e6f0ff;
    text-align:center;
    line-height:1;
    margin-bottom:4px;
  }
  .angle-alarm-row{
    display:flex;
    align-items:center;
    justify-content:center;
    gap:10px;
  }
  .angle-alarm-row .arrow-inline{
    font-size:22px;
    cursor:pointer;
    user-select:none;
    line-height:1;
  }
  .angle-threshold-box{
    min-width:108px;
    height:44px;
    display:flex;
    align-items:center;
    justify-content:center;
    background:#1a1f22;
    border:1px solid #2ea6a6;
    border-radius:4px;
    font-weight:700;
    font-size:20px;
    color:#2eff67;
    padding:0 6px;
  }
  .angle-move-box{
    min-width:108px;
    height:44px;
    display:flex;
    align-items:center;
    justify-content:center;
    background:#08161d;
    border:1px solid #2ea6a6;
    border-radius:4px;
    font-weight:700;
    font-size:20px;
    color:#2eff67;
    padding:0 6px;
  }
  /* 震动模块（单独块） */
  .vibration-module-box{
    width:160px;
    display:flex;
    flex-direction:column;
    align-items:center;
    gap:4px;
    cursor:pointer;
    padding:6px 8px 0 8px;
    background:#08161d;
  }
  .vibration-module-box:hover{background:#072630;}
  .vibration-wave-wrap{
    width:100%;
    height:38px;
    display:flex;
    align-items:center;
    justify-content:center;
    overflow:hidden;
  }
  .vibration-wave-wrap img{
    width:100%;
    height:34px;
    object-fit:contain;
    display:block;
  }
  .vibration-mode-label{
    width:100%;
    background:#ffffff;
    color:#000;
    font-size:12px;
    text-align:center;
    padding:4px 0 6px 0;
    line-height:1;
    border-top:1px solid #2ea6a6;
    border-radius:0 0 4px 4px;
    font-weight:600;
  }
  /* 冒号对齐标签宽度 + 角度标签颜色白色 */
  .angle-label,
  .gas-label,
  .disp-label{
    display:inline-block;
    width:60px;
    color:#ffffff;
  }
  /* 气体模块 */
  .gas-module-box{
    flex:1;
  }
  .gas-row-line{
    display:flex;
    align-items:center;
    line-height:1.9;
    padding:2px 0;
    position:relative;
  }
  .gas-row-line:not(:last-child){
    border-bottom:1px solid #2a2f33;
  }
  .gas-row-line .gas-val{
    font-weight:700;
    color:#2eff67;
    min-width:110px;
    display:inline-flex;
    align-items:center;
    padding:2px 6px;
    border:1px solid transparent;
    border-radius:4px;
    cursor:pointer;
  }
  .gas-row-line .gas-val.offline{
    cursor:default;
    color:#ff6b6b;
  }
  .gas-row-line .gas-val.alarm{color:#ff6b6b;}
  .gas-row-line .gas-val:not(.offline):hover{
    background:#08161d;
    border-color:#2ea6a6;
  }
  /* 位移模块(倾角下方) 横向布局：左(距离/移动值) 右(报警值) */
  .disp-tilt-flex{
    display:flex;
    gap:48px;
    align-items:flex-start;
  }
  .disp-tilt-left{
    flex:1;
    display:flex;
    flex-direction:column;
  }
  .disp-tilt-left .disp-row{
    display:flex;
    align-items:center;
    padding:6px 0;
    line-height:1.8;
  }
  .disp-tilt-left .disp-row:not(:last-child){
    border-bottom:1px solid #2a2f33;
  }
  .disp-tilt-right{
    width:210px;
    display:flex;
    flex-direction:column;
    align-items:center;
    gap:8px;
  }
  .disp-alarm-title{
    font-size:14px;
    font-weight:700;
    color:#e6f0ff;
    line-height:1;
  }
  .disp-alarm-inline{
    display:flex;
    align-items:center;
    justify-content:center;
    gap:10px;
  }
  .disp-alarm-inline .arrow-inline{
    font-size:22px;
    cursor:pointer;
    user-select:none;
    line-height:1;
  }
  .disp-alarm-value-box{
    min-width:108px;
    height:44px;
    display:flex;
    align-items:center;
    justify-content:center;
    background:#1a1f22;
    border:1px solid #2ea6a6;
    border-radius:4px;
    font-weight:700;
    font-size:20px;
    color:#2eff67;
    padding:0 6px;
    cursor:pointer;
  }
  /* 列表中倾角探头的波浪线再缩小 */
  .value-box-tilt .wave{
    height:10px !important;
    width:auto;
    margin:0;
  }

  /* === 新增: 气体标签不换行并加宽，防止名称折行 === */
  .gas-module-box .gas-label{
    width:120px;          /* 由 60px 加宽，避免中文+英文组合换行 */
    white-space:nowrap;
    overflow:visible;
  }
  `;
  const style=document.createElement('style');
  style.id=id;
  style.textContent=css;
  document.head.appendChild(style);
}

/* 新增函数：ensureVibrationBlinkLoop （B5 震动白/黄闪烁） */
function ensureVibrationBlinkLoop(){
  if(window.__VIB_BLINK_LOOP_STARTED) return;
  window.__VIB_BLINK_LOOP_STARTED = true;
  window.__vibBlinkPhase = false;
  setInterval(()=>{
    window.__vibBlinkPhase = !window.__vibBlinkPhase;
    try{
      document.querySelectorAll('#vib-wave[data-vib-blink="1"]').forEach(img=>{
        img.src = window.__vibBlinkPhase ? '/res/wave_green.png' : '/res/wave_yellow.png';
      });
    }catch(e){}
  },600);
}

/* 修改函数：renderDetail （实现 B1~B6 要求） */
/* 修改函数：renderDetail （修正气体单位重复且单位颜色白色；位移与倾角气体值=红/绿，单位=白；保持之前的点击范围与模块边框设置） */
function renderDetail(forceLogReload){
  ensureAngleDetailStyles();
  ensureVibrationBlinkLoop();

  const p = getSelectedProbe();
  if(window.__DETAIL_DEBUG_STATE) LOG('renderDetail start forceLogReload=',forceLogReload,'probe=',p && p.probeId);
  if(!p){
    rightDetail.innerHTML='<div class="placeholder" style="margin:auto;color:#678;">暂无探头</div>';
    return;
  }
  const devType = Number(p.devType)||0;
  const isTilt = devType!==0;

  const findOn = [
    p?.offsetInfo?.offsetAlarmState,
    p?.offsetInfo?.findState,
    p?.offsetInfo?.lGasAlarmState,
    p?.offsetInfo?.rGasAlarmState,
    p?.angleInfo?.is_vibration_alarm,
    p?.angleInfo?.is_angle_alarm
  ].some(v=>Number(v));

  const monOn = Number(p?.offsetInfo?.offsetMoniterState)===1 || Number(p?.angleInfo?.moniterState)===1;
  const numberOn = Number(p.numberState)===1;

  let showGas1=false, showGas2=false;
  if(devType===0){
    if(Number(p.devVersion)===3){
      showGas1=true; showGas2=true;
    }
  }else{
    showGas1=true; showGas2=true;
  }

  const numberTxt = (p.number==null || Number(p.number)<0)?'--':p.number;
  const gasState = Number(p?.offsetInfo?.gasState); // 0关 1开 2自检

  function buildGasLinesForTilt(){
    if(gasState===0) return `<div class="gas-row-line"><span style="color:#e6f0ff;">气体模块已关闭</span></div>`;
    if(gasState===2) return `<div class="gas-row-line"><span style="color:#e6f0ff;">气体模块正在自检</span></div>`;
    const g=p.gasInfo||{};
    // 左
    const lType=Number(g.lGasType);
    const lValid = lType!==255 && lType!==-1 && lType!==undefined;
    const lAlarm = Number(g.lGasAlarmState)||0;
    const lAlarmTxt = lAlarm===2?' 低报':(lAlarm===3?' 高报':'');
    const lName = lValid ? (g.lGasUnitName||'气体1') : '气体1';
    const lUnit = lValid ? (g.lGasUnit||'') : '';
    const lVal = lValid ? fmtGas(g.lGasVal) : '离线';
    const lCls = !lValid?'offline':(lAlarm?'alarm':'');
    const lAct = lValid ? 'data-act="gas-edit-left"':'';
    // 右
    const rType=Number(g.rGasType);
    const rValid = rType!==255 && rType!==-1 && rType!==undefined;
    const rAlarm = Number(g.rGasAlarmState)||0;
    const rAlarmTxt = rAlarm===2?' 低报':(rAlarm===3?' 高报':'');
    const rName = rValid ? (g.rGasUnitName||'气体2') : '气体2';
    const rUnit = rValid ? (g.rGasUnit||'') : '';
    const rVal = rValid ? fmtGas(g.rGasVal) : '离线';
    const rCls = !rValid?'offline':(rAlarm?'alarm':'');
    const rAct = rValid ? 'data-act="gas-edit-right"':'';
    return `
      <div class="gas-row-line">
        <span class="gas-label">${lName}:</span>
        <span id="gas1-val" class="gas-val ${lCls}" ${lAct}>
          ${lValid?`
            <span class="gas-num" style="color:${lAlarm?'#ff6b6b':'#2eff67'}">${lVal}</span>
            <span class="gas-unit" style="color:#e6f0ff;margin-left:4px;">${lUnit}</span>
            ${lAlarmTxt?`<span class="gas-alarm" style="color:#ff6b6b;margin-left:6px;">${lAlarmTxt.trim()}</span>`:''}
          `:'离线'}
        </span>
      </div>
      <div class="gas-row-line">
        <span class="gas-label">${rName}:</span>
        <span id="gas2-val" class="gas-val ${rCls}" ${rAct}>
          ${rValid?`
            <span class="gas-num" style="color:${rAlarm?'#ff6b6b':'#2eff67'}">${rVal}</span>
            <span class="gas-unit" style="color:#e6f0ff;margin-left:4px;">${rUnit}</span>
            ${rAlarmTxt?`<span class="gas-alarm" style="color:#ff6b6b;margin-left:6px;">${rAlarmTxt.trim()}</span>`:''}
          `:'离线'}
        </span>
      </div>
    `;
  }

  function buildGasPartForDisp(){
    if(gasState===0) return `<div class="disp-line"><label style="width:120px;white-space:nowrap;">气体:</label><span style="color:#e6f0ff;">气体模块已关闭</span></div>`;
    if(gasState===2) return `<div class="disp-line"><label style="width:120px;white-space:nowrap;">气体:</label><span style="color:#e6f0ff;">气体模块正在自检</span></div>`;
    const g=p.gasInfo||{};
    const lAlarm = Number(g.lGasAlarmState)||0;
    const rAlarm = Number(g.rGasAlarmState)||0;
    const lType=Number(g.lGasType);
    const rType=Number(g.rGasType);
    const lValid = lType!==255 && lType!==-1 && lType!==undefined;
    const rValid = rType!==255 && rType!==-1 && rType!==undefined;
    const lName = lValid ? (g.lGasUnitName||'气体1') : '气体1';
    const rName = rValid ? (g.rGasUnitName||'气体2') : '气体2';
    const lUnit = lValid ? (g.lGasUnit||'') : '';
    const rUnit = rValid ? (g.rGasUnit||'') : '';
    const lAlarmTxt = lAlarm===2?' 低报':(lAlarm===3?' 高报':'');
    const rAlarmTxt = rAlarm===2?' 低报':(rAlarm===3?' 高报':'');
    const lColor = lValid ? (lAlarm? '#ff6b6b':'#2eff67'):'#ff6b6b';
    const rColor = rValid ? (rAlarm? '#ff6b6b':'#2eff67'):'#ff6b6b';
    const lVal = lValid ? fmtGas(g.lGasVal):'离线';
    const rVal = rValid ? fmtGas(g.rGasVal):'离线';
    return `
      <div class="disp-line">
        <label style="width:120px;white-space:nowrap;">${lName}:</label>
        <span id="gas1-val" class="val" ${lValid?'data-act="gas-edit-left"':''} style="color:${lColor};">
          ${lValid?`
            <span class="gas-num" style="color:${lColor};">${lVal}</span>
            <span class="gas-unit" style="color:#e6f0ff;margin-left:4px;">${lUnit}</span>
            ${lAlarmTxt?`<span class="gas-alarm" style="color:#ff6b6b;margin-left:6px;">${lAlarmTxt.trim()}</span>`:''}
          `:'离线'}
        </span>
      </div>
      <div class="disp-line">
        <label style="width:120px;white-space:nowrap;">${rName}:</label>
        <span id="gas2-val" class="val" ${rValid?'data-act="gas-edit-right"':''} style="color:${rColor};">
          ${rValid?`
            <span class="gas-num" style="color:${rColor};">${rVal}</span>
            <span class="gas-unit" style="color:#e6f0ff;margin-left:4px;">${rUnit}</span>
            ${rAlarmTxt?`<span class="gas-alarm" style="color:#ff6b6b;margin-left:6px;">${rAlarmTxt.trim()}</span>`:''}
          `:'离线'}
        </span>
      </div>
    `;
  }

  /* 倾角探头块（保持之前逻辑，只调整气体显示结构） */
  const angleBlock = isTilt ? (()=>{
    const showDispModule = p.offsetInfo && Number(p.offsetInfo.offsetState)!==8;
    const angleChangeVal = Number(p.angleInfo?.angle_change)||0;
    const angleChangeAlarm = Number(p.angleInfo?.is_angle_alarm)!==0;
    const angleChangeColor = angleChangeAlarm ? '#ff6b6b' : '#2eff67';
    let vibWaveSrc='/res/wave_green.png';
    let vibBlinkAttr='';
    if(monOn){
      if(Number(p.angleInfo?.is_vibration_alarm)){
        vibWaveSrc='/res/wave_red.png';
      }else{
        vibBlinkAttr=' data-vib-blink="1"';
        vibWaveSrc = window.__vibBlinkPhase ? '/res/wave_green.png':'/res/wave_yellow.png';
      }
    }
    const gasLines = buildGasLinesForTilt();
    return `
    <div style="font-weight:700;margin-bottom:4px;">倾角探头 ${numberTxt}号</div>
    <div class="detail-icons-bar">
      <button class="icon-btn-img ${numberOn?'active':''}" data-act="toggle-number" title="大小显">
        <img id="btnDetailABImg" src="${numberOn?'/res/ic_ab_on.png':'/res/ic_ab_off.png'}">
      </button>
      <button class="icon-btn-img ${findOn?'active':''}" data-act="toggle-find" title="报警/爆闪">
        <img id="btnDetailFindImg" src="${findOn?'/res/ic_find_red.png':'/res/ic_find_off.png'}">
      </button>
      <div class="detail-switch-holder ${monOn?'active':''}" data-act="toggle-monitor" style="cursor:pointer;">
        <div id="detailMonitorSwitch" class="switch ${monOn?'on':''}" data-act="toggle-monitor" style="cursor:pointer;"></div>
      </div>
    </div>
    <div class="angle-module-box">
      <div class="angle-module-content">
        <div class="angle-left-col">
          <div class="angle-line"><span class="angle-label">角&nbsp;&nbsp;度:</span></div>
          <div class="angle-line" style="color:#2eff67;">X: <span id="ang-x">${fmtAngleFlex(p.angleInfo?.current_X)}°</span></div>
          <div class="angle-line-divider"></div>
          <div class="angle-line" style="color:#2eff67;">Y: <span id="ang-y">${fmtAngleFlex(p.angleInfo?.current_Y)}°</span></div>
          <div class="angle-line-divider"></div>
          <div class="angle-line" style="color:#2eff67;">Z: <span id="ang-z">${fmtAngleFlex(p.angleInfo?.current_Z)}°</span></div>
          <div class="angle-line-divider"></div>
        </div>
        <div class="angle-right-col">
          <div>
            <div class="angle-right-title">报警值</div>
            <div class="angle-alarm-row">
              <span class="arrow-inline" data-act="angle-th-dec">◀</span>
              <div id="angle-threshold" class="angle-threshold-box no-click">${p.angleInfo?.angle_threshold!=null?p.angleInfo.angle_threshold+'°':'--'}</div>
              <span class="arrow-inline" data-act="angle-th-inc">▶</span>
            </div>
          </div>
          <div>
            <div class="angle-right-title">移动值</div>
            <div id="angle-move" class="angle-move-box" style="color:${angleChangeColor};">${angleChangeVal.toFixed(2)}°</div>
          </div>
        </div>
      </div>
    </div>
    <div style="display:flex;gap:24px;margin-top:10px;">
      <div class="gas-module-box">
        ${gasLines}
      </div>
      <div class="vibration-module-box" id="angle-vibration-box" data-act="vibration-mode">
        <div class="vibration-wave-wrap">
          <img id="vib-wave"${vibBlinkAttr} src="${vibWaveSrc}" alt="">
        </div>
        <div id="vib-mode-text" class="vibration-mode-label">模式：${(['低灵敏度','中灵敏度','高灵敏度'][Number(p.angleInfo?.vibration_mode)||0])}</div>
      </div>
    </div>
    ${showDispModule?(()=>{
      const offState = Number(p.offsetInfo?.offsetState);
      const isErr = offState===1||offState===2||offState===5;
      const distTxt = isErr ? '错误' : fmtDisp(p.offsetInfo?.offsetValue);
      const distColor = isErr ? '#ff6b6b':'#2eff67';
      const moveTxt = isErr ? '错误' : fmtDisp(p.offsetInfo?.offsetValueDiff);
      const moveColor = isErr ? '#ff6b6b' : (Number(p.offsetInfo?.offsetAlarmState)?'#ff6b6b':'#2eff67');
      return `
      <div class="disp-tilt-module-box" style="margin-top:10px;">
        <div class="disp-tilt-flex">
          <div class="disp-tilt-left">
            <div class="disp-row"><span class="disp-label">距&nbsp;&nbsp;离:</span><span id="mod-disp-distance" style="font-weight:700;color:${distColor};min-width:110px;display:inline-block;">${distTxt}</span><span style="font-size:12px;">${isErr?'':'m'}</span></div>
            <div class="disp-row"><span class="disp-label">移动值:</span><span id="mod-disp-move" style="font-weight:700;color:${moveColor};min-width:110px;display:inline-block;">${moveTxt}</span><span style="font-size:12px;">${isErr?'':'m'}</span></div>
          </div>
          <div class="disp-tilt-right">
            <div class="disp-alarm-title">报警值</div>
            <div class="disp-alarm-inline">
              <span class="arrow-inline" data-act="disp-th-dec">◀</span>
              <div id="mod-disp-alarm" class="disp-alarm-value-box" data-act="disp-th-set">${(p.offsetInfo?.offsetValueAlarm??0).toFixed(3)}</div>
              <span class="arrow-inline" data-act="disp-th-inc">▶</span>
            </div>
          </div>
        </div>
      </div>`;
    })():''}
    `;
  })() : '';

  const dispOnly = !isTilt ? (()=>{
    const offState = Number(p.offsetInfo?.offsetState);
    const isErr = offState===1||offState===2||offState===5;
    const distTxt = isErr ? '错误' : fmtDisp(p.offsetInfo?.offsetValue);
    const distColor = isErr ? '#ff6b6b':'#2eff67';
    const moveTxt = isErr ? '错误' : fmtDisp(p.offsetInfo?.offsetValueDiff);
    const moveColor = isErr ? '#ff6b6b' : (Number(p.offsetInfo?.offsetAlarmState)?'#ff6b6b':'#2eff67');
    const gasPart = buildGasPartForDisp();
    return `
    <div style="font-weight:700;margin-bottom:4px;">位移探头 ${numberTxt}号</div>
    <div class="detail-icons-bar" style="margin-top:0;">
      <button class="icon-btn-img ${numberOn?'active':''}" data-act="toggle-number" title="大小显">
        <img id="btnDetailABImg" src="${numberOn?'/res/ic_ab_on.png':'/res/ic_ab_off.png'}">
      </button>
      <button class="icon-btn-img ${findOn?'active':''}" data-act="toggle-find" title="报警/爆闪">
        <img id="btnDetailFindImg" src="${findOn?'/res/ic_find_red.png':'/res/ic_find_off.png'}">
      </button>
      <div class="detail-switch-holder ${monOn?'active':''}" data-act="toggle-monitor" style="cursor:pointer;">
        <div id="detailMonitorSwitch" class="switch ${monOn?'on':''}" data-act="toggle-monitor" style="cursor:pointer;"></div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:4px;">
      <div class="disp-module-box" style="border:1px solid #2ea6a6;border-radius:4px;padding:6px 10px;display:flex;gap:40px;align-items:flex-start;flex-wrap:wrap;">
        <div style="min-width:180px;">
          <div class="disp-line"><label style="width:72px;">距  离:</label><span id="disp-distance" class="val" style="color:${distColor};">${distTxt}</span><span>${isErr?'':'m'}</span></div>
          <div class="disp-line"><label style="width:72px;">移动值:</label><span id="disp-move" class="val" style="color:${moveColor};">${moveTxt}</span><span>${isErr?'':'m'}</span></div>
        </div>
        <div style="flex:1;min-width:160px;display:flex;flex-direction:column;align-items:center;gap:6px;justify-content:center;">
          <div style="font-size:12px;">报警值</div>
          <div class="alarm-inline-wrap" style="justify-content:center;">
            <span class="arrow-inline" data-act="disp-th-dec">◀</span>
            <div id="alarm-disp-val" class="alarm-value-box" data-act="disp-th-set" style="min-width:110px;">${(p.offsetInfo?.offsetValueAlarm??0).toFixed(3)}</div>
            <span class="arrow-inline" data-act="disp-th-inc">▶</span>
          </div>
        </div>
      </div>
      <div class="gas-module-box" style="border:1px solid #2ea6a6;border-radius:4px;padding:6px 10px;">
        ${gasPart}
      </div>
    </div>
    `;
  })() : '';

  const airMode = Number(p.angleInfo?.air_pressure_mode);
  const airColor = airMode===2 ? '#ff6b6b' : (airMode===1 ? '#ffc800' : '#2eff67');
  const bottomAirHtml = isTilt ? `
    <div class="bottom-air" style="margin-top:6px;">
      <div>气压: <span id="air-pressure" style="color:${airColor};">${p.angleInfo?.air_pressure ?? '--'}</span> hps</div>
      <div>海拔: <span id="height-val">${p.angleInfo?.height ?? '--'}</span> m</div>
    </div>
  ` : '';

  let gpsHtml='';
  if(devType===0 && Number(p.devVersion)===3){
    const sat = Number(p.offsetInfo?.gpsSatelliteCount)||0;
    if(sat<=0){
      gpsHtml = `
      <div class="gps-box">
        <img id="gps-icon" src="/res/gps_none.png">
        <span id="gps-text"></span>
      </div>`;
    }else{
      const lon = p.offsetInfo?.gpsLong;
      const lat = p.offsetInfo?.gpsLat;
      gpsHtml = `
      <div class="gps-box">
        <img id="gps-icon" src="/res/gps_ok.png" style="position:relative;">
        <span id="gps-text">${lon},${lat}<sup style="font-size:10px;margin-left:2px;">${sat}</sup></span>
      </div>`;
    }
  }

  rightDetail.innerHTML = `
    ${isTilt?angleBlock:dispOnly}
    <div class="section-title">数据记录</div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
      <select id="logFilter" style="background:#0a0f14;color:#e6f0ff;border:1px solid #2ea6a6;padding:4px 6px;">
        <option value="0">全部</option>
        <option value="1">报警</option>
        <option value="2">自检异常</option>
        <option value="3">定位</option>
        <option value="4">监控</option>
        <option value="5">未知</option>
      </select>
    </div>
    <div class="log-box" id="logBox"></div>
    ${gpsHtml}
    ${bottomAirHtml}
  `;

  const sel = rightDetail.querySelector('#logFilter');
  sel.value=String(logType);
  sel.addEventListener('change',e=>{
    logType=Number(e.target.value)||0;
    logs=[]; logLastId=0; logNoMore=false; currentLogProbe=null;
    fetchLogs(true);
  });

  const pidStr=String(p.probeId);
  if(forceLogReload || currentLogProbe!==pidStr || !logs.length){
    logs=[]; logLastId=0; logNoMore=false; currentLogProbe=null;
    fetchLogs(true);
  }else{
    updateLogUI();
  }
  if(window.__DETAIL_DEBUG_STATE) LOG('renderDetail done');
}

/* 修改函数：updateDetailDynamic （同步保持单位白色且不重复，数值/报警颜色实时更新） */
function updateDetailDynamic(p){
  if(!p) return;
  try{
    const devType=Number(p.devType)||0;
    const isTilt = devType!==0;
    const numberOn = Number(p.numberState)===1;
    const findOn = [
      p?.offsetInfo?.offsetAlarmState,
      p?.offsetInfo?.findState,
      p?.offsetInfo?.lGasAlarmState,
      p?.offsetInfo?.rGasAlarmState,
      p?.angleInfo?.is_vibration_alarm,
      p?.angleInfo?.is_angle_alarm
    ].some(v=>Number(v));
    const monOn  = Number(p?.offsetInfo?.offsetMoniterState)===1 || Number(p?.angleInfo?.moniterState)===1;

    const abImg = rightDetail.querySelector('#btnDetailABImg');
    if(abImg) abImg.src = numberOn?'/res/ic_ab_on.png':'/res/ic_ab_off.png';
    const findImg = rightDetail.querySelector('#btnDetailFindImg');
    if(findImg) findImg.src = findOn?'/res/ic_find_red.png':'/res/ic_find_off.png';
    const monSw = rightDetail.querySelector('#detailMonitorSwitch');
    if(monSw){
      monSw.classList.toggle('on', monOn);
      const holder = monSw.parentElement;
      if(holder) holder.classList.toggle('active', monOn);
    }

    if(!isTilt){
      // 位移模块
      const offState = Number(p.offsetInfo?.offsetState);
      const isErr = offState===1||offState===2||offState===5;
      const dSpan = rightDetail.querySelector('#disp-distance');
      if(dSpan){
        if(isErr){
          dSpan.textContent='错误';
          dSpan.style.color='#ff6b6b';
          const unitEl = dSpan.nextElementSibling;
          if(unitEl) unitEl.textContent='';
        }else{
          dSpan.textContent = fmtDisp(p.offsetInfo?.offsetValue);
          dSpan.style.color='#2eff67';
        }
      }
      const mSpan = rightDetail.querySelector('#disp-move');
      if(mSpan){
        if(isErr){
          mSpan.textContent='错误';
          mSpan.style.color='#ff6b6b';
          const unitEl = mSpan.nextElementSibling;
          if(unitEl) unitEl.textContent='';
        }else{
          mSpan.textContent = fmtDisp(p.offsetInfo?.offsetValueDiff);
          mSpan.style.color = Number(p.offsetInfo?.offsetAlarmState)?'#ff6b6b':'#2eff67';
        }
      }
      const alarmBox = rightDetail.querySelector('#alarm-disp-val');
      if(alarmBox) alarmBox.textContent = (p.offsetInfo?.offsetValueAlarm??0).toFixed(3);

      // Gas (开状态才更新结构)
      const gasState = Number(p?.offsetInfo?.gasState);
      if(gasState===1){
        const g=p.gasInfo||{};
        const gas1 = rightDetail.querySelector('#gas1-val');
        if(gas1){
          const lType=Number(g.lGasType);
          const lValid=lType!==255 && lType!==-1 && lType!==undefined;
          if(lValid){
            const lAlarm=Number(g.lGasAlarmState)||0;
            const lAlarmTxt = lAlarm===2?' 低报':(lAlarm===3?' 高报':'');
            gas1.classList.toggle('offline',false);
            gas1.classList.toggle('alarm',!!lAlarm);
            gas1.innerHTML =
              `<span class="gas-num" style="color:${lAlarm?'#ff6b6b':'#2eff67'}">${fmtGas(g.lGasVal)}</span>`+
              `<span class="gas-unit" style="color:#e6f0ff;margin-left:4px;">${g.lGasUnit||''}</span>`+
              (lAlarmTxt?`<span class="gas-alarm" style="color:#ff6b6b;margin-left:6px;">${lAlarmTxt.trim()}</span>`:'');
          }else{
            gas1.textContent='离线';
            gas1.classList.add('offline');
            gas1.classList.remove('alarm');
            gas1.removeAttribute('data-act');
          }
        }
        const gas2 = rightDetail.querySelector('#gas2-val');
        if(gas2){
          const rType=Number(g.rGasType);
          const rValid=rType!==255 && rType!==-1 && rType!==undefined;
          if(rValid){
            const rAlarm=Number(g.rGasAlarmState)||0;
            const rAlarmTxt = rAlarm===2?' 低报':(rAlarm===3?' 高报':'');
            gas2.classList.toggle('offline',false);
            gas2.classList.toggle('alarm',!!rAlarm);
            gas2.innerHTML =
              `<span class="gas-num" style="color:${rAlarm?'#ff6b6b':'#2eff67'}">${fmtGas(g.rGasVal)}</span>`+
              `<span class="gas-unit" style="color:#e6f0ff;margin-left:4px;">${g.rGasUnit||''}</span>`+
              (rAlarmTxt?`<span class="gas-alarm" style="color:#ff6b6b;margin-left:6px;">${rAlarmTxt.trim()}</span>`:'');
          }else{
            gas2.textContent='离线';
            gas2.classList.add('offline');
            gas2.classList.remove('alarm');
            gas2.removeAttribute('data-act');
          }
        }
      }

      // GPS
      const gpsIcon = rightDetail.querySelector('#gps-icon');
      const gpsText = rightDetail.querySelector('#gps-text');
      if(gpsIcon){
        const sat=Number(p.offsetInfo?.gpsSatelliteCount)||0;
        if(sat<=0){
          gpsIcon.src='/res/gps_none.png';
          if(gpsText) gpsText.innerHTML='';
        }else{
          gpsIcon.src='/res/gps_ok.png';
          if(gpsText){
            gpsText.innerHTML = `${p.offsetInfo?.gpsLong},${p.offsetInfo?.gpsLat}<sup style="font-size:10px;margin-left:2px;">${sat}</sup>`;
          }
        }
      }
    }else{
      // 倾角
      const ax = rightDetail.querySelector('#ang-x'); if(ax) ax.textContent = fmtAngleFlex(p.angleInfo?.current_X)+'°';
      const ay = rightDetail.querySelector('#ang-y'); if(ay) ay.textContent = fmtAngleFlex(p.angleInfo?.current_Y)+'°';
      const az = rightDetail.querySelector('#ang-z'); if(az) az.textContent = fmtAngleFlex(p.angleInfo?.current_Z)+'°';
      const mv = rightDetail.querySelector('#angle-move');
      if(mv){
        const angleChange = Number(p.angleInfo?.angle_change)||0;
        const acAlarm = Number(p.angleInfo?.is_angle_alarm)!==0;
        mv.textContent = angleChange.toFixed(2)+'°';
        mv.style.color = acAlarm ? '#ff6b6b':'#2eff67';
      }
      const wave = rightDetail.querySelector('#vib-wave');
      if(wave){
        if(monOn){
          if(Number(p.angleInfo?.is_vibration_alarm)){
            wave.removeAttribute('data-vib-blink');
            wave.src='/res/wave_red.png';
          }else{
            wave.setAttribute('data-vib-blink','1');
            wave.src = window.__vibBlinkPhase ? '/res/wave_green.png':'/res/wave_yellow.png';
          }
        }else{
          wave.removeAttribute('data-vib-blink');
          wave.src='/res/wave_green.png';
        }
      }
      const modeTxt = rightDetail.querySelector('#vib-mode-text');
      if(modeTxt) modeTxt.textContent = '模式：'+(['低灵敏度','中灵敏度','高灵敏度'][Number(p.angleInfo?.vibration_mode)||0]);
      const ath = rightDetail.querySelector('#angle-threshold');
      if(ath && p.angleInfo?.angle_threshold!=null) ath.textContent = p.angleInfo.angle_threshold+'°';

      // 位移子模块（倾角页面里）
      const offState = Number(p.offsetInfo?.offsetState);
      const isErr = offState===1||offState===2||offState===5;
      const md = rightDetail.querySelector('#mod-disp-distance');
      if(md){
        if(isErr){
          md.textContent='错误';
          md.style.color='#ff6b6b';
          const unit = md.nextElementSibling;
          if(unit) unit.textContent='';
        }else{
          md.textContent = fmtDisp(p.offsetInfo?.offsetValue);
          md.style.color='#2eff67';
        }
      }
      const mmv = rightDetail.querySelector('#mod-disp-move');
      if(mmv){
        if(isErr){
          mmv.textContent='错误';
          mmv.style.color='#ff6b6b';
          const unit = mmv.nextElementSibling;
          if(unit) unit.textContent='';
        }else{
          mmv.textContent = fmtDisp(p.offsetInfo?.offsetValueDiff);
          mmv.style.color = Number(p.offsetInfo?.offsetAlarmState)?'#ff6b6b':'#2eff67';
        }
      }
      const mal = rightDetail.querySelector('#mod-disp-alarm'); if(mal) mal.textContent = (p.offsetInfo?.offsetValueAlarm??0).toFixed(3);

      // 气体（倾角）
      const gasState = Number(p?.offsetInfo?.gasState);
      if(gasState===1){
        const g=p.gasInfo||{};
        const gas1 = rightDetail.querySelector('#gas1-val');
        if(gas1){
          const lType=Number(g.lGasType);
          const lValid=lType!==255 && lType!==-1 && lType!==undefined;
          if(lValid){
            const lAlarm=Number(g.lGasAlarmState)||0;
            const lAlarmTxt = lAlarm===2?' 低报':(lAlarm===3?' 高报':'');
            gas1.classList.toggle('offline',false);
            gas1.classList.toggle('alarm',!!lAlarm);
            gas1.innerHTML =
              `<span class="gas-num" style="color:${lAlarm?'#ff6b6b':'#2eff67'}">${fmtGas(g.lGasVal)}</span>`+
              `<span class="gas-unit" style="color:#e6f0ff;margin-left:4px;">${g.lGasUnit||''}</span>`+
              (lAlarmTxt?`<span class="gas-alarm" style="color:#ff6b6b;margin-left:6px;">${lAlarmTxt.trim()}</span>`:'');
          }else{
            gas1.textContent='离线';
            gas1.classList.add('offline');
            gas1.classList.remove('alarm');
            gas1.removeAttribute('data-act');
          }
        }
        const gas2 = rightDetail.querySelector('#gas2-val');
        if(gas2){
          const rType=Number(g.rGasType);
          const rValid=rType!==255 && rType!==-1 && rType!==undefined;
          if(rValid){
            const rAlarm=Number(g.rGasAlarmState)||0;
            const rAlarmTxt = rAlarm===2?' 低报':(rAlarm===3?' 高报':'');
            gas2.classList.toggle('offline',false);
            gas2.classList.toggle('alarm',!!rAlarm);
            gas2.innerHTML =
              `<span class="gas-num" style="color:${rAlarm?'#ff6b6b':'#2eff67'}">${fmtGas(g.rGasVal)}</span>`+
              `<span class="gas-unit" style="color:#e6f0ff;margin-left:4px;">${g.rGasUnit||''}</span>`+
              (rAlarmTxt?`<span class="gas-alarm" style="color:#ff6b6b;margin-left:6px;">${rAlarmTxt.trim()}</span>`:'');
          }else{
            gas2.textContent='离线';
            gas2.classList.add('offline');
            gas2.classList.remove('alarm');
            gas2.removeAttribute('data-act');
          }
        }
      }

      // 气压颜色
      const air = rightDetail.querySelector('#air-pressure');
      if(air){
        const mode = Number(p.angleInfo?.air_pressure_mode);
        const airColor = mode===2 ? '#ff6b6b' : (mode===1 ? '#ffc800' : '#2eff67');
        air.style.color = airColor;
        air.textContent = p.angleInfo?.air_pressure ?? '--';
      }
      const h = rightDetail.querySelector('#height-val'); if(h) h.textContent = p.angleInfo?.height ?? '--';
    }
  }catch(e){
    ERR('updateDetailDynamic error',e);
  }
}

/* ---------- 弹窗辅助与安全创建 (原实现保持) ---------- */
function ensureModalStyles(){
  if(document.getElementById('__inline-modal-style')) return;
  const css = `
  .__inline-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:inherit;}
  .__inline-modal{background:#062028;border:1px solid #24aed8;border-radius:6px;min-width:360px;max-width:90%;color:#e6f0ff;box-shadow:0 0 0 1px #145b70,0 4px 16px rgba(0,0,0,.6);display:flex;flex-direction:column;}
  .__inline-modal-header{padding:14px 18px;font-weight:700;font-size:15px;border-bottom:1px solid #15586c;}
  .__inline-modal-body{padding:16px 18px;max-height:52vh;overflow:auto;font-size:13px;line-height:1.6;}
  .__inline-modal-footer{display:flex;justify-content:flex-end;gap:12px;padding:12px 18px;border-top:1px solid #15586c;}
  .__inline-modal-footer button{min-width:72px;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600;border:1px solid #24aed8;background:#0b2831;color:#e6f0ff;}
  .__inline-modal-footer button.primary{background:#1aa3c9;}
  .__inline-modal-footer button.primary:active{filter:brightness(.9);}
  .__inline-modal-footer button:active{filter:brightness(.85);}
  .__inline-modal input{background:#08161d;border:1px solid #2a5c70;border-radius:4px;color:#e6f0ff;padding:6px 10px;font-size:13px;width:100%;outline:none;}
  .__inline-modal input:focus{border-color:#27bff0;}
  `;
  const style = document.createElement('style');
  style.id='__inline-modal-style';
  style.textContent = css;
  document.head.appendChild(style);
  LOG('ensureModalStyles injected');
}

/* ========== safeCreateModal (原增强版) ========== */
const __modalCallStamp = {};
function elevateExternalModal(id, dbg){
  try{
    let root = document.getElementById(id);
    if(!root){
      root = document.querySelector(`[id*="${id}"]`);
    }
    if(!root) return false;
    const style = window.getComputedStyle(root);
    const alreadyFixed = style.position === 'fixed';

    if(!root.__elevated){
      const wrapper = document.createElement('div');
      wrapper.className='__ext-modal-wrapper';
      wrapper.style.cssText=`
        position:fixed;inset:0;z-index:100000;display:flex;
        align-items:center;justify-content:center;
        pointer-events:auto;
      `;
      const mask=document.createElement('div');
      mask.className='__ext-modal-mask';
      mask.style.cssText=`
        position:absolute;inset:0;background:rgba(0,0,0,.55);
      `;
      wrapper.appendChild(mask);
      if(!alreadyFixed){
        root.style.position='relative';
        root.style.zIndex='100001';
      }else{
        root.style.zIndex='100001';
      }
      wrapper.appendChild(root);
      document.body.appendChild(wrapper);
      root.__elevated = true;
      mask.addEventListener('click',()=>{ try{ wrapper.remove(); }catch{} });
      if(dbg) LOG('elevateExternalModal applied', {id, alreadyFixed});
    }
    return true;
  }catch(err){
    if(dbg) ERR('elevateExternalModal error',err);
    return false;
  }
}
function safeCreateModal(opt){
  ensureModalStyles();
  const dbg = !!window.__DETAIL_DEBUG_MODAL;
  const forceFallback = !!window.__DETAIL_FORCE_FALLBACK;
  const id = opt.id || ('safeModal_'+Date.now());
  if(__modalCallStamp[id] && Date.now() - __modalCallStamp[id] < 120){
    if(dbg) LOG('safeCreateModal skip duplicate <120ms id=',id);
    return { body: document.createElement('div'), close:()=>{} };
  }
  __modalCallStamp[id] = Date.now();
  const oldMask=document.getElementById(id+'_mask');
  if(oldMask){ try{ oldMask.remove(); }catch{} }
  let externalInst=null;
  let usedExternal=false;
  if(!forceFallback && typeof createModal==='function'){
    try{
      externalInst = createModal(opt);
      if(externalInst && externalInst.body){
        usedExternal=true;
        if(dbg) LOG('safeCreateModal external created',id);
        try{
          if(typeof externalInst.open==='function') externalInst.open();
          else if(typeof externalInst.show==='function') externalInst.show();
        }catch(e){ if(dbg) WARN('safeCreateModal external open/show error',e); }
      }else{
        if(dbg) WARN('safeCreateModal external returned invalid, fallback');
      }
    }catch(e){
      if(dbg) ERR('safeCreateModal external error',e);
      usedExternal=false;
    }
  }
  if(usedExternal){
    elevateExternalModal(id, dbg);
    const checkVisible=(delay, final)=>{
      setTimeout(()=>{
        try{
          const root = document.getElementById(id) || document.querySelector(`[id*="${id}"]`);
            if(!root){
              if(dbg) WARN(`safeCreateModal external root missing at ${delay}ms -> fallback`);
              if(final) return buildFallback();
              return;
            }
          const rect = root.getBoundingClientRect();
          const style = getComputedStyle(root);
          const hidden = rect.width===0 || rect.height===0 || style.display==='none' || style.visibility==='hidden';
          if(dbg) LOG(`safeCreateModal external rect(${delay}ms)`,id,rect,'hidden=',hidden);
          if(hidden && final){
            if(dbg) WARN('safeCreateModal external still hidden -> fallback');
            buildFallback();
          }
        }catch(err){
          if(dbg) ERR('safeCreateModal visibility check error',err);
          if(final) buildFallback();
        }
      }, delay);
    };
    checkVisible(60,false);
    checkVisible(100,true);
    return externalInst;
  }
  return buildFallback();
  function buildFallback(){
    const mask=document.createElement('div');
    mask.className='__inline-modal-mask';
    mask.id=id+'_mask';
    const box=document.createElement('div');
    box.className='__inline-modal';
    if(opt.width) box.style.width = (typeof opt.width==='number'?opt.width+'px':opt.width);
    box.innerHTML=`
      <div class="__inline-modal-header">${opt.title||''}</div>
      <div class="__inline-modal-body" id="${id}_body">${opt.content||''}</div>
      <div class="__inline-modal-footer" id="${id}_footer"></div>
    `;
    mask.appendChild(box);
    document.body.appendChild(mask);
    function close(ret){
      try{ mask.remove(); }catch{}
      if(dbg) LOG('fallback modal close',id,'ret=',ret);
    }
    const footer = box.querySelector('#'+id+'_footer');
    (opt.footerButtons||[]).forEach(f=>{
      const b=document.createElement('button');
      b.textContent=f.text||'按钮';
      if(f.primary) b.classList.add('primary');
      b.onclick=()=>f.onClick && f.onClick(close);
      footer.appendChild(b);
    });
    if(dbg) LOG('fallback modal created',id);
    return { body: box.querySelector('#'+id+'_body'), close };
  }
}
/* -------- toastSafe -------- */
function toastSafe(type, message){
  try{
    if(window.parent && window.parent!==window){
      if(window.parent.__toast && typeof window.parent.__toast.show==='function'){
        window.parent.__toast.show({ type, message });
        return;
      }
      if(typeof window.parent.parentToast === 'function'){
        window.parent.parentToast({ type, message });
        return;
      }
    }
  }catch(e){}
  try{
    if(typeof showToast === 'function'){
      showToast({type, message});
      return;
    }
  }catch(e){}
  try{
    console.warn('[toastSafe fallback]', type, message);
    alert(message);
  }catch(e){}
}

/* ========= openMoveAlarmModal ========= */
function openMoveAlarmModal(p){
  if(!p){ p=getSelectedProbe(); }
  if(!p){ console.warn('[openMoveAlarmModal] no probe'); return; }
  if(window.__modalLastActTime && Date.now()-window.__modalLastActTime<90){
    if(window.__DETAIL_DEBUG_MODAL) LOG('[moveAlarm] skip duplicate open');
    return;
  }
  window.__modalLastActTime = Date.now();
  const min = Number(p.offsetInfo?.offsetMin);
  const max = Number(p.offsetInfo?.offsetMax);
  const rangeTxt = (Number.isFinite(min)&&Number.isFinite(max)) ? `(${fmtDisp(min)}~${fmtDisp(max)}m)` : '';
  const initVal = (p.offsetInfo?.offsetValueAlarm??0).toFixed(3);
  const token   = 'mv_'+Date.now().toString(36)+Math.random().toString(16).slice(2);
  const dbg = !!window.__DETAIL_DEBUG_MODAL;
  if(dbg) LOG('[moveAlarm] open',{probeId:p.probeId,initVal,token, min,max});
  const modal = safeCreateModal({
    id:'moveAlarmModal',
    title:`设置位移报警值${rangeTxt}`,
    width:420,
    content:`
      <div style="padding:6px 4px;line-height:1.6;">
        <div>请输入新的位移报警值 (m)，范围 ${rangeTxt||'依设备'}，三位小数。</div>
        <input id="mvAlarmInput" data-token="${token}" data-role="move" placeholder="${initVal}" value="${initVal}" />
        <div id="mvAlarmErr" style="color:#ff6b6b;font-size:12px;min-height:18px;margin-top:4px;"></div>
      </div>
    `,
    footerButtons:[
      { text:'取消', onClick:c=>c(false) },
      { text:'确定', primary:true, onClick:(close)=>{
          const errEl = document.getElementById('mvAlarmErr') || modal.body.querySelector('#mvAlarmErr');
          const showErr = msg => { if(errEl) errEl.textContent=msg; toastSafe('error', msg); };
          try{
            document.activeElement && document.activeElement.blur();
            const all = Array.from(document.querySelectorAll(`input[data-token="${token}"]`));
            const visible = all.filter(el=>{
              const cs=getComputedStyle(el);const r=el.getBoundingClientRect();
              return cs.display!=='none' && cs.visibility!=='hidden' && r.width>0 && r.height>0 && el.offsetParent!==null;
            });
            let inp = visible.length? visible[visible.length-1]: all[all.length-1];
            if(!inp) inp = modal.body.querySelector(`#mvAlarmInput[data-token="${token}"]`);
            if(dbg) LOG('[moveAlarm] confirm candidates',{token,total:all.length,visible:visible.length,val:inp && inp.value});
            if(!inp){ showErr('未找到输入框'); return; }
            let raw = (inp.value||'').trim();
            if(raw===''){ showErr('请输入数值'); return; }
            if(!/^\d+(\.\d{1,3})?$/.test(raw)){ showErr('格式错误(<=3位小数)'); return; }
            let num = Number(raw);
            if(!Number.isFinite(num)){ showErr('数值无效'); return; }
            if(Number.isFinite(min)&&num<min){ showErr(`值不能小于${fmtDisp(min)}`); return; }
            if(Number.isFinite(max)&&num>max){ showErr(`值不能大于${fmtDisp(max)}`); return; }
            if(num<=0){ showErr('必须大于0'); return; }
            const finalVal=Number(num.toFixed(3));
            const idNum=getDevIdNum(); if(idNum==null){ showErr('设备ID无效'); return; }
            close(true);
            toastSafe('info','正在发送...');
            if(dbg) LOG('[moveAlarm] send',{finalVal});
            androidWsApi.setMoveAlarmVal({
              toId:idNum, model:PAGE_MODEL, operation:0,
              alarmVal:finalVal, probeId:String(p.probeId)
            }).then(()=>{
              toastSafe('success','设置成功');
              forceFetch();
            }).catch(err=>{
              console.error('[moveAlarm] send error',err);
              toastSafe('error','发送失败');
            });
          }catch(ex){
            console.error('[moveAlarm] exception',ex);
            showErr('内部错误');
          }
        } }
    ]
  });
}

/* ========= openGasModal ========= */
function openGasModal(p, gasSeq){
  if(!p){ p=getSelectedProbe(); }
  if(!p){ console.warn('[openGasModal] no probe'); return; }
  if(gasSeq!==0 && gasSeq!==1) gasSeq=0;
  if(window.__modalLastActTime && Date.now()-window.__modalLastActTime<90){
    if(window.__DETAIL_DEBUG_MODAL) LOG('[gasAlarm] skip duplicate open');
    return;
  }
  window.__modalLastActTime = Date.now();
  const gasInfo = p.gasInfo||{};
  const prefix  = gasSeq===0 ? 'lGas' : 'rGas';
  const lowMin  = gasInfo[`${prefix}LowMin`];
  const lowMax  = gasInfo[`${prefix}LowMax`];
  const highMin = gasInfo[`${prefix}HighMin`];
  const highMax = gasInfo[`${prefix}HighMax`];
  const curLow  = gasInfo[`${prefix}Low`];
  const curHigh = gasInfo[`${prefix}High`];
  const gasName = gasSeq===0 ? (gasInfo.lGasUnitName||'气体1') : (gasInfo.rGasUnitName||'气体2');
  const token   = 'gas_'+gasSeq+'_'+Date.now().toString(36)+Math.random().toString(16).slice(2);
  const dbg = !!window.__DETAIL_DEBUG_MODAL;
  if(dbg) LOG('[gasAlarm] open',{probeId:p.probeId,gasSeq,token,curLow,curHigh,range:{lowMin,lowMax,highMin,highMax}});
  const modal = safeCreateModal({
    id:'gasAlarmModal_'+gasSeq,
    title:`设置${gasName}(高、低报警值)`,
    width:480,
    content:`
      <div style="padding:8px 4px;line-height:1.6;">
        <div>高报范围: (${highMin}~${highMax})  低报范围: (${lowMin}~${lowMax})</div>
        <div style="margin-top:6px;display:grid;grid-template-columns:80px 1fr;row-gap:10px;column-gap:8px;align-items:center;">
          <label>高报值:</label>
          <input id="gasHighInp" data-token="${token}" data-role="high" placeholder="${curHigh??''}" value="${curHigh??''}">
          <label>低报值:</label>
          <input id="gasLowInp"  data-token="${token}" data-role="low"  placeholder="${curLow??''}"  value="${curLow??''}">
        </div>
        <div id="gasErr" style="color:#ff6b6b;font-size:12px;min-height:18px;margin-top:6px;"></div>
      </div>
    `,
    footerButtons:[
      { text:'取消', onClick:c=>c(false) },
      { text:'确定', primary:true, onClick:(close)=>{
          const errEl=document.getElementById('gasErr')||modal.body.querySelector('#gasErr');
          const showErr = msg => { if(errEl) errEl.textContent=msg; toastSafe('error',msg); if(dbg) LOG('[gasAlarm] ERROR',msg); };
          try{
            document.activeElement && document.activeElement.blur();
            const all = Array.from(document.querySelectorAll(`input[data-token="${token}"]`));
            const visible = all.filter(el=>{
              const cs=getComputedStyle(el);const r=el.getBoundingClientRect();
              return cs.display!=='none' && cs.visibility!=='hidden' && r.width>0 && r.height>0 && el.offsetParent!==null;
            });
            const pick=role=>{
              let a=visible.filter(el=>el.getAttribute('data-role')===role);
              if(!a.length) a=all.filter(el=>el.getAttribute('data-role')===role);
              return a[a.length-1];
            };
            let highInput = pick('high');
            let lowInput  = pick('low');
            if(!highInput) highInput = modal.body.querySelector(`#gasHighInp[data-token="${token}"]`);
            if(!lowInput)  lowInput  = modal.body.querySelector(`#gasLowInp[data-token="${token}"]`);
            if(dbg) LOG('[gasAlarm] step2 chosen',{
              token,total:all.length,visible:visible.length,
              highVal: highInput && highInput.value,
              lowVal:  lowInput && lowInput.value
            });
            if(!highInput || !lowInput) return showErr('未找到输入框');
            let highRaw=(highInput.value||'').trim();
            let lowRaw =(lowInput.value||'').trim();
            if(highRaw===''||lowRaw===''){ showErr('请输入数值'); return; }
            if(!/^\d+(\.\d)?$/.test(highRaw) || !/^\d+(\.\d)?$/.test(lowRaw)){ showErr('格式错误(一位小数)'); return; }
            let highV=Number(highRaw), lowV=Number(lowRaw);
            if(!Number.isFinite(highV)||!Number.isFinite(lowV)){ showErr('数值无效'); return; }
            highV=Number(highV.toFixed(1)); lowV=Number(lowV.toFixed(1));
            if(lowV>=highV){ showErr('低报必须小于高报'); return; }
            if(lowMin!=null && lowV<lowMin){ showErr(`低报≥${lowMin}`); return; }
            if(lowMax!=null && lowV>lowMax){ showErr(`低报≤${lowMax}`); return; }
            if(highMin!=null && highV<highMin){ showErr(`高报≥${highMin}`); return; }
            if(highMax!=null && highV>highMax){ showErr(`高报≤${highMax}`); return; }
            const idNum=getDevIdNum(); if(idNum==null){ showErr('设备ID无效'); return; }
            close(true);
            toastSafe('info','正在发送...');
            if(dbg) LOG('[gasAlarm] step3 send',{gasSeq,highReportedVal:highV,lowReportedVal:lowV});
            androidWsApi.setGasAlarmP({
              toId:idNum,
              model:PAGE_MODEL,
              gasSequence:gasSeq,
              probeId:String(p.probeId),
              highReportedVal:highV,
              lowReportedVal:lowV
            }).then(()=>{
              toastSafe('success','设置成功');
              forceFetch();
            }).catch(err=>{
              console.error('[gasAlarm] send error',err);
              toastSafe('error','发送失败');
            });
          }catch(ex){
            console.error('[gasAlarm] exception',ex);
            showErr('内部错误');
          }
        } }
    ]
  });
}

/* ---------- 统一动作处理 ---------- */
function onDetailAction(e){
  const actEl = e && e.currentTarget;
  if(!actEl) return;
  const act = actEl.getAttribute('data-act');
  if(window.__DETAIL_DEBUG_CLICK) LOG('onDetailAction act=',act);
  let p = getSelectedProbe();
  if(!p){ WARN('onDetailAction no probe'); return; }
  const idNum=getDevIdNum(); if(idNum==null){ WARN('onDetailAction no devId'); return; }

  if(act==='angle-th-dec' || act==='angle-th-inc'){
    androidWsApi.setAngleAlarmVal({ toId:idNum, model:PAGE_MODEL, operation:act.endsWith('dec')?1:2, probeId:String(p.probeId)}).finally(forceFetch);
  }else if(act==='disp-th-dec' || act==='disp-th-inc'){
    androidWsApi.setMoveAlarmVal({ toId:idNum, model:PAGE_MODEL, operation:act.endsWith('dec')?1:2, probeId:String(p.probeId)}).finally(forceFetch);
  }else if(act==='disp-th-set'){
    openMoveAlarmModal(p);
  }else if(act==='vibration-mode'){
    const cur = Number(p.angleInfo?.vibration_mode)||0;
    const next = (cur+1)%3;
    androidWsApi.setVibrationAL({ toId:idNum, model:PAGE_MODEL, alarmLevel:next, probeId:String(p.probeId)}).finally(forceFetch);
  }else if(act==='gas-edit-left'){
    openGasModal(p,0);
  }else if(act==='gas-edit-right'){
    openGasModal(p,1);
  }else if(act==='toggle-number'){
    const on = Number(p.numberState)===1;
    androidWsApi.controlDip({ toId:idNum, operation:on?0:1, commandType:3, probeId:[p.probeId], timestamp:Math.floor(Date.now()/1000)}).finally(forceFetch);
  }else if(act==='toggle-find'){
    // 统一报警/红色状态判定
    const isAlarmOn = [
      p?.offsetInfo?.offsetAlarmState,
      p?.offsetInfo?.findState,
      p?.offsetInfo?.lGasAlarmState,
      p?.offsetInfo?.rGasAlarmState,
      p?.angleInfo?.is_vibration_alarm,
      p?.angleInfo?.is_angle_alarm
    ].some(v=>Number(v));
    androidWsApi.controlDip({
      toId:idNum,
      operation:isAlarmOn?0:1,
      commandType:4,
      probeId:[p.probeId],
      timestamp:Math.floor(Date.now()/1000)
    }).finally(forceFetch);
  }else if(act==='toggle-monitor'){
    const isMon = Number(p?.offsetInfo?.offsetMoniterState)===1 || Number(p?.angleInfo?.moniterState)===1;
    androidWsApi.controlDip({ toId:idNum, operation:isMon?0:1, commandType:5, probeId:[p.probeId], timestamp:Math.floor(Date.now()/1000)}).finally(forceFetch);
  }
}

/* ---------- WS 订阅 ---------- */
await waitDevId();
const idNum = getDevIdNum();
let offList=null;
if(idNum!=null){
  offList = androidWsApi.onByDev(AndroidTopics.DipTwoChannelResponse, idNum, msg=>{
    if(window.__DETAIL_DEBUG_WS) LOG('WS dipTwoChannelResponse raw',msg);
    if(msg && msg.code===0 && Array.isArray(msg.data)){
      modePoller.markSuccess('dipTwoChannel', idNum, msg.requestId);
      const oldSelected = selectedProbeId;
      probes=msg.data;
      if(!selectedProbeId || !probes.some(p=>String(p.probeId)===String(selectedProbeId))){
        selectedProbeId = probes[0]?.probeId || null;
      }
      const changed = String(oldSelected)!==String(selectedProbeId);
      exposeState();
      renderList();
      if(changed){
        renderDetail(true);
      } else {
        updateDetailDynamic(getSelectedProbe());
      }
      hideSpinner();
      hideRefresh();
    }
  });
  forceFetch();
}

modePoller.on('suspend', ({ cmd, devId:d })=>{
  if(cmd==='dipTwoChannel' && String(d)===String(idNum)){
    suspended=true;
    showRefresh();
    try { window.eventBus?.emit('toast:show', { type:'warn', message:`${FAIL_TOAST_PREFIX}${getDevId()}` }); } catch {}
  }
});
modePoller.on('resume', ({ cmd, devId:d })=>{
  if(cmd==='dipTwoChannel' && String(d)===String(idNum)){
    suspended=false;
    hideRefresh();
    showSpinner();
  }
});

/* ---------- 委托 ---------- */
function ensureDetailDelegation(){
  if(window.__detailDelegationReady) return;
  rightDetail.addEventListener('click', evt=>{
    const el = evt.target.closest('[data-act]');
    if(!el) return;
    if(window.__DETAIL_DEBUG_CLICK) LOG('[delegate click]', el.getAttribute('data-act'), el.id);
    onDetailAction({ currentTarget: el });
  });
  window.__detailDelegationReady=true;
  LOG('ensureDetailDelegation attached');
}
ensureDetailDelegation();

/* 事件暴露（调试用） */
function exposeDetailFns(){
  window.onDetailAction=onDetailAction;
  window.openGasModal=openGasModal;
  window.openMoveAlarmModal=openMoveAlarmModal;
  window.getSelectedProbe=getSelectedProbe;
  exposeState();
  LOG('exposeDetailFns done');
}
exposeDetailFns();

/* 顶栏拍照/录像/对讲逻辑已统一，移除原实现 */

// 建立用于对讲的 ws 渠道
if(idNum!=null){
  const wsCh = await bridge.wsOpen({ kind:'mode-disp-tilt', devId: idNum });
  topbarHelper.updateWsChannel(wsCh);
}

window.addEventListener('beforeunload', ()=>{ try{ offList && offList(); }catch{} LOG('beforeunload cleanup'); });

LOG('script end init complete');
/**
 * 通用推流缩略图管理 (v2.3 + ready-attr)
 *  - 首帧出现：container.setAttribute('data-thumb-ready','1')
 *  - 重新 run / 失败：移除 data-thumb-ready
 *  - 页面可用 container.hasAttribute('data-thumb-ready') 或 preview.hasFirstFrame 判断是否可进入详情
 */
import { androidWsApi } from '@api/androidWSApi.js';

const DEFAULT_WS_TIMEOUT = () => (window.VIDEO_WS_RESPONSE_TIMEOUT_MS || 3000);
const DEFAULT_FF_TIMEOUT = () => (window.VIDEO_FIRST_FRAME_TIMEOUT_MS || 5000);

function getGlobalStore() {
  try {
    if (window.top && window.top !== window) {
      if (!window.top.__GLOBAL_STREAM_RC__) window.top.__GLOBAL_STREAM_RC__ = {};
      return window.top.__GLOBAL_STREAM_RC__;
    }
  } catch {}
  if (!window.__GLOBAL_STREAM_RC__) window.__GLOBAL_STREAM_RC__ = {};
  return window.__GLOBAL_STREAM_RC__;
}
function key(devId, ht, hi){ return devId + ':' + ht + ':' + hi; }

/* ===== 替换：ensureStream（去掉前端引用计数与复用，始终主动 start） ===== */
async function ensureStream({ devId, hardwareType, hardwareIndex, forceStart = false, wsTimeoutMs }) {
  const toMs = wsTimeoutMs || DEFAULT_WS_TIMEOUT();
  const t0 = performance.now();
  const timeoutId = setTimeout(()=>{ throw new Error('timeout'); }, toMs);
  try {
    const resp = await androidWsApi.pushStream({
      toId: devId,
      startFlag: true,
      hardwareType,
      hardwareIndex
    });
    clearTimeout(timeoutId);
    const t1 = performance.now();
    console.log('[Thumb][pushStream][simple] ms=', (t1-t0).toFixed(1), 'devId=',devId,'ht=',hardwareType,'hi=',hardwareIndex);
    if (!resp || resp.code !== 0 || !resp.data?.streamURI) {
      throw new Error(resp?.msg || 'pushStream fail');
    }
    const rawURI = (resp.data.streamURI || '').trim();
    if(!rawURI || /^webrtc:\/\/?$/.test(rawURI)){
      throw new Error('invalid streamURI');
    }
    return { streamURI: rawURI, reused:false };
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

function requestLowAfterFirstFrame(devId, hardwareType, hardwareIndex, streamURI){
  if (hardwareType !== 1) return;
  const store = getGlobalStore();
  const k = key(devId, hardwareType, hardwareIndex);
  const e = store[k];
  if(!e || !e.streamURI || e.lowHandled) return;
  androidWsApi.pushStreamResolution({ toId:devId, streamURI, quality:'low' })
    .then(()=>{ e.lowHandled = true; console.log('[Thumb] pushStreamResolution(low) after firstFrame ok'); })
    .catch(err=>{ console.warn('[Thumb] pushStreamResolution(low) after firstFrame fail', err); });
}

function requestHighQuality(devId, hardwareType, hardwareIndex){
  const store = getGlobalStore();
  const e = store[key(devId, hardwareType, hardwareIndex)];
  if (!e || !e.streamURI) return;
  if (hardwareType!==1) return;
  androidWsApi.pushStreamResolution({ toId:devId, streamURI:e.streamURI, quality:'high' }).catch(()=>{});
}

/**
 * 修改：新增 opt.skipStop, 发生“无画面超时 / 接口超时 / 失败 / 播放失败”等原因导致的失败时，不发送 stop
 */
/* ===== 替换：releaseStreamReference（始终发送 stopFlag:false，不做引用计数） ===== */
function releaseStreamReference(devId, hardwareType, hardwareIndex, opt){
  // try {
  //   androidWsApi.pushStream({
  //     toId: devId,
  //     startFlag: false,
  //     hardwareType,
  //     hardwareIndex
  //   }).catch(()=>{});
  // } catch {}
}

function showToast(type, message){
  const evtBus = (window && window.eventBus);
  if (evtBus && typeof evtBus.emit === 'function') { try { evtBus.emit('toast:show', { type, message }); return; } catch {} }
  try {
    if (window.parent && window.parent !== window) { window.parent.postMessage({ __thumbToast:true, type, message }, '*'); return; }
  } catch {}
  console.info('[Thumb][Toast]', type, message);
}
function ensureContainerRelative(container){
  try { if (getComputedStyle(container).position === 'static') container.style.position='relative'; } catch {}
}
function makeLoading(container){
  ensureContainerRelative(container);
  if (container.querySelector('[data-thumb-loading]')) return;
  const ld=document.createElement('div');
  ld.setAttribute('data-thumb-loading','');
  ld.style.cssText='position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:34px;height:34px;'
    +'border:4px solid rgba(158,195,255,.25);border-top-color:#9ec3ff;border-radius:50%;animation:thumbSpin .9s linear infinite;z-index:25;pointer-events:none;';
  const style=document.createElement('style'); style.textContent='@keyframes thumbSpin{to{transform:translate(-50%,-50%) rotate(360deg);}}';
  ld.appendChild(style); container.appendChild(ld);
}
function removeLoading(container){
  const ld=container.querySelector('[data-thumb-loading]'); if(ld) try{ ld.remove(); }catch{}
}

let __GLOBAL_RUN_COUNTER = 0;

export function createStreamThumbnail({
  container,
  devId,
  hardwareType,
  hardwareIndex,
  createPreview,
  wantLow = true,
  wsTimeoutMs,
  firstFrameTimeoutMs = (window.VIDEO_FIRST_FRAME_TIMEOUT_MS || 5000),
  toast = true,
  toastPrefix = ''
}) {
  if (!container) throw new Error('container missing');
  if (typeof devId !== 'number' || !Number.isFinite(devId)) throw new Error('invalid devId');

  // 预览组件
  const preview = createPreview ? createPreview() : null;
  if (preview) {
    container.innerHTML = '';
    container.appendChild(preview);
  }
  container.removeAttribute('data-thumb-ready');

  let started = false;
  let stopped = false;
  let hasFirstFrame = false;
  let ffTimer = null;

  function showToast(type, message){
    try {
      const bus = window.eventBus;
      if (bus && typeof bus.emit === 'function') {
        bus.emit('toast:show', { type, message });
        return;
      }
    } catch {}
    console.info('[Thumb][Toast]', type, message);
  }

  function cleanupFFTimer(){ if(ffTimer){ clearTimeout(ffTimer); ffTimer=null; } }

  function markFirstFrame(){
    if (hasFirstFrame) return;
    hasFirstFrame = true;
    cleanupFFTimer();
    container.setAttribute('data-thumb-ready','1');
  }

  if (preview) {
    preview.onFirstFrame = () => markFirstFrame();
  }

  // 开流 (startFlag:true)
  (async () => {
    try {
      const toMs = wsTimeoutMs || (window.VIDEO_WS_RESPONSE_TIMEOUT_MS || 3000);
      const timeoutId = setTimeout(()=>{ throw new Error('timeout'); }, toMs);
      const resp = await androidWsApi.pushStream({
        toId: devId,
        startFlag: true,
        hardwareType,
        hardwareIndex
      });
      clearTimeout(timeoutId);
      if(!resp || resp.code!==0 || !resp.data?.streamURI){
        throw new Error(resp?.msg || 'pushStream fail');
      }
      const uri = (resp.data.streamURI||'').trim();
      if(!uri || /^webrtc:\/\/?$/.test(uri)){
        throw new Error('invalid streamURI');
      }
      started = true;

      // 播放
      if(preview && preview.play){
        try {
          await preview.play(uri);
        } catch(e){
          throw new Error('play-error');
        }
      }

      // 首帧超时监控
      ffTimer = setTimeout(()=>{
        if(!hasFirstFrame){
          if(toast) showToast('error', (toastPrefix||'') + '首帧超时');
          destroy(); // 自动关闭
        }
      }, firstFrameTimeoutMs);

      // 首帧后降码率（仅摄像机）
      if (wantLow && hardwareType === 1) {
        try { androidWsApi.pushStreamResolution({ toId:devId, streamURI:uri, quality:'low' }).catch(()=>{}); } catch {}
      }
    } catch (e){
      if(toast) {
        const msg = e && e.message==='timeout' ? '推流超时' :
                    e && e.message==='play-error' ? '播放失败' :
                    '推流失败';
        showToast('error', (toastPrefix||'') + msg);
      }
      destroy(); // 确保关闭（若已 start 会在 destroy 内 stop）
    }
  })();

  function destroy(){
    cleanupFFTimer();
    // 仅在“成功 start 但尚未 stop”时发送 stop
    if(started && !stopped){
      stopped = true;
      try {
        androidWsApi.pushStream({
          toId: devId,
          startFlag: false,
          hardwareType,
          hardwareIndex
        }).catch(()=>{});
      } catch {}
    }
    try {
      if (preview && preview.destroy) preview.destroy();
    } catch {}
  }

  return {
    preview,
    destroy,
    requestHigh(){ /* 详情页进入时再单独升码率，这里不做 */ }
  };
}

export {
  ensureStream,
  requestHighQuality,
  releaseStreamReference
};
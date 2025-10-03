/**
 * 视频预览（模板+SRS播放）
 * 功能：
 *  - host.onFirstFrame 回调（首帧出现时触发一次）
 *  - host.hasFirstFrame 标记
 *  - play(url): 重新开始播放（会关闭旧 sdk）
 *  - stop(): 仅停止当前流 (可再次 play)
 *  - destroy(): 完全销毁
 *  - 首帧/播放耗时日志
 *  - 增加 video 'loadeddata' & 'resize'(监听 video 元素的尺寸变更) 检测，防止渲染循环丢帧导致首帧不触发
 */
import { importTemplate } from '@ui/templateLoader.js';

let __videoTplFailOnce = false;

export function createVideoPreview({ objectFit = 'fill' } = {}) {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });

  let canvas = null;
  let ctx = null;
  let sdk = null, video = null, loop = false, rotation = 0;
  let mode = objectFit==='fit'?'fit':'fill';
  let firstFrameLogged = false;
  let tPlayStart = 0;
  host.hasFirstFrame = false;
  host.onFirstFrame = null;

  function log(...a){ try{ console.info('[VideoPreview]', ...a);}catch{} }
  function warn(...a){ try{ console.warn('[VideoPreview]', ...a);}catch{} }
  function errorOnce(tag, err){
    if(!__videoTplFailOnce){
      console.error('[VideoPreview]', tag, err);
      __videoTplFailOnce = true;
    } else {
      warn(tag + ' (silenced repeat)');
    }
  }

  function buildFallback(){
    try {
      const wrap = document.createElement('div');
      wrap.style.cssText='position:relative;width:100%;height:100%;background:#111;color:#888;font:12px/1.4 sans-serif;display:flex;align-items:center;justify-content:center;';
      wrap.innerHTML = '<span style="opacity:.7;">预览模板缺失 (fallback)</span>';
      canvas = document.createElement('canvas');
      canvas.id='vpCanvas';
      canvas.style.cssText='position:absolute;left:0;top:0;width:100%;height:100%;';
      wrap.appendChild(canvas);
      root.appendChild(wrap);
      ctx = canvas.getContext('2d', { willReadFrequently:true });
      ro.observe(canvas);
    } catch(e){
      console.error('[VideoPreview] fallback build failed', e);
    }
  }

  const tplReady = importTemplate('/modules/features/pages/modes/video-preview.html', 'tpl-video-preview')
    .then(frag => {
      root.appendChild(frag);
      canvas = root.getElementById('vpCanvas');
      if(!canvas){
        errorOnce('template missing #vpCanvas, use fallback', '');
        buildFallback();
      } else {
        ctx = canvas.getContext('2d', { willReadFrequently: true });
        ro.observe(canvas);
      }
    })
    .catch(err => {
      errorOnce('template load failed', err);
      buildFallback();
    });

  const ro = new ResizeObserver(()=>{
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio||1, 2);
    const w = Math.max(1, Math.floor(r.width*dpr));
    const h = Math.max(1, Math.floor(r.height*dpr));
    if (canvas.width!==w || canvas.height!==h){ canvas.width=w; canvas.height=h; }
  });

  function triggerFirstFrameIfReady(tag){
    if(firstFrameLogged) return;
    if(!video) return;
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    if(vw && vh){
      firstFrameLogged = true;
      host.hasFirstFrame = true;
      const dtFirst = performance.now()-tPlayStart;
      log('first frame', vw+'x'+vh, 'after', dtFirst.toFixed(1)+'ms', 'via', tag);
      try { if (typeof host.onFirstFrame === 'function') host.onFirstFrame({ width:vw, height:vh, elapsed:dtFirst }); } catch {}
    }
  }

  function render(){
    if(!loop || !canvas || !ctx) return;
    const rect=canvas.getBoundingClientRect(), w=rect.width||1, h=rect.height||1;
    const vw=video?.videoWidth||0, vh=video?.videoHeight||0;
    ctx.save(); ctx.clearRect(0,0,canvas.width,canvas.height);
    if(vw && vh){
      triggerFirstFrameIfReady('render');
      ctx.translate(canvas.width/2, canvas.height/2);
      ctx.rotate(rotation*Math.PI/180);
      let videoW=vw, videoH=vh; if(rotation%180!==0) [videoW,videoH]=[videoH,videoW];
      let drawW=w, drawH=h;
      if(mode==='fit'){ const vr=videoW/videoH, cr=w/h; if(vr>cr){ drawW=w; drawH=w/vr; } else { drawH=h; drawW=h*vr; } }
      else { drawW=w; drawH=h; }
      const sx=canvas.width/w, sy=canvas.height/h;
      if(rotation%180===0){ ctx.drawImage(video, -drawW/2*sx, -drawH/2*sy, drawW*sx, drawH*sy); }
      else { ctx.drawImage(video, -drawH/2*sx, -drawW/2*sy, drawH*sx, drawW*sy); }
    }
    ctx.restore(); requestAnimationFrame(render);
  }

  async function ensureDeps(){
    if(!window.adapter) await new Promise(r=>{ const s=document.createElement('script'); s.src='/js/adapter-7.4.0.min.js'; s.onload=r; s.onerror=r; document.head.appendChild(s); });
    if(!window.SrsRtcPlayerAsync) await new Promise((resolve,reject)=>{ const s=document.createElement('script'); s.src='/js/srs.sdk.js'; s.onload=resolve; s.onerror=()=>{ const s2=document.createElement('script'); s2.src='https://ossrs.net/srs.sdk.js'; s2.onload=resolve; s2.onerror=reject; document.head.appendChild(s2); }; document.head.appendChild(s); });
  }

  async function play(url){
    await tplReady;
    log('play begin', url);
    tPlayStart = performance.now();
    host.hasFirstFrame = false;
    firstFrameLogged = false;
    await ensureDeps();
    if (sdk){ try{ sdk.close(); }catch{} sdk=null; }
    // eslint-disable-next-line no-undef
    sdk = new SrsRtcPlayerAsync();
    video = document.createElement('video'); video.autoplay=true; video.muted=true; video.playsInline=true;
    video.style.position='absolute'; video.style.left='-99999px'; video.style.top='-99999px';
    document.body.appendChild(video); video.srcObject = sdk.stream;

    // 监听 loadeddata / resize（某些浏览器视频尺寸变更）
    const resizeHandler = ()=> triggerFirstFrameIfReady('video-resize');
    const loadedHandler = ()=> triggerFirstFrameIfReady('loadeddata');
    try {
      video.addEventListener('loadeddata', loadedHandler, { once:false });
      video.addEventListener('resize', resizeHandler, { once:false });
    } catch {}

    let t1=0;
    try { await sdk.play(url); t1=performance.now(); log('sdk.play resolved in', (t1-tPlayStart).toFixed(1)+'ms'); } catch(e){ log('sdk.play error', e); stop(); cleanupVideoListeners(); throw e; }
    try { await video.play(); log('video.play resolved in', (performance.now()-t1).toFixed(1)+'ms'); } catch(e){ log('video.play error(non-blocking)', e); }
    loop=true; requestAnimationFrame(render);

    function cleanupVideoListeners(){
      if(!video) return;
      try { video.removeEventListener('loadeddata', loadedHandler); } catch {}
      try { video.removeEventListener('resize', resizeHandler); } catch {}
    }
    // 在 stop/destroy 时也会调用
    host._cleanupVideoListeners = cleanupVideoListeners;
  }

  function stop(){
    loop=false;
    try{ sdk && sdk.close(); }catch{}
    sdk=null;
    try{
      if(video){
        if (host._cleanupVideoListeners) host._cleanupVideoListeners();
        video.srcObject=null;
        video.remove();
      }
    }catch{}
  }

  function cleanup(){
    stop();
    try{ ro.disconnect(); }catch{};
    firstFrameLogged=false; host.hasFirstFrame=false;
  }
  function destroy(){ cleanup(); try{ host.remove(); }catch{} }

  host.el=host;
  host.play=play;
  host.stop=stop;
  host.destroy=destroy;
  host.setMode=(m)=>{ mode=m==='fit'?'fit':'fill'; };
  host.rotate=()=>{ rotation=(rotation+90)%360; };
  return host;
}
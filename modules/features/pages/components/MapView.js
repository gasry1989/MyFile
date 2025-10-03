/**
 * MapView（基于 iframe 的地图容器）
 * 外部 API：mount/setMarkers/openDevice/setCenter/resize/destroy
 * 外部事件：markerClick/openVideo/openMode/refreshDevice/openDetail
 * 变更：
 *  - 自动读取 window.__AMAP_KEY 与 window.__AMAP_SECURITY_JS_CODE
 *  - 在 init 消息中把 securityJsCode 一并下发，iframe 将在加载 SDK 之前注入
 */
export function createMapView({ amapKey, securityJsCode, debug = true } = {}) {
  const host = document.createElement('div');
  Object.assign(host.style, { display: 'block', width: '100%', height: '100%' });
  const shadow = host.attachShadow({ mode: 'open' });

  const css = document.createElement('style');
  css.textContent = `
    :host { all: initial; contain: content; display:block; width:100%; height:100%; }
    *,*::before,*::after{ box-sizing:border-box; }
    .wrap { width:100%; height:100%; position:relative; background:#0a0f14; }
    iframe { position:absolute; inset:0; width:100%; height:100%; border:0; display:block; background:#0a0f14; }
    .hint { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#9fb1bb; font-size:13px; pointer-events:none; }
  `;
  const wrap = document.createElement('div'); wrap.className = 'wrap';
  const iframe = document.createElement('iframe');
  const hint = document.createElement('div'); hint.className = 'hint'; hint.style.display = 'none';
  wrap.append(iframe, hint); shadow.append(css, wrap);

  let ready = false;
  let destroyed = false;
  const queue = [];
  const markersCache = [];
  let lastOpenDevice = null;

  const log  = (...a)=>{ if (debug) try{ console.info('[MapView]', ...a); }catch{} };
  const warn = (...a)=>{ if (debug) try{ console.warn('[MapView]', ...a); }catch{} };
  const showHint = (t)=>{ hint.textContent=t; hint.style.display='flex'; };
  const hideHint = ()=>{ hint.style.display='none'; };

  function resolveKey() {
    if (amapKey && String(amapKey).trim()) return String(amapKey).trim();
    try { if (window.__AMAP_KEY) return String(window.__AMAP_KEY).trim(); } catch {}
    const meta = document.querySelector('meta[name="amap-key"]'); if (meta?.content) return String(meta.content).trim();
    return '';
  }
  function resolveSec() {
    if (securityJsCode && String(securityJsCode).trim()) return String(securityJsCode).trim();
    try { if (window.__AMAP_SECURITY_JS_CODE) return String(window.__AMAP_SECURITY_JS_CODE).trim(); } catch {}
    const meta = document.querySelector('meta[name="amap-security"]'); if (meta?.content) return String(meta.content).trim();
    return '';
  }

  function postToFrame(msg) {
    if (destroyed) return;
    if (ready && iframe.contentWindow) {
      try { iframe.contentWindow.postMessage(Object.assign({ __mv:true }, msg), '*'); } catch {}
    } else {
      queue.push(msg);
    }
  }

  function flushQueue() {
    if (!ready || !iframe.contentWindow) return;
    for (const m of queue.splice(0)) {
      try { iframe.contentWindow.postMessage(Object.assign({ __mv:true }, m), '*'); } catch {}
    }
  }

  function mount() {
    const key = resolveKey();
    const sec = resolveSec();
    if (!key) { showHint('缺少高德 Key（AMAP_KEY）'); warn('缺少高德 Key（AMAP_KEY）'); }

    iframe.src = `/modules/features/pages/components/map-view-frame.html`;
    log('mount begin, size=', host.getBoundingClientRect());

    const onMsg = (e) => {
      const data = e.data || {};
      if (!data || !data.__mv) return;
      if (e.source !== iframe.contentWindow) return;

      switch (data.t) {
        case 'ready':
          ready = true;
          hideHint();
          flushQueue();
          if (markersCache.length) postToFrame({ t:'setMarkers', list: markersCache });
          if (lastOpenDevice) postToFrame({ t:'openDevice', devInfo: lastOpenDevice.devInfo, followCenterWhenNoLocation: lastOpenDevice.followCenterWhenNoLocation });
          break;
        case 'markerClick':
          host.dispatchEvent(new CustomEvent('markerClick', { bubbles:true, detail:{ devId: data.devId } }));
          break;
        case 'openVideo':
          host.dispatchEvent(new CustomEvent('openVideo', {
            bubbles:true,
            detail:{ devId: data.devId, devNo: data.devNo, cameraIndex: data.cameraIndex, streamType: data.streamType }
          }));
          break;
        case 'openMode':
          host.dispatchEvent(new CustomEvent('openMode', { bubbles:true, detail:{ devId: data.devId, devNo: data.devNo, modeId: data.modeId } }));
          break;
        case 'refreshDevice':
          host.dispatchEvent(new CustomEvent('refreshDevice', { bubbles:true, detail:{ devId: data.devId } }));
          break;
        case 'openDetail':
          host.dispatchEvent(new CustomEvent('openDetail', { bubbles:true, detail:{ devId: data.devId, devNo: data.devNo } }));
          break;
        case 'error':
          warn(data.message); showHint(data.message || '地图加载失败');
          break;
        case 'log':
          log(data.m, data.z ?? '');
          break;
      }
    };
    window.addEventListener('message', onMsg);
    host.__onMsg = onMsg;

    iframe.addEventListener('load', () => {
      try {
        iframe.contentWindow?.postMessage({ __mv:true, t:'init', key, debug: !!debug, securityJsCode: sec }, '*');
      } catch {}
    }, { once: true });
  }

  function setMarkers(list = []) { markersCache.length = 0; markersCache.push(...list); postToFrame({ t:'setMarkers', list }); }
  function openDevice({ devInfo, followCenterWhenNoLocation = true }) { lastOpenDevice = { devInfo, followCenterWhenNoLocation }; postToFrame({ t:'openDevice', devInfo, followCenterWhenNoLocation }); }
  function setCenter(lng, lat) { postToFrame({ t:'setCenter', lng, lat }); }
  function resize() { postToFrame({ t:'resize' }); }
  function destroy() { try { window.removeEventListener('message', host.__onMsg); } catch {} try { host.remove(); } catch {} }

  host.mount = mount;
  host.setMarkers = setMarkers;
  host.openDevice = openDevice;
  host.setCenter = setCenter;
  host.resize = resize;
  host.destroy = destroy;

  return host;
}
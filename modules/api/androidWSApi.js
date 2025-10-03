import { wsHub, startWSHub } from '@core/hub.js';
import { wsClient } from '@core/wsClient.js';
import { eventBus } from '@core/eventBus.js';
import { WS_LOG_ALL } from '/config/constants.js';

startWSHub();

/* -------------------- 代理模式检测 -------------------- */
const IS_TOP = window === window.top;
const PROXY_REQ   = '__wsProxyReq';
const PROXY_RESP  = '__wsProxyResp';
const PROXY_FIRE  = '__wsProxyFire';
const PROXY_ACK   = '__wsProxyAck';

// ACK 阶段快速检测超时（仅用于判定是否进入顶层 Master，非业务处理超时）
const PROXY_ACK_TIMEOUT_MS = (() => {
  const v = Number(window.__WS_PROXY_ACK_TIMEOUT_MS);
  if (Number.isFinite(v) && v >= 0) return v;
  return 300; // 默认 300ms
})();

let USE_PROXY = false;

// Master 标记
if (IS_TOP) {
  try { window.__WS_PROXY_MASTER = true; } catch {}
}

// 检测父窗口是否为 Master（同源）
if (!IS_TOP) {
  try {
    if (parent && parent.__WS_PROXY_MASTER) USE_PROXY = true;
  } catch {
    // 跨域失败 => 不走代理
  }
}

/* -------------------- Master 侧消息处理 -------------------- */
if (IS_TOP) {
  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!data || typeof data !== 'object') return;

    // 代理请求
    if (data[PROXY_REQ]) {
      const { rid, payload } = data;
      if (!rid || !payload || !payload.cmd) return;

      // 回 ACK（确认已进入顶层队列）
      try { ev.source.postMessage({ [PROXY_ACK]: true, rid }, '*'); } catch {}

      wsHub.request(payload)
        .then(resp => {
          try { ev.source.postMessage({ [PROXY_RESP]: true, rid, resp }, '*'); } catch {}
        })
        .catch(err => {
          const resp = (err && err.code != null) ? err : { code: -1, msg: err?.message || 'proxy error' };
          try { ev.source.postMessage({ [PROXY_RESP]: true, rid, resp }, '*'); } catch {}
        });
    }

    // fire-and-forget
    if (data[PROXY_FIRE]) {
      const { payload } = data;
      if (payload && payload.cmd) {
        wsHub.fireAndForget(payload);
      }
    }
  });
}

/* -------------------- Slave 侧代理函数 -------------------- */
function proxyRequest(payload) {
  if (WS_LOG_ALL || window.__WS_DEBUG__ === true) {
    try { console.log('[WS-PROXY][request][slave->master]', payload); } catch {}
  }

  return new Promise((resolve, reject) => {
    const rid = Date.now() + '-' + Math.random().toString(36).slice(2);
    let acked = false;
    let ackTimer = null;
    let posted = false;

    function clearAckTimer(){
      if(ackTimer){ clearTimeout(ackTimer); ackTimer=null; }
    }
    function removeAll(){
      clearAckTimer();
      window.removeEventListener('message', onMsg);
    }

    function onMsg(ev){
      const msg = ev.data;
      if(!msg) return;
      if(msg[PROXY_ACK] && msg.rid === rid){
        acked = true;
        clearAckTimer(); // ACK 到达 => 进入业务等待，不再使用 1 秒硬超时
        return;
      }
      if(msg[PROXY_RESP] && msg.rid === rid){
        removeAll();
        if (WS_LOG_ALL || window.__WS_DEBUG__ === true) {
          try { console.log('[WS-PROXY][response][master->slave]', msg.resp); } catch {}
        }
        const resp = msg.resp;
        if(resp && (resp.code == null || resp.code === 0)) resolve(resp);
        else reject(resp);
      }
    }

    window.addEventListener('message', onMsg);

    try {
      parent.postMessage({ [PROXY_REQ]: true, rid, payload }, '*');
      posted = true;
    } catch(e) {
      removeAll();
      reject(e);
      return;
    }

    if (PROXY_ACK_TIMEOUT_MS > 0) {
      ackTimer = setTimeout(()=>{
        if(!acked){
          removeAll();
            const reason = (!posted) ? 'POST_MESSAGE_FAIL'
                          : (!window.parent || window.parent === window) ? 'NO_MASTER'
                          : 'NO_ACK';
          if (WS_LOG_ALL || window.__WS_DEBUG__ === true) {
            console.warn('[WS-PROXY][ack-timeout]', { cmd:payload?.cmd, rid, reason });
          }
          reject({ code:-100, msg:'proxy ack timeout', reason, acked:false, cmd:payload?.cmd });
        }
      }, PROXY_ACK_TIMEOUT_MS);
    }
  });
}

function proxyFire(payload) {
  if (WS_LOG_ALL || window.__WS_DEBUG__ === true) {
    try { console.log('[WS-PROXY][fire][slave->master]', payload); } catch {}
  }
  try { parent.postMessage({ [PROXY_FIRE]: true, payload }, '*'); } catch {}
}

/* -------------------- 事件广播（原实现保留） -------------------- */
const INSTANCE_ID = Math.random().toString(36).slice(2);
const CHANNEL_NAME = 'android-ws-bridge';
const hasBC = typeof BroadcastChannel !== 'undefined';
const bc = hasBC ? new BroadcastChannel(CHANNEL_NAME) : null;

function relayOut(event) {
  const payload = { __androidWsEvent: true, sourceId: INSTANCE_ID, event };
  try { if (bc) bc.postMessage(payload); } catch {}
  try { if (window.opener) window.opener.postMessage(payload, '*'); } catch {}
  try { if (window.parent && window.parent !== window) window.parent.postMessage(payload, '*'); } catch {}
}
function relayIn(payload) {
  if (!payload || payload.sourceId === INSTANCE_ID || !payload.__androidWsEvent) return;
  const { event } = payload;
  if (!event || !event.topic) return;
  wsHub.publish(event.topic, event.data);
}
if (bc) bc.addEventListener('message', (ev) => { try { relayIn(ev.data); } catch {} });
window.addEventListener('message', (ev) => { try { relayIn(ev.data); } catch {} });

/* -------------------- Topic 映射（原样） -------------------- */
export const AndroidTopics = {
  Error: 'android:error',
  PushStreamResponse: 'android:pushStream:response',
  PushStreamResolutionResponse: 'android:pushStreamResolution:response',
  PushStreamMuteResponse: 'android:pushStreamMute:response',
  PullStreamResponse: 'android:pullStream:response',
  ModeDataResponse: 'android:modeData:response',
  ExecuteCmdResponse: 'android:executeCmd:response',
  GetHostDeviceInfoResponse: 'android:getHostDeviceInfo:response',
  DipOneChannelResponse: 'android:dipOneChannel:response',
  DipTwoChannelResponse: 'android:dipTwoChannel:response',
  AudioOneChannelResponse: 'android:audioOneChannel:response',
  AvProbeInfoResponse: 'android:avProbeInfo:response',
  ControlAngleResponse: 'android:controlAngle:response',
  SetAngleAlarmValResponse: 'android:setAngleAlarmVal:response',
  SetMoveAlarmValResponse: 'android:setMoveAlarmVal:response',
  SetVibrationALResponse: 'android:setVibrationAL:response',
  SetGasAlarmPResponse: 'android:setGasAlarmP:response',
  ControlDipResponse: 'android:controlDip:response',
  ControlAudioProbeResponse: 'android:controlAudioProbe:response',
  GetProbeLogResponse: 'android:getProbeLog:response',
  CameraZoomResponse: 'android:cameraZoom:response',
  PhotoResponse: 'android:photo:response',
  RecordVideoResponse: 'android:recordVideo:response',
  ProbeRotationResponse: 'android:probeRotation:response',
  GetTIProbeResponse: 'android:getTIProbe:response',
  SetTIProbeResponse: 'android:setTIProbe:response',
  SetPseudoCMResponse: 'android:setPseudoCM:response',
  CameraLightResponse: 'android:cameraLight:response',
  Raw: 'android:raw'
};

function publish(topic, data) { wsHub.publish(topic, data); relayOut({ topic, data }); }

const cmdToTopic = new Map([
  ['error', AndroidTopics.Error],
  ['pushStreamResponse', AndroidTopics.PushStreamResponse],
  ['pushStreamResolutionResponse', AndroidTopics.PushStreamResolutionResponse],
  ['pushStreamMuteResponse', AndroidTopics.PushStreamMuteResponse],
  ['pullStreamResponse', AndroidTopics.PullStreamResponse],
  ['modeDataResponse', AndroidTopics.ModeDataResponse],
  ['executeCmdResp', AndroidTopics.ExecuteCmdResponse],
  ['getHostDeviceInfoResponse', AndroidTopics.GetHostDeviceInfoResponse],
  ['dipOneChannelResponse', AndroidTopics.DipOneChannelResponse],
  ['dipTwoChannelResponse', AndroidTopics.DipTwoChannelResponse],
  ['audioOneChannelResponse', AndroidTopics.AudioOneChannelResponse],
  ['avProbeInfoResponse', AndroidTopics.AvProbeInfoResponse],
  ['controlAngleResponse', AndroidTopics.ControlAngleResponse],
  ['setAngleAlarmValResponse', AndroidTopics.SetAngleAlarmValResponse],
  ['setMoveAlarmValResponse', AndroidTopics.SetMoveAlarmValResponse],
  ['setVibrationALResponse', AndroidTopics.SetVibrationALResponse],
  ['setGasAlarmPResponse', AndroidTopics.SetGasAlarmPResponse],
  ['controlDipResponse', AndroidTopics.ControlDipResponse],
  ['controlAudioProbeResponse', AndroidTopics.ControlAudioProbeResponse],
  ['getProbeLogResponse', AndroidTopics.GetProbeLogResponse],
  ['cameraZoomResponse', AndroidTopics.CameraZoomResponse],
  ['photoResponse', AndroidTopics.PhotoResponse],
  ['recordVideoResponse', AndroidTopics.RecordVideoResponse],
  ['probeRotationResponse', AndroidTopics.ProbeRotationResponse],
  ['getTIProbeResponse', AndroidTopics.GetTIProbeResponse],
  ['setTIProbeResponse', AndroidTopics.SetTIProbeResponse],
  ['setPseudoCMResponse', AndroidTopics.SetPseudoCMResponse],
  ['cameraLightResponse', AndroidTopics.CameraLightResponse]
]);

wsHub.onRaw((msg) => {
  if (!msg || !msg.cmd) return;
  const topic = cmdToTopic.get(msg.cmd) || AndroidTopics.Raw;
  publish(topic, msg);
});

// 记录顶层状态供调试（可选读取）
eventBus.on('ws:status', s => { try { window.__WS_PROXY_MASTER_WS_STATUS = s; } catch {} });

/* -------------------- 工具 & 封装 -------------------- */
function toObj(to) {
  if (!to) return undefined;
  if (typeof to === 'object') return to;
  return { type: 1, id: to };
}

// MOD: req 包装 统一去重打印
function req(cmd, data, to) {
  const payload = { cmd, to: toObj(to), data };
  try {
    if (!window.__WS_PRINT_SENT_SET__) window.__WS_PRINT_SENT_SET__ = new Set();
    const ridKey = 'S:REQ:' + (payload.cmd||'') + ':' + (payload.to?.id||'') + ':' + Date.now();
    if (!window.__WS_PRINT_SENT_SET__.has(ridKey)) {
      window.__WS_PRINT_SENT_SET__.add(ridKey);
      // console.log('[WS][SEND:REQ]', { time:new Date().toISOString(), cmd:payload.cmd, to:payload.to, data:payload.data });
    }
  } catch {}
  try {
    // console.log('[WS-API][SEND]', cmd, JSON.parse(JSON.stringify(payload)));
  } catch {
    console.log('[WS-API][SEND]', cmd, payload);
  }
  const p = USE_PROXY ? proxyRequest(payload) : wsHub.request(payload);
  p.then(res => {
    try { /* success quiet */ } catch {}
  }).catch(err => {
    // try {
      // console.warn('[WS][REQ][FAIL]', { cmd, code:err?.code, msg:err?.msg });
    // } catch {}
  });
  return p;
}

// MOD: fire (fire-and-forget) 统一去重打印
function fire(cmd, data, to) {
  const payload = { cmd, to: toObj(to), data };
  // 去重发送打印
  try {
    if (!window.__WS_PRINT_SENT_SET__) window.__WS_PRINT_SENT_SET__ = new Set();
    const ridKey = 'S:FF:' + (payload.cmd||'') + ':' + (payload.to?.id||'');
    if (!window.__WS_PRINT_SENT_SET__.has(ridKey)) {
      window.__WS_PRINT_SENT_SET__.add(ridKey);
      console.log('[WS][SEND:FIRE]', { time:new Date().toISOString(), cmd:payload.cmd, to:payload.to, data:payload.data });
    }
  } catch {}
  try {
    console.log('[WS-API][FIRE]', cmd, JSON.parse(JSON.stringify(payload)));
  } catch {
    console.log('[WS-API][FIRE]', cmd, payload);
  }
  if (USE_PROXY) { proxyFire(payload); return 0; }
  return wsHub.fireAndForget(payload);
}

/* -------------------- API 导出 -------------------- */
export const androidWsApi = {
  on(topic, fn) { return wsHub.onTopic(topic, fn); },
  onByDev(topic, devId, fn) {
    return wsHub.onTopic(topic, (msg) => {
      const fid = String(msg?.from?.id ?? msg?.to?.id ?? '');
      if (fid === String(devId)) fn(msg);
    });
  },
  emitExternal(topic, data) { publish(topic, data); },

  pushStream({ toId, startFlag, hardwareType, hardwareIndex, to }) { return req('pushStream', { startFlag, hardwareType, hardwareIndex }, to ?? { type:1, id:toId }); },
  pushStreamResolution({ toId, streamURI, quality, to }) { return req('pushStreamResolution', { streamURI, quality }, to ?? { type:1, id:toId }); },
  pushStreamMute({ toId, streamURI, muteVideo, to }) { return req('pushStreamMute', { streamURI, muteVideo }, to ?? { type:1, id:toId }); },
  pullStream({ toId, startFlag, streamType, streamURI, to }) { return req('pullStream', { startFlag, streamType, streamURI }, to ?? { type:1, id:toId }); },
  modeData({ toId, modeId, to }) { return req('modeData', { modeId }, to ?? { type:1, id:toId }); },
  executeCmd({ toId, cmdText, to }) { return req('executeCmd', { cmd: cmdText }, to ?? { type:1, id:toId }); },
  getHostDeviceInfo({ toId, to }) { return req('getHostDeviceInfo', {}, to ?? { type:1, id:toId }); },
  dipOneChannel({ toId, to }) { return req('dipOneChannel', {}, to ?? { type:1, id:toId }); },
  dipTwoChannel({ toId, to }) { return req('dipTwoChannel', {}, to ?? { type:1, id:toId }); },
  audioOneChannel({ toId, to }) { return req('audioOneChannel', {}, to ?? { type:1, id:toId }); },
  avProbeInfo({ toId, to }) { return req('avProbeInfo', {}, to ?? { type:1, id:toId }); },
  controlAngle({ toId, operation, codeArray, to }) { return req('controlAngle', { operation, codeArray }, to ?? { type:1, id:toId }); },
  setAngleAlarmVal({ toId, model = 1, alarmVal, operation, probeId, to }) { return req('setAngleAlarmVal', { model, alarmVal, operation, probeId }, to ?? { type:1, id:toId }); },
  setMoveAlarmVal({ toId, model = 1, alarmVal, operation, probeId, to }) { return req('setMoveAlarmVal', { model, alarmVal, operation, probeId }, to ?? { type:1, id:toId }); },
  setVibrationAL({ toId, model = 1, alarmLevel, probeId, to }) { return req('setVibrationAL', { model, alarmLevel, probeId }, to ?? { type:1, id:toId }); },
  setGasAlarmP({ toId, model = 1, gasSequence, probeId, highReportedVal, lowReportedVal, to }) { return req('setGasAlarmP', { model, gasSequence, probeId, highReportedVal, lowReportedVal }, to ?? { type:1, id:toId }); },
  controlDip({ toId, operation, commandType, probeId, timestamp, to }) { return req('controlDip', { operation, commandType, probeId, timestamp }, to ?? { type:1, id:toId }); },
  controlAudioProbe({ toId, isLeftHeadset, isRightHeadset, isStart, probeId, timestamp, to }) {
    const payload = {};
    if(isLeftHeadset !== undefined) payload.isLeftHeadset = !!isLeftHeadset;
    if(isRightHeadset !== undefined) payload.isRightHeadset = !!isRightHeadset;
    if(isStart !== undefined) payload.isStart = !!isStart;
    if(probeId != null) payload.probeId = String(probeId);
    if(timestamp != null) payload.timestamp = timestamp;
    return req('controlAudioProbe', payload, to ?? { type:1, id:toId });
  },
  getProbeLog({ toId, model = 1, logType = 0, probeId, logId, quantity, timestamp, to }) { return req('getProbeLog', { model, logType, probeId, logId, quantity, timestamp }, to ?? { type:1, id:toId }); },
  cameraZoom({ toId, model = 3, cameraIndex = 0, operation, multiple, timestamp, to }) { return req('cameraZoom', { model, cameraIndex, operation, multiple, timestamp }, to ?? { type:1, id:toId }); },
  photo({ toId, model = 3, cameraIndex = 0, timestamp, to }) { return req('photo', { model, cameraIndex, timestamp }, to ?? { type:1, id:toId }); },
  recordVideo({ toId, model = 3, operation, cameraIndex = 0, timestamp, to }) { return req('recordVideo', { model, operation, cameraIndex, timestamp }, to ?? { type:1, id:toId }); },
  probeRotation({ toId, model = 3, direction, operation = 0, longPressStatus = 0, cameraIndex = 0, timestamp, to }) { return req('probeRotation', { model, direction, operation, longPressStatus, cameraIndex, timestamp }, to ?? { type:1, id:toId }); },
  getTIProbe({ toId, to }) { return req('getTIProbe', {}, to ?? { type:1, id:toId }); },
  setTIProbe({ toId, tempSwitch, tempMode, highTracking, lowTracking, centralTemp, highTempAlarm, highTempVal, pseudoColorMode, timestamp, to }) {
    return req('setTIProbe', { tempSwitch, tempMode, highTracking, lowTracking, centralTemp, highTempAlarm, highTempVal, pseudoColorMode, timestamp }, to ?? { type:1, id:toId });
  },
  setPseudoCM({ toId, next, number, to }) { return req('setPseudoCM', { next, number }, to ?? { type:1, id:toId }); },
  cameraLight({ toId, operation, cameraIndex = 0, to }) { return req('cameraLight', { operation, cameraIndex }, to ?? { type:1, id:toId }); },

  // fire-and-forget
  sendNoWait({ cmd, toId, data = {}, to }) { return fire(cmd, data, to ?? { type:1, id:toId }); },
  forceListFetch(cmd, toId) { return fire(cmd, {}, { type:1, id:toId }); },

  __isProxy: () => USE_PROXY,
  __status: () => wsClient?.status
};
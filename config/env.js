/**
 * 环境配置
 * 说明：
 * - AMAP_JS_KEY/AMAP_KEY：高德 Web 端(JS API) Key（使用你截图中的 WEB-JS）
 * - AMAP_SECURITY_JS_CODE：若该 Key 开启了“安全密钥”，必须在加载 SDK 前注入
 * - 同时把 Key 注入到 window.__AMAP_KEY 和 window.__AMAP_SECURITY_JS_CODE，MapView 会自动读取
 */
export const ENV = {
  API_BASE: 'http://media.szdght.com:11181',
  WS_URL: 'wss://media.szdght.com:11181/ws',
  // API_BASE: 'http://192.168.2.250:11180',
  // WS_URL: 'ws://192.168.2.250:11180/ws',
  // 使用“Web 端(JS API)”Key（来自你的截图 WEB-JS）
  AMAP_JS_KEY: 'b31827273beede64f1ac219c392b3b49',
  // 兼容旧字段名
  AMAP_KEY: 'b31827273beede64f1ac219c392b3b49',

  // 该 JS Key 的安全密钥（来自你的截图；如未开启可设为空字符串）
  AMAP_SECURITY_JS_CODE: 'f3b3f8e7adc00ee49692ce805a7f1662',

  PREVIEW_MAX: 8
};

// 将 Key 暴露到全局，供 MapView.js 读取
try {
  if (typeof window !== 'undefined') {
    window.__AMAP_KEY = ENV.AMAP_JS_KEY || ENV.AMAP_KEY || '';
    window.__AMAP_SECURITY_JS_CODE = ENV.AMAP_SECURITY_JS_CODE || '';
  }
} catch {}
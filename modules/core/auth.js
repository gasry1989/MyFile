import { createStore } from '@core/store.js';
import { eventBus } from '@core/eventBus.js';
import { httpPost } from '@core/http.js';
import { apiPath } from '@core/apiCatalog.js';
import { sha256Hex } from '@utils/hash.js'; // 已实现 WebCrypto + fallback

const LS_TOKEN = 'APP_TOKEN';
const LS_USER  = 'APP_USER';

export const authState = createStore({
  token: null,
  userInfo: null
});

export function authLoadToken() {
  const tk = localStorage.getItem(LS_TOKEN);
  const uiStr = localStorage.getItem(LS_USER);
  if (tk) {
    let userInfo = null;
    try { userInfo = JSON.parse(uiStr); } catch {}
    authState.set({ token: tk, userInfo });
    // 新增：同步当前用户 ID 到全局，供树状图重定根
    try {
      if (userInfo && userInfo.userId != null) {
        window.__CURRENT_USER_ID = Number(userInfo.userId);
      } else {
        delete window.__CURRENT_USER_ID;
      }
    } catch {}
  } else {
    // 没有 token 清理可能残留
    try { delete window.__CURRENT_USER_ID; } catch {}
  }
}

export function authGetToken() {
  return authState.get().token;
}

export function authRequireGuard() {
  return !!authGetToken();
}

export async function authLogin(account, rawPwd) {
  // 方案2：sha256Hex 内部自动区分安全上下文或 fallback
  const hashed = await sha256Hex(rawPwd);
  // 缓存用于静默重登
  try {
    localStorage.setItem('APP_LAST_LOGIN_ACC', account);
    localStorage.setItem('APP_LAST_LOGIN_PWD_HASH', hashed);
  } catch {}
  const data = await httpPost(apiPath('3.1'), {
    userAccount: account,
    pwd: hashed
  });
  authState.set({ token: data.token, userInfo: data.userInfo });
  localStorage.setItem(LS_TOKEN, data.token);
  localStorage.setItem(LS_USER, JSON.stringify(data.userInfo));
  // 新增：设置全局当前用户 ID
  try {
    if (data && data.userInfo && data.userInfo.userId != null) {
      window.__CURRENT_USER_ID = Number(data.userInfo.userId);
    } else {
      delete window.__CURRENT_USER_ID;
    }
  } catch {}
  eventBus.emit('toast:show', { type: 'success', message: '登录成功' });
  eventBus.emit('auth:login', data.userInfo);
  location.hash = '#/site';
}

export async function authReLogin() {
  // 静默重新登录：使用上次缓存的账号与 hashed 密码（不弹登录成功 toast）
  let acc = null, hashPwd = null;
  try {
    acc = localStorage.getItem('APP_LAST_LOGIN_ACC');
    hashPwd = localStorage.getItem('APP_LAST_LOGIN_PWD_HASH');
  } catch {}
  if (!acc || !hashPwd) {
    const err = new Error('NO_CACHED_CREDENTIAL');
    throw err;
  }
  const data = await httpPost(apiPath('3.1'), {
    userAccount: acc,
    pwd: hashPwd
  });
  authState.set({ token: data.token, userInfo: data.userInfo });
  localStorage.setItem(LS_TOKEN, data.token);
  localStorage.setItem(LS_USER, JSON.stringify(data.userInfo));
  // 新增：同步全局当前用户 ID
  try {
    if (data && data.userInfo && data.userInfo.userId != null) {
      window.__CURRENT_USER_ID = Number(data.userInfo.userId);
    } else {
      delete window.__CURRENT_USER_ID;
    }
  } catch {}
  eventBus.emit('auth:login', data.userInfo);
  return data;
}

export function authLogout() {
  // 冲突标记：由 hub.js 在收到 WS code=1004 时设 window.__FORCE_LOGOUT_CONFLICT = 1
  let conflict = false;
  try {
    if (window.__FORCE_LOGOUT_CONFLICT) {
      conflict = true;
      // 不在这里删除标记，留给 wsClient 延迟 toast 判定使用
    }
  } catch {}

  authState.set({ token: null, userInfo: null });
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_USER);
  // 新增：清理全局当前用户 ID
  try { delete window.__CURRENT_USER_ID; } catch {}
  eventBus.emit('auth:logout');

  if (conflict) {
    eventBus.emit('toast:show', { type:'warn', message:'请重新登陆' });
  }
  // 手动退出时的 “已退出登录” 提示继续由调用处控制（不要在这里重复）

  // 跳转到登录路由
  location.hash = '#/login';

  const doReload = () => {
    try {
      const url = window.location.origin + window.location.pathname + '#/login';
      window.location.replace(url);
      window.location.reload();
    } catch {
      setTimeout(()=>window.location.reload(), 50);
    } finally {
      // 刷新前后都无所谓，提前清理标记避免潜在误判
      try { delete window.__FORCE_LOGOUT_CONFLICT; } catch {}
    }
  };

  if (conflict) {
    // 给冲突 toast 留时间显示
    setTimeout(doReload, 1500);
  } else {
    doReload();
  }
}
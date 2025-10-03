import { httpPost } from '@core/http.js';
import { apiPath } from '@core/apiCatalog.js';
import { authLoadToken } from '@core/auth.js';

/* 统一确保 Token 已加载（authLoadToken 内部若已有缓存应为幂等操作） */
function ensureAuth() {
  try { authLoadToken(); } catch (e) {}
}

/**
 * 3.10 获取设备列表（按用户）
 * payload:
 *  {
 *    userIds?: number[]
 *    pageIndex: number
 *    pageSize: number
 *  }
 */
export function apiDeviceList(options = {}) {
  ensureAuth();
  const {
    userIds = [],
    pageIndex = 1,
    pageSize = 10
  } = options;

  const payload = { pageIndex, pageSize };
  if (Array.isArray(userIds) && userIds.length) {
    payload.userIds = userIds;
  }
  return httpPost(apiPath('3.10'), payload);
}

/**
 * 3.20 汇总
 */
export function apiDeviceSummary(pageIndex = 1, pageSize = 10) {
  ensureAuth();
  return httpPost(apiPath('3.20'), { pageIndex, pageSize });
}

export function apiDevTypes() {
  ensureAuth();
  return httpPost(apiPath('3.13'), {});
}
export function apiDevModes() {
  ensureAuth();
  return httpPost(apiPath('3.14'), {});
}

/**
 * 3.15 查询设备列表（树状，已分组）
 */
export function apiGroupedDevices(filters = {}) {
  ensureAuth();
  const {
    searchStr = '',
    filterOnline = false,
    devTypeIdArr = [],
    devModeIdArr = []
  } = filters;

  return httpPost(apiPath('3.15'), {
    filterStr: searchStr,
    filterOnline: !!filterOnline,
    devTypeIdArr,
    devModeIdArr
  });
}

/**
 * 3.16 未分组设备列表
 */
export function apiUngroupedDevices(filters = {}) {
  ensureAuth();
  const {
    searchStr = '',
    filterOnline = false,
    devTypeIdArr = [],
    devModeIdArr = []
  } = filters;

  return httpPost(apiPath('3.16'), {
    filterStr: searchStr,
    filterOnline: !!filterOnline,
    devTypeIdArr,
    devModeIdArr
  });
}

export function apiDeviceInfo(devId) {
  ensureAuth();
  return httpPost(apiPath('3.17'), { devId });
}
export function apiOnlineList() {
  ensureAuth();
  return httpPost(apiPath('3.21'), {});
}
export function apiDeviceUpdateInfo(devInfo) {
  ensureAuth();
  return httpPost(apiPath('3.18'), { devInfo });
}
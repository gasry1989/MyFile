import { httpPost } from '@core/http.js';
import { apiPath } from '@core/apiCatalog.js';

/* 其余函数同之前，保持不变 */

/** 3.11 用户列表 */
export function apiUserList(pageIndex = 1, pageSize = 20) {
  return httpPost(apiPath('3.11'), { pageIndex, pageSize });
}

/** 3.8 创建用户 */
export function apiUserCreate(userInfo) {
  return httpPost(apiPath('3.8'), { userInfo });
}

/** 3.9 修改用户 */
export function apiUserUpdate(userInfo) {
  return httpPost(apiPath('3.9'), { userInfo });
}

/** 3.12 修改密码 */
export function apiUserUpdatePassword(userInfo) {
  return httpPost(apiPath('3.12'), { userInfo });
}

/** 3.5 角色列表 */
export function apiRoleList() {
  return httpPost(apiPath('3.5'), {});
}

/** 3.6 修改角色权限 */
export function apiRoleUpdate(roles) {
  return httpPost(apiPath('3.6'), { roles });
}

/** 3.7 查用户（父账号、模糊匹配） */
export function apiUserQuery(queryStr, pageIndex = 1, pageSize = 20) {
  return httpPost(apiPath('3.7'), { queryStr, pageIndex, pageSize });
}

/** 3.24 删除用户 */
export function apiUserDelete(userIds) {
  return httpPost(apiPath('3.24'), { userIds });
}

/** 3.10 设备概览（userIds 空使用后端默认） */
export function apiDeviceOverview(pageIndex = 1, pageSize = 50) {
  return httpPost(apiPath('3.10'), { pageIndex, pageSize, userIds: [] });
}

/**
 * 3.12 修改密码（按 userId 显式调用）
 * @param {number} userId
 * @param {string} newPwd
 * @param {object} opts { oldPwd?: string }
 */
export function apiUserChangePassword(userId, newPwd, opts = {}) {
  const payload = {
    userInfo: {
      userId,
      newpwd: newPwd
    }
  };
  if (opts.oldPwd) {
    payload.userInfo.oldpwd = opts.oldPwd;
  }
  return httpPost(apiPath('3.12'), payload);
}

/**
 * 新增：获取对讲/音频推流地址统一封装
 * 原 /api/misc/stream_url 现在集中到此
 * @param {object} opts { devId, hardwareType=3, hardwareIndex=0 }
 */
export function apiStreamUrl({ devId, hardwareType = 3, hardwareIndex = 0 }) {
  return httpPost(apiPath('3.23'), {
    hardwareType,
    hardwareIndex,
    devId
  });
}
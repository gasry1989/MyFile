/**
 * 权限辅助：
 * 当前只根据 roleId 判断：管理员(0) & 测试人员(1) 可修改角色
 * 后续可扩展 permissionId
 */
export function hasModifyRolePermission(roleId) {
  return roleId === 0 || roleId === 1;
}
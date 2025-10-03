/**
 * 接口编号 -> 路径映射，用于快速与文档对照
 */
export const API_CATALOG = {
  '3.1': '/api/web/user/login',
  '3.2': '/api/web/misc/province_list',
  '3.3': '/api/web/misc/city_list',
  '3.4': '/api/web/misc/zone_list',
  '3.5': '/api/web/user/role/list',
  '3.6': '/api/web/user/role/update',
  '3.7': '/api/web/user/query_list',
  '3.8': '/api/web/user/create',
  '3.9': '/api/web/user/update',
  '3.10': '/api/web/dev/list',
  '3.11': '/api/web/user/list',
  '3.12': '/api/web/user/update_password',
  '3.13': '/api/web/dev/type_list',
  '3.14': '/api/web/dev/mode_list',
  '3.15': '/api/web/dev/query_group_list',
  '3.16': '/api/web/dev/query_ungroup_list',
  '3.17': '/api/web/dev/info',
  '3.20': '/api/web/dev/summary_list',
  '3.21': '/api/web/misc/online_list',
  '3.24': '/api/web/user/delete',
  '3.18': '/api/web/dev/update_info',
  '3.23': '/api/misc/stream_url'
};

export function apiPath(id) {
  return API_CATALOG[id];
}
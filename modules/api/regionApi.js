import { httpPost } from '../core/http.js';
import { apiPath } from '../core/apiCatalog.js';

export function apiProvinceList() {
  return httpPost(apiPath('3.2'), {});
}
export function apiCityList(provinceId) {
  return httpPost(apiPath('3.3'), { provinceId });
}
export function apiZoneList(cityId) {
  return httpPost(apiPath('3.4'), { cityId });
}
import { httpPost } from '../core/http.js';
import { apiPath } from '../core/apiCatalog.js';

export function apiLogin(account, pwd) {
  return httpPost(apiPath('3.1'), { userAccount: account, pwd });
}
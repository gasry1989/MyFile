import { createStore } from '../core/store.js';

export const roleState = createStore({
  roles: [],
  loading: false,
  submitting: false,
  dirtyMap: {} // {roleId: {permId: bool}}
});
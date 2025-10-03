import { createStore } from '../core/store.js';

export const userState = createStore({
  loading: false,
  list: [],
  listInfo: { total: 0, pageIndex: 1, pageSize: 20, pageTotal: 0 },
  selection: new Set(),
  roleList: [],
  roleFetchedAt: 0,
  regionCache: {
    provinces: [],
    citiesByProvince: {},
    zonesByCity: {}
  },
  parentSearchResults: [],
  deviceOverview: { list: [], loading: false }
});
import { createStore } from '../core/store.js';

export const siteState = createStore({
  filters: {
    devType: 0,
    devMode: 0,
    searchStr: '',
    filterOnline: false
  },
  groupedDevices: [],
  ungroupedDevices: [],
  tree: {
    nodes: [],
    expanded: new Set(),
    activeDevId: null
  },
  map: {
    markers: [],
    focusedDevId: null
  },
  summary: {
    total: 0,
    onlineCount: 0,
    stateList: []
  },
  notifications: [],
  overlay: {
    open: false,
    devId: null,
    selectedStream: 'main',
    selectedModeId: null
  },
  lastLoadedAt: 0
});
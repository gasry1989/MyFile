import { createStore } from '../core/store.js';
import { ENV } from '../../config/env.js';

export const previewState = createStore({
  windows: [],
  capacity: 0
});

/**
 * 根据当前窗口宽度与侧栏折叠情况计算容量
 */
export function computePreviewCapacity() {
  const containerWidth = document.getElementById('previewBar')?.clientWidth || window.innerWidth;
  const minWidth = 190; // 单窗口最小宽度
  const capacity = Math.min(ENV.PREVIEW_MAX, Math.max(1, Math.floor(containerWidth / minWidth)));
  previewState.set({ capacity });
}
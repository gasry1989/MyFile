/**
 * 简易事件总线（全局使用）。
 * on(event, handler) -> 返回 off 函数
 * emit(event, payload)
 */
class EventBus {
  constructor() {
    this.map = new Map();
  }
  on(event, fn) {
    if (!this.map.has(event)) this.map.set(event, new Set());
    this.map.get(event).add(fn);
    return () => this.map.get(event)?.delete(fn);
  }
  once(event, fn) {
    const off = this.on(event, (p) => {
      off();
      fn(p);
    });
  }
  emit(event, payload) {
    if (this.map.has(event)) {
      for (const fn of this.map.get(event)) {
        try { fn(payload); } catch (e) { console.error('[eventBus]', event, e); }
      }
    }
  }
}

export const eventBus = new EventBus();
/**
 * 轻量 Store：支持订阅 + 局部更新
 * createStore(initialState)
 * store.get()
 * store.set(patch)
 * store.subscribe(fn)
 */
export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  function get() { return state; }
  function set(patch) {
    state = { ...state, ...patch };
    subs.forEach(fn => { try { fn(state); } catch (e) {} });
  }
  function subscribe(fn) {
    subs.add(fn);
    fn(state);
    return () => subs.delete(fn);
  }
  return { get, set, subscribe };
}
/**
 * modal.js (增强版 v3)
 * - 自动创建根节点 (#modalRoot / #modalBackdropRoot)（与业务 overlayRoot 分离）
 * - 若 id 已存在，则直接 open()（re-mount & 加入栈），不再静默 return
 * - 禁止遮罩点击与 ESC 关闭
 * - repairIfDetached: wrap 或 backdrop 被外部删除时自动恢复
 * - 提供 closeAllModals()
 * - 调试: enableModalDebug()
 *
 * 注意：index.html 中保留原来的 #modalRoot，如无 #modalBackdropRoot 会自动创建。
 */

const MODAL_ROOT_ID = 'modalRoot';
const BACKDROP_ROOT_ID = 'modalBackdropRoot'; // 与业务 overlayRoot 分离

let seq = 0;
const registry = new Map();   // id -> api
const modalStack = [];        // 栈顶为最后打开
let debug = false;

export function enableModalDebug(){ debug = true; }
export function disableModalDebug(){ debug = false; }

export function createModal(options = {}) {
  ensureRoots();

  const {
    id = genId(),
    title = '',
    content = '',
    width = 600,
    footerButtons = []
  } = options;

  let existed = registry.get(id);
  if (existed) {
    if (debug) console.warn('[modal] id exists -> reopen', id);
    repairIfDetached(existed);
    existed.open(); // 直接 reopen
    return existed;
  }

  const modalRoot = document.getElementById(MODAL_ROOT_ID);
  const backdropRoot = document.getElementById(BACKDROP_ROOT_ID);

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-overlay locked';

  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.style.width = width + 'px';

  const header = document.createElement('div');
  header.className = 'modal__header';
  header.innerHTML = `<div class="modal__title">${escapeHTML(title)}</div>`;

  const body = document.createElement('div');
  body.className = 'modal__body';
  if (typeof content === 'string') body.innerHTML = content;
  else if (content instanceof HTMLElement) body.appendChild(content);

  const footer = document.createElement('div');
  footer.className = 'modal__footer';
  footerButtons.forEach(btn => {
    const b = document.createElement('button');
    b.className = 'btn ' + (btn.primary ? 'btn-primary' : '');
    b.textContent = btn.text;
    b.addEventListener('click', () => {
      try { btn.onClick && btn.onClick(close, api); }
      catch (e) { console.error('[modal] button handler error', e); }
    });
    footer.appendChild(b);
  });

  wrap.appendChild(header);
  wrap.appendChild(body);
  wrap.appendChild(footer);

  function escBlock(e){
    if (e.key === 'Escape'){
      e.preventDefault();
      e.stopPropagation();
      if (debug) console.log('[modal] ESC blocked', id);
    }
  }

  function mount(){
    backdropRoot.appendChild(backdrop);
    modalRoot.appendChild(wrap);
    document.body.classList.add('modal-open');
    window.addEventListener('keydown', escBlock, true);
  }

  function open(){
    if (debug) console.log('[modal] open()', id);
    if (!document.contains(backdrop) || !document.contains(wrap)){
      if (debug) console.log('[modal] remount lost elements', id);
      mount();
    } else {
      // 首次 或 再次 open 都 mount（再次 open 作用：置顶/重复 backdrop）
      mount();
    }
    if (!registry.has(id)) registry.set(id, api);
    modalStack.push(id);
    return api;
  }

  function close(){
    if (debug) console.log('[modal] close()', id);
    try { backdrop.remove(); } catch {}
    try { wrap.remove(); } catch {}
    window.removeEventListener('keydown', escBlock, true);
    const idx = modalStack.lastIndexOf(id);
    if (idx >= 0) modalStack.splice(idx,1);
    registry.delete(id);
    if (modalStack.length === 0) {
      document.body.classList.remove('modal-open');
    }
  }

  const api = { id, open, close, body, header, footer, backdrop, wrap };
  registry.set(id, api); // 先登记，防 race
  return api.open();
}

export function getModal(id){
  const api = registry.get(id);
  if (!api) return null;
  repairIfDetached(api);
  return api;
}

export function listOpenModals(){
  return modalStack.slice();
}

export function closeAllModals(){
  [...registry.keys()].forEach(id => {
    try { registry.get(id).close(); } catch {}
  });
}

function repairIfDetached(api){
  if (!api) return;
  if (!document.contains(api.wrap) || !document.contains(api.backdrop)){
    if (debug) console.log('[modal] repair detach', api.id);
    ensureRoots();
    const modalRoot = document.getElementById(MODAL_ROOT_ID);
    const backdropRoot = document.getElementById(BACKDROP_ROOT_ID);
    backdropRoot.appendChild(api.backdrop);
    modalRoot.appendChild(api.wrap);
    if (!modalStack.includes(api.id)) modalStack.push(api.id);
    document.body.classList.add('modal-open');
  }
}

function ensureRoots(){
  let modalRoot = document.getElementById(MODAL_ROOT_ID);
  let backdropRoot = document.getElementById(BACKDROP_ROOT_ID);
  let created = false;
  if (!modalRoot){
    modalRoot = document.createElement('div');
    modalRoot.id = MODAL_ROOT_ID;
    document.body.appendChild(modalRoot);
    created = true;
  }
  if (!backdropRoot){
    backdropRoot = document.createElement('div');
    backdropRoot.id = BACKDROP_ROOT_ID;
    document.body.appendChild(backdropRoot);
    created = true;
  }
  if (created && debug) console.log('[modal] roots created');
}

function genId(){ return 'm_'+Date.now()+'_'+(++seq); }

function escapeHTML(str=''){
  return str.replace(/[&<>"']/g, c=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

if (typeof window !== 'undefined'){
  window.enableModalDebug = enableModalDebug;
  window.disableModalDebug = disableModalDebug;
  window.__modalList = listOpenModals;
  window.__getModal = getModal;
  window.__closeAllModals = closeAllModals;
}
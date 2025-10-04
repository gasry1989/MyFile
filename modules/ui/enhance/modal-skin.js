// modal-skin.js
// 作用：对运行时挂载到 #modalRoot 的 .modal 统一打上皮肤类，匹配 beautify-batch3.css
// 映射：.modal           -> .device-popup
//       .modal__header   -> .dp-header
//       .modal__body     -> .dp-body
// 兼容：不改业务逻辑，不依赖具体弹窗实现；重复处理安全。
(function(){
  function skinOne(modalEl){
    if (!modalEl || modalEl.__skinned) return;
    modalEl.classList.add('device-popup');
    const header = modalEl.querySelector('.modal__header');
    const body   = modalEl.querySelector('.modal__body');
    if (header) header.className = 'dp-header';
    if (body)   body.className   = 'dp-body';
    modalEl.__skinned = true;
  }

  function scanExisting(){
    const root = document.getElementById('modalRoot');
    if (!root) return;
    root.querySelectorAll('.modal').forEach(skinOne);
  }

  function observe(){
    const root = document.getElementById('modalRoot');
    if (!root || root.__modalSkinObserved) return;
    root.__modalSkinObserved = true;
    const mo = new MutationObserver((muts)=>{
      for (const m of muts){
        m.addedNodes && m.addedNodes.forEach(n=>{
          if (n && n.nodeType===1){
            if (n.classList.contains('modal')) skinOne(n);
            n.querySelectorAll && n.querySelectorAll('.modal').forEach(skinOne);
          }
        });
      }
    });
    mo.observe(root, { childList:true, subtree:true });
  }

  document.addEventListener('DOMContentLoaded', ()=>{ scanExisting(); observe(); });
  window.addEventListener('hashchange', ()=>{ setTimeout(scanExisting, 80); });
  setTimeout(()=>{ scanExisting(); observe(); }, 150);
})();
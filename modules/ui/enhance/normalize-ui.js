(function(){
  function normalize(root){
    if (!root) return;
    // 1) 按钮统一
    root.querySelectorAll('button:not(.btn)').forEach(btn=>{
      btn.classList.add('btn');
    });
    root.querySelectorAll('button[data-variant="primary"], button.primary, button[data-primary="1"]').forEach(btn=>{
      btn.classList.add('btn','btn-primary');
    });
    // 2) 右侧容器统一
    root.querySelectorAll('.right:not(.sp-status)').forEach(el=>{
      el.classList.add('sp-status');
    });
  }
  function scan(){
    const main = document.getElementById('mainView');
    if (main) normalize(main);
  }
  function observe(){
    const main = document.getElementById('mainView');
    if (!main || main.__uiNormalizedObserved) return;
    main.__uiNormalizedObserved = true;
    const mo = new MutationObserver((muts)=>{
      for (const m of muts){
        m.addedNodes && m.addedNodes.forEach(n=>{
          if (n && n.nodeType===1) normalize(n);
        });
      }
    });
    mo.observe(main, { childList:true, subtree:true });
  }
  document.addEventListener('DOMContentLoaded', ()=>{ scan(); observe(); });
  window.addEventListener('hashchange', ()=>{ setTimeout(scan, 80); });
  setTimeout(()=>{ scan(); observe(); }, 120);
})();
import './modal-skin.js';
import './normalize-ui.js';

(function(){
  function apply(){
    const root=document.getElementById('mediaGrid');
    if(!root) return;
    if(root.__gridActiveBound) return;
    root.__gridActiveBound=true;
    root.addEventListener('click',e=>{
      const cell=e.target.closest('.sp-cell');
      if(!cell) return;
      document.querySelectorAll('.sp-cell-active').forEach(c=>c!==cell&&c.classList.remove('sp-cell-active'));
      cell.classList.add('sp-cell-active');
    },true);
  }
  apply();
  window.addEventListener('hashchange',()=>setTimeout(apply,120));
  document.addEventListener('DOMContentLoaded',()=>setTimeout(apply,300));
  setTimeout(apply,800);
})();
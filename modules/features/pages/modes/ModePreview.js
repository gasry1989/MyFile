/**
 * 模式预览 - 模板化
 */
export function createModePreview({ modeId, devId } = {}) {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });

  (async () => {
    const frag = await (await fetch('/modules/features/pages/modes/mode-preview.html', { cache: 'no-cache' })
      .then(r=>r.text()).then(t=> new DOMParser().parseFromString(t, 'text/html')))
      .querySelector('#tpl-mode-preview').content.cloneNode(true);
    root.appendChild(frag);
  })();

  let timer=null;
  const api={
    start(){
      if (timer) return;
      let s={x:0,y:0,z:0,m:0,b:100};
      const set=(id,v)=>{ const el=root.getElementById(id); if(el) el.textContent=v; };
      timer=setInterval(()=>{
        s.x=clamp(s.x+rand(-0.05,0.05),-5,5);
        s.y=clamp(s.y+rand(-0.05,0.05),-5,5);
        s.z=clamp(s.z+rand(-0.05,0.05),-5,5);
        s.m=Math.max(0, s.m+rand(0.001,0.003));
        if (s.b>0 && Math.random()<0.03) s.b-=1;
        set('mx',s.x.toFixed(2)); set('my',s.y.toFixed(2)); set('mz',s.z.toFixed(2)); set('mm',s.m.toFixed(3)); set('mb',s.b+'%');
      },200);
    },
    destroy(){ try{ timer&&clearInterval(timer);}catch{} timer=null; try{ host.remove(); }catch{} },
    el: host
  };
  function rand(a,b){return Math.random()*(b-a)+a;}
  function clamp(v,min,max){return v<min?min:v>max?max:v;}
  return api;
}
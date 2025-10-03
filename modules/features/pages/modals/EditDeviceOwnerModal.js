import { apiDeviceUpdateInfo } from '@api/deviceApi.js';
import { apiUserQuery } from '@api/userApi.js';
import { showToast } from '@ui/toast.js';

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function buildStylescope(container) {
  container.style.position = 'fixed';
  container.style.inset = '0';
  container.style.left = '0';
  container.style.top = '0';
  container.style.right = '0';
  container.style.bottom = '0';
  container.style.background = 'rgba(0,0,0,.45)';
  container.style.display = 'flex';
  container.style.alignItems = 'center';
  container.style.justifyContent = 'center';
  container.style.zIndex = '9999';
}

function debounce(fn, delay = 300) {
  let t = 0;
  return function(...args){
    clearTimeout(t);
    t = setTimeout(()=> fn.apply(this, args), delay);
  };
}

function getToast() {
  try {
    if (window.parent && window.parent !== window && window.parent.__toast && typeof window.parent.__toast.show === 'function') {
      return window.parent.__toast.show;
    }
  } catch {}
  return showToast;
}

export function openEditDeviceOwnerModal({ dev }) {
  return new Promise((resolve) => {
    const mask = el('div');
    buildStylescope(mask);

    const panel = el('div', {
      class: 'owner-modal',
      style: {
        width: '560px',
        background: '#0c141c',
        border: '1px solid #22313f',
        borderRadius: '8px',
        color: '#e6f0ff',
        boxShadow: '0 12px 32px rgba(0,0,0,.5)'
      }
    });

    // 局部滚动条样式（深色）
    const style = el('style', {}, `
.owner-modal .owner-list { scrollbar-width: thin; scrollbar-color: #2a3a4a #0d1620; }
.owner-modal .owner-list::-webkit-scrollbar { width: 10px; height: 10px; }
.owner-modal .owner-list::-webkit-scrollbar-track { background: #0d1620; border-left: 1px solid #22313f; }
.owner-modal .owner-list::-webkit-scrollbar-thumb { background: #2a3a4a; border-radius: 6px; border: 1px solid #3b5064; }
.owner-modal .owner-list::-webkit-scrollbar-thumb:hover { background: #37516a; }
    `);
    panel.appendChild(style);

    const header = el('div', {
      style: {
        padding: '14px 16px',
        borderBottom: '1px solid #22313f',
        fontWeight: '700',
        fontSize: '16px',
        textAlign: 'center'
      }
    }, '修改设备属主');

    const body = el('div', { style: { padding: '16px 18px', fontSize: '14px' } });
    const row = (label, control) => el('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr', alignItems: 'center', gap: '8px', margin: '10px 0' } }, [
      el('div', {}, label),
      control
    ]);

    const lblId = el('div', {}, String(dev?.id ?? ''));
    const lblNo = el('div', {}, String(dev?.no ?? ''));
    const lblName = el('div', {}, String(dev?.name ?? ''));

    const inpQuery = el('input', {
      type: 'text',
      placeholder: '根据名称或ID查找用户,例如输入user',
      style: { width: '100%', padding: '6px 8px', borderRadius: '4px', border: '1px solid #334', background: '#0a0f14', color: '#e6f0ff' }
    });

    const list = el('select', {
      class: 'owner-list',
      size: '10',
      style: {
        width: '100%',
        height: '240px',
        borderRadius: '6px',
        border: '1px solid #334',
        background: '#0a0f14',
        color: '#e6f0ff',
        padding: '6px',
        outline: 'none'
      }
    });

    body.appendChild(row('设备ID：', lblId));
    body.appendChild(row('设备编号：', lblNo));
    body.appendChild(row('设备名称：', lblName));
    body.appendChild(row('所属用户：', inpQuery));
    body.appendChild(list);

    const footer = el('div', {
      style: {
        padding: '14px 16px',
        display: 'flex',
        gap: '12px',
        justifyContent: 'center',
        borderTop: '1px solid #22313f'
      }
    });
    const btnOk = el('button', { class: 'btn' }, '确认');
    const btnCancel = el('button', {
      class: 'btn',
      style: { background: 'transparent', color: '#e6f0ff', border: '1px solid rgba(255,255,255,.25)' }
    }, '取消');
    footer.appendChild(btnOk);
    footer.appendChild(btnCancel);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(footer);
    mask.appendChild(panel);
    document.body.appendChild(mask);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function close(result) {
      try { document.body.removeChild(mask); } catch {}
      document.body.style.overflow = prevOverflow;
      resolve(result);
    }
    // 严格模态：仅确认/取消可关闭
    btnCancel.addEventListener('click', () => close(false));

    const toast = getToast();

    // 原属主信息
    const originOwnerId = Number(dev?.parentUserId ?? dev?.ownerUserId ?? 0);
    const originOwnerAcc = String(dev?.parentUserAccount ?? dev?.ownerUserAccount ?? '');
    const originOwnerName = String(dev?.parentUserName ?? dev?.ownerUserName ?? '');
    const originDisplay = [originOwnerId || '', originOwnerAcc || '', originOwnerName || ''].filter(Boolean).join(' ');

    let suppressSearch = false;
    let programmaticInput = false;
    let dirty = false;
    let selectedUserId = 0;

    if (originOwnerId) {
      suppressSearch = true;
      programmaticInput = true;
      inpQuery.value = originDisplay;
      selectedUserId = originOwnerId;
      setTimeout(()=>{ suppressSearch = false; programmaticInput = false; }, 0);
    }

    async function doSearch(q) {
      try {
        const resp = await apiUserQuery(q ?? '', 1, 50);
        const arr = resp?.list || resp?.users || resp?.data || [];
        list.innerHTML = '';
        for (const u of arr) {
          const id = Number(u?.id ?? u?.userId ?? 0);
          const acc = String(u?.account ?? u?.userAccount ?? u?.username ?? '');
          const name = String(u?.name ?? u?.nick ?? u?.realName ?? u?.displayName ?? '');
          if (!id) continue;
          const text = [id || '', acc || '', name || ''].filter(Boolean).join(' ');
          const opt = el('option', { value: String(id) }, text);
          list.appendChild(opt);
        }
        if (!list.options.length) {
          const opt = el('option', { value: '' }, '未找到匹配的用户');
          list.appendChild(opt);
        }
      } catch (e) {
        console.warn('[EditDeviceOwnerModal] 查询用户失败', e);
        toast({ type: 'error', message: '查询失败，请重试' });
      }
    }

    const onInput = debounce(() => {
      if (suppressSearch) return;
      dirty = dirty || !programmaticInput;
      const q = inpQuery.value?.trim() ?? '';
      if (!programmaticInput) selectedUserId = 0;
      doSearch(q);
    }, 300);

    inpQuery.addEventListener('input', onInput);

    list.addEventListener('change', () => {
      const id = Number(list.value || 0);
      if (!id) return;
      selectedUserId = id;
      const text = list.options[list.selectedIndex]?.text || String(id);
      suppressSearch = true;
      programmaticInput = true;
      inpQuery.value = text;
      dirty = true;
      setTimeout(()=>{ suppressSearch = false; programmaticInput = false; }, 0);
    });

    btnOk.addEventListener('click', async () => {
      try {
        btnOk.disabled = true;

        if (!dirty) {
          await apiDeviceUpdateInfo({ id: Number(dev?.id), parentUserId: originOwnerId || undefined });
          toast({ type: 'success', message: '保存成功' });
          close(true);
          return;
        }

        if (!selectedUserId) {
          toast({ type: 'warn', message: '请从列表中选择一个用户' });
          btnOk.disabled = false;
          return;
        }

        await apiDeviceUpdateInfo({ id: Number(dev?.id), parentUserId: selectedUserId });
        toast({ type: 'success', message: '保存成功' });
        close(true);
      } catch (e) {
        console.warn('[EditDeviceOwnerModal] 提交失败', e);
        getToast()({ type: 'error', message: '保存失败，请重试' });
        btnOk.disabled = false;
      }
    });
  });
}
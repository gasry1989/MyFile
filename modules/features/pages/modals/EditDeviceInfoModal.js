import { apiDevTypes, apiDevModes, apiDeviceUpdateInfo } from '@api/deviceApi.js';
import { showToast } from '@ui/toast.js';
import { eventBus } from '@core/eventBus.js'; // 新增：直接使用同 iframe 内的全局事件总线

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

function getToast() {
  try {
    if (window.parent && window.parent !== window && window.parent.__toast && typeof window.parent.__toast.show === 'function') {
      return window.parent.__toast.show;
    }
  } catch {}
  return showToast;
}

export function openEditDeviceInfoModal({ dev }) {
  return new Promise(async (resolve) => {
    const mask = el('div');
    buildStylescope(mask);

    const panel = el('div', {
      class: 'modal-panel',
      style: {
        width: '520px',
        background: '#0c141c',
        border: '1px solid #22313f',
        borderRadius: '8px',
        color: '#e6f0ff',
        boxShadow: '0 12px 32px rgba(0,0,0,.5)'
      }
    });

    const header = el('div', {
      style: {
        padding: '14px 16px',
        borderBottom: '1px solid #22313f',
        fontWeight: '700',
        fontSize: '16px',
        textAlign: 'center'
      }
    }, '修改设备信息');

    const body = el('div', { style: { padding: '16px 18px', fontSize: '14px' } });

    const row = (label, control) => el('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr', alignItems: 'center', gap: '8px', margin: '10px 0' } }, [
      el('div', {}, label),
      control
    ]);

    const lblId = el('div', {}, String(dev?.id ?? ''));
    const lblNo = el('div', {}, String(dev?.no ?? ''));
    const inpName = el('input', { type: 'text', value: dev?.name ?? '', style: { width: '100%', padding: '6px 8px', borderRadius: '4px', border: '1px solid #334', background: '#0a0f14', color: '#e6f0ff' } });

    const selType = el('select', { style: { width: '100%', padding: '6px 8px', borderRadius: '4px', border: '1px solid #334', background: '#0a0f14', color: '#e6f0ff' } });
    const modesBox = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr', gap: '6px' } });

    body.appendChild(row('设备ID：', lblId));
    body.appendChild(row('设备编号：', lblNo));
    body.appendChild(row('设备名称：', inpName));
    body.appendChild(row('设备类型：', selType));
    body.appendChild(el('div', { style: { marginTop: '10px', marginBottom: '6px', fontWeight: '600' } }, '设备模式：'));
    body.appendChild(modesBox);

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

    btnCancel.addEventListener('click', () => close(false));

    const toast = getToast();

    // 加载类型 & 模式
    let typeList = [];
    let modeList = [];
    try {
      const [typesResp, modesResp] = await Promise.all([apiDevTypes(), apiDevModes()]);
      const rawTypes = Array.isArray(typesResp?.devTypeList) ? typesResp.devTypeList : [];
      const rawModes = Array.isArray(modesResp?.devModeList) ? modesResp.devModeList : [];
      typeList = rawTypes.map(x => ({
        id: Number(x?.typeId ?? 0),
        name: String(x?.typeName ?? '')
      })).filter(x => x.id && x.name);
      modeList = rawModes.map(x => ({
        id: Number(x?.modeId ?? 0),
        name: String(x?.modeName ?? '')
      })).filter(x => x.id && x.name);
    } catch (e) {
      console.warn('[EditDeviceInfoModal] 加载类型/模式失败', e);
      toast({ type: 'error', message: '加载类型/模式失败' });
    }

    selType.innerHTML = '';
    for (const t of typeList) {
      const opt = el('option', { value: String(t.id) }, t.name);
      selType.appendChild(opt);
    }
    if (selType.options.length > 0) selType.selectedIndex = 0;

    modesBox.innerHTML = '';
    for (const m of modeList) {
      const idStr = String(m.id);
      const cb = el('input', { type: 'checkbox', disabled: true, 'data-mode-id': idStr, id: `mode_${idStr}` });
      const lab = el('label', { for: `mode_${idStr}` }, ` ${m.name}`);
      const line = el('div', {}, [cb, lab]);
      modesBox.appendChild(line);
    }

    // 回显
    const currentTypeId = Number(dev?.type ?? 0);
    if (currentTypeId && typeList.length) {
      const idx = typeList.findIndex(t => t.id === currentTypeId);
      if (idx >= 0) selType.selectedIndex = idx;
    }
    const currentModeIds = new Set(
      Array.isArray(dev?.modeList)
        ? dev.modeList.map(m => Number(m?.id ?? m?.modeId ?? m)).filter(Boolean)
        : []
    );
    modesBox.querySelectorAll('input[type=checkbox][data-mode-id]').forEach(cb => {
      const mid = Number(cb.getAttribute('data-mode-id'));
      cb.checked = currentModeIds.has(mid);
    });

    // 提交
    btnOk.addEventListener('click', async () => {
      try {
        btnOk.disabled = true;
        const name = inpName.value?.trim() ?? '';
        const type = Number(selType.value || 0);
        const chosenIds = [];
        modesBox.querySelectorAll('input[type=checkbox][data-mode-id]').forEach(cb => {
          if (cb.checked) chosenIds.push(Number(cb.getAttribute('data-mode-id')));
        });

        const payload = {
          id: Number(dev?.id),
          name,
          type,
          modeList: chosenIds
        };
        await apiDeviceUpdateInfo(payload);
        toast({ type: 'success', message: '保存成功' });

        // 派发同 iframe 内事件，detail-common.js 中 listener 会捕获刷新标题栏
        try {
          eventBus.emit('device:updated', { devId: payload.id });
        } catch(e){
          console.warn('[EditDeviceInfoModal] emit device:updated failed', e);
        }

        close(true);
      } catch (e) {
        console.warn('[EditDeviceInfoModal] 提交失败', e);
        getToast()({ type: 'error', message: '保存失败，请重试' });
        btnOk.disabled = false;
      }
    });
  });
}
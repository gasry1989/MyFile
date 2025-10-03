/**
 * TreePanel 设备树（Shadow DOM）- 模板化（多模式复选 + 汇总 + 默认未分组折叠）
 * 功能要点：
 *  - whenReady(): 模板加载完成后调用
 *  - setData({ userList, devList, ungroupedDevices, devTypes, devModes, ... })
 *  - getFilterValues(): { devType, devMode, devModeIdArr, searchStr, filterOnline }
 *    * devMode 为兼容旧代码（取第一个勾选的模式或 0）
 *    * devModeIdArr 为真正的多选结果，至少一个（UI 强制）
 *  - 顶部模式在线汇总：每个模式单独一行（按需求换行）
 *  - “未分组设备”默认折叠
 *  - 模式多选（复选框）至少保留一个勾选
 */
export function createTreePanel() {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });

  const ready = deferred();
  let isReady = false;

  function onFilterChanged(e) {
    const t = e && e.target;
    if (!t || !t.id) return;
    const ids = new Set(['fltDevType', 'fltDevMode', 'fltSearch', 'fltOnline']);
    if (!ids.has(t.id)) return;

    if (t.id === 'fltDevType') {
      const typeVal = Number(t.value || '0');
      refreshModeOptionsByType(typeVal); // 仅刷新 <select> 的兼容逻辑
    }

    host.dispatchEvent(new CustomEvent('filterchange', {
      bubbles: true,
      detail: getFilterValues()
    }));
    render();
  }

  function refreshModeOptionsByType(typeId) {
    const mSel = root.getElementById('fltDevMode');
    if (!mSel) return;

    const source = Array.isArray(mSel.__sourceAllModes)
      ? mSel.__sourceAllModes
      : (Array.from(mSel.options)
          .filter(o => o.value !== '0')
          .map(o => ({ modeId: Number(o.value), modeName: o.textContent || '' })));

    const prev = Number(mSel.value || '0');

    let allowIds;
    if (typeId === 0) allowIds = [1,2,3,4];
    else if (typeId === 4) allowIds = [4];
    else allowIds = [1,2,3];

    const opts = ['<option value="0">全部</option>'];
    source.forEach(m => {
      const mid = Number(m.modeId);
      if (allowIds.includes(mid)) {
        opts.push(`<option value="${mid}">${m.modeName}</option>`);
      }
    });
    mSel.innerHTML = opts.join('');
    mSel.value = (prev === 0 || allowIds.includes(prev)) ? String(prev) : '0';
  }

  (async () => {
    try {
      const html = await fetch('/modules/features/pages/components/tree-panel.html', { cache: 'no-cache' }).then(r => r.text());
      const frag = new DOMParser().parseFromString(html, 'text/html').querySelector('#tpl-tree-panel').content.cloneNode(true);
      root.appendChild(frag);

      root.addEventListener('input', onFilterChanged);
      root.addEventListener('change', onFilterChanged);

      isReady = true;
      ready.resolve(true);
      host.dispatchEvent(new Event('ready'));
    } catch (e) {
      ready.reject(e);
    }
  })();

  function buildForest(users, devList) {
    if (!Array.isArray(users)) users = [];
    if (!Array.isArray(devList)) devList = [];

    const id2node = new Map();
    users.forEach(u => {
      if (u && u.userId != null) {
        id2node.set(u.userId, {
          userId: u.userId,
          userName: u.userName || '',
          parentUserId: (u.parentUserId != null ? u.parentUserId : null),
          parentUserName: '',
          isOnline: !!u.onlineState,
          children: [],
          deviceChildren: []
        });
      }
    });

    devList.forEach(d => {
      const ownerId = d?.ownerUserId;
      const di = d?.devInfo || {};
      if (ownerId == null || !id2node.has(ownerId)) return;
      id2node.get(ownerId).deviceChildren.push({
        devId: di.id,
        devName: di.name || di.no || String(di.id || ''),
        onlineState: !!di.onlineState,
        raw: di
      });
    });

    id2node.forEach(n => {
      const pid = n.parentUserId;
      if (pid != null && pid !== n.userId && id2node.has(pid)) {
        id2node.get(pid).children.push(n);
      }
    });

    const roots = [];
    id2node.forEach(n => {
      const isRoot = (n.parentUserId == null) || !id2node.has(n.parentUserId);
      if (isRoot) roots.push(n);
    });
    return roots;
  }

  function renderUserNodeHTML(node, level, expandLevel) {
    const name = (node.userName || '').trim();
    const expanded = level <= expandLevel;
    const cls = node.isOnline ? 'is-online' : 'is-offline';

    if (!name) {
      const childHTML = (node.children || []).map(c => renderUserNodeHTML(c, level, expandLevel)).join('');
      const devHTML = (node.deviceChildren || []).map(d => `
          <div class="node dev ${d.onlineState ? 'is-online' : 'is-offline'}" data-devid="${d.devId}">
            <span class="ic-dev"></span>
            <span class="title" title="${escapeHTML(d.devName)}">${escapeHTML(d.devName)}</span>
          </div>
        `).join('');
      return childHTML + devHTML;
    }

    const childrenUsersHTML = (node.children || []).map(c => renderUserNodeHTML(c, level + 1, expandLevel)).join('');
    const devicesHTML = (node.deviceChildren || []).map(d => `
          <div class="node dev ${d.onlineState ? 'is-online' : 'is-offline'}" data-devid="${d.devId}">
            <span class="ic-dev"></span>
            <span class="title" title="${escapeHTML(d.devName)}">${escapeHTML(d.devName)}</span>
          </div>
        `).join('');
    const hasChildren = !!(childrenUsersHTML || devicesHTML);

    const head = `
      <div class="row ${cls}" data-node-type="user" data-user-id="${node.userId}">
        <span class="toggle ${hasChildren ? '' : 'is-empty'}">${hasChildren ? (expanded ? '▾' : '▸') : ''}</span>
        <span class="ic-user"></span>
        <span class="title" title="${escapeHTML(name)}">${escapeHTML(name)}</span>
      </div>`;
    const children = hasChildren ? `
      <div class="children ${expanded ? '' : 'is-collapsed'}">
        ${childrenUsersHTML}${devicesHTML}
      </div>` : '';
    return `<div class="node user" data-user-id="${node.userId}">${head}${children}</div>`;
  }

  function render() {
    const treeEl = root.getElementById('tree');
    if (!treeEl) return;

    const expandLevel = state.expandLevel || 2;

    // 模式汇总（每行一个模式）
    const summaryMap = {
      1: { name: '位移(1通道)', online: 0, total: 0 },
      2: { name: '位移(2通道)', online: 0, total: 0 },
      3: { name: '音频微震(1通道)', online: 0, total: 0 },
      4: { name: '音视频', online: 0, total: 0 }
    };
    (state.devList || []).forEach(d => {
      const di = d?.devInfo || {};
      const online = !!di.onlineState;
      const modes = Array.isArray(di.modeList) ? di.modeList : [];
      const seen = new Set();
      modes.forEach(m => {
        const mid = Number(m.modeId);
        if (summaryMap[mid] && !seen.has(mid)) {
          summaryMap[mid].total++;
          if (online) summaryMap[mid].online++;
          seen.add(mid);
        }
      });
    });
    const summaryHTML = `<div style="border:1px solid rgba(255,255,255,.15);padding:6px 8px;margin:6px 8px 10px;border-radius:4px;font-size:12px;line-height:1.5;">
      ${Object.keys(summaryMap).map(k => {
        const s = summaryMap[k];
        return `<div>${s.name}: ${s.online}/${s.total}</div>`;
      }).join('')}
    </div>`;

    const roots = buildForest(state.userList, state.devList);

    const showUngrouped = !state.hideUngrouped;
    const ungrouped = showUngrouped ? state.ungroupedDevices : [];
    const secCls = state.ungroupedCollapsed ? 'is-collapsed' : '';

    const ungroupedSection = showUngrouped ? `
      <div class="sec ${secCls}">
        <div class="sec__title">未分组设备 (${ungrouped.length})</div>
        <div class="list">
          ${ungrouped.map(e => {
            const d = e.devInfo || {};
            const name = d.name || d.no || String(d.id || '');
            const cls = d.onlineState ? 'is-online' : 'is-offline';
            return `<div class="chip ${cls}" data-devid="${d.id}" title="${escapeHTML(name)}">
              <span class="ic-dev"></span><span class="title">${escapeHTML(name)}</span>
            </div>`;
          }).join('')}
        </div>
      </div>` : '';

    treeEl.innerHTML = summaryHTML + `
      <div class="gdt">${roots.map(r => renderUserNodeHTML(r, 1, expandLevel)).join('')}</div>
      ${ungroupedSection}`;
  }

  let state = {
    groupedDevices: [],
    userList: [],
    devList: [],
    ungroupedDevices: [],
    expandLevel: 2,
    ungroupedCollapsed: true,  // 默认折叠
    hideUngrouped: false
  };

  function setData({
    userList = [],
    devList = [],
    ungroupedDevices = [],
    expandLevel = 2,
    devTypes,
    devModes,
    hideUngrouped
  } = {}) {
    state.userList = userList;
    state.devList = devList;
    state.ungroupedDevices = ungroupedDevices;
    state.expandLevel = expandLevel;
    if (typeof hideUngrouped === 'boolean') state.hideUngrouped = hideUngrouped;

    const apply = () => {
      if (devTypes) {
        const sel = root.getElementById('fltDevType');
        if (sel) {
          const cur = sel.value;
          sel.innerHTML = `<option value="0">全部</option>` + devTypes.map(t => `<option value="${t.typeId}">${t.typeName}</option>`).join('');
          sel.value = cur || '0';
        }
      }
      if (devModes) {
        let box = root.getElementById('fltDevModeBox');
        const sel = root.getElementById('fltDevMode');
        if (!box && sel) {
          box = document.createElement('div');
          box.id = 'fltDevModeBox';
          box.style.display='flex';
          box.style.flexWrap='wrap';
          box.style.gap='6px';
          sel.parentElement.insertBefore(box, sel);
          sel.style.display='none';
        }
        if (box) {
          box.innerHTML = devModes.map(m => `
            <label style="font-weight:normal;font-size:12px;display:inline-flex;align-items:center;gap:4px;">
              <input type="checkbox" class="__modeChk" data-mid="${m.modeId}" checked />
              <span>${m.modeName}</span>
            </label>
          `).join('');
          box.addEventListener('change', function (e) {
            if (!e.target.classList.contains('__modeChk')) return;
            const all = Array.from(box.querySelectorAll('input.__modeChk'));
            const checked = all.filter(i => i.checked);
            if (checked.length === 0) { e.target.checked = true; return; }
            host.dispatchEvent(new CustomEvent('filterchange', {
              bubbles: true,
              detail: getFilterValues()
            }));
          }, { passive: true });
        }
        if (sel) {
          sel.__sourceAllModes = devModes.slice ? devModes.slice() : devModes;
        }
      }
      render();
    };
    if (isReady) apply(); else ready.promise.then(apply).catch(()=>{});
  }

  function getFilterValues() {
    const tSel = root.getElementById('fltDevType');
    const sInp = root.getElementById('fltSearch');
    const cChk = root.getElementById('fltOnline');
    const devType = Number((tSel && tSel.value) || '0');
    const searchStr = (sInp && sInp.value ? sInp.value.trim() : '');
    const filterOnline = !!(cChk && cChk.checked);
    let devModeIdArr = [];
    const box = root.getElementById('fltDevModeBox');
    if (box) {
      devModeIdArr = Array.from(box.querySelectorAll('input.__modeChk'))
        .filter(i => i.checked)
        .map(i => Number(i.getAttribute('data-mid')))
        .filter(Boolean);
    }
    if (devModeIdArr.length === 0) devModeIdArr = [1,2,3,4];
    const devMode = devModeIdArr[0] || 0;
    return { devType, devMode, devModeIdArr, searchStr, filterOnline };
  }

  const controls = {
    typeSelect: () => root.getElementById('fltDevType'),
    modeSelect: () => root.getElementById('fltDevMode'), // 兼容旧调用
    searchInput: () => root.getElementById('fltSearch'),
    onlyOnlineCheckbox: () => root.getElementById('fltOnline')
  };

  function escapeHTML(str = '') {
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;','<': '&lt;','>':'&gt;','"': '&quot;',"'": '&#39;'
    }[c] || c));
  }
  function deferred(){ let resolve, reject; const promise = new Promise((res, rej)=>{ resolve=res; reject=rej; }); return { promise, resolve, reject }; }

  host.setData = setData;
  host.getFilterValues = getFilterValues;
  host.controls = controls;
  host.whenReady = () => ready.promise;
  host.isReady = () => isReady;

  root.addEventListener('click', (e) => {
    const secTitle = e.target.closest('.sec__title');
    if (secTitle) {
      state.ungroupedCollapsed = !state.ungroupedCollapsed;
      render();
      return;
    }
    const row = e.target.closest('.row[data-node-type="user"]');
    if (row) {
      const nodeEl = row.parentElement;
      const kids = nodeEl.querySelector(':scope > .children');
      const toggle = row.querySelector('.toggle');
      if (kids) {
        const collapsed = kids.classList.toggle('is-collapsed');
        if (toggle) toggle.textContent = collapsed ? '▸' : '▾';
      }
      return;
    }
    const devEl = e.target.closest('.node.dev,[data-devid].chip');
    if (devEl) {
      const devId = Number(devEl.getAttribute('data-devid'));
      host.dispatchEvent(new CustomEvent('deviceclick', { bubbles: true, detail: { devId } }));
    }
  });

  return host;
}

function deferred(){ let resolve, reject; const promise = new Promise((res, rej)=>{ resolve=res; reject=rej; }); return { promise, resolve, reject }; }
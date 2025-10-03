import { createModal, getModal } from '@ui/modal.js';
import { apiUserChangePassword } from '@api/userApi.js';
import { eventBus } from '@core/eventBus.js';
import { authState } from '@core/auth.js';
import { importTemplate } from '@ui/templateLoader.js';

let modalRef = null;

export async function showPasswordModal(user) {
  const exist = getModal('passwordModal');
  if (exist) { exist.open(); return; }

  const current = authState.get().userInfo;
  const selfChange = current && current.userId === user.userId;

  // 载入模板
  let frag;
  try {
    frag = await importTemplate('/modules/features/pages/modals/password-modal.html', 'tpl-password-modal');
  } catch (e) {
    console.error('[PasswordModal] template load failed', e);
    return;
  }

  // 注入动态文本/显隐
  const root = document.createElement('div');
  root.className = 'password-modal';
  root.appendChild(frag);

  const rootScope = root.querySelector('.password-modal-root');
  rootScope.querySelector('#pwdUserInfo').value = `${escapeHTML(user.userAccount || '')} (${user.userId})`;

  if (selfChange) {
    rootScope.querySelector('#oldPwdBlock').style.display = '';
    const li = document.createElement('li');
    li.textContent = '本人修改需输入旧密码';
    rootScope.querySelector('#pwdRulesList').prepend(li);
  }

  modalRef = createModal({
    id: 'passwordModal',
    title: '修改密码',
    width: 480,
    content: root,
    footerButtons: []
  });
  if (!modalRef) return;

  const form = modalRef.body.querySelector('#pwdForm');
  const oldPwd = form.querySelector('input[name=oldpwd]');
  const pwd1 = form.querySelector('input[name=pwd1]');
  const pwd2 = form.querySelector('input[name=pwd2]');
  const submitBtn = form.querySelector('#btnPwdSubmit');
  const tipsEl = form.querySelector('#pwdInlineMsg');
  const strengthBar = form.querySelector('#pwdStrengthBar');
  const strengthLabel = form.querySelector('#pwdStrengthLabel');

  form.querySelectorAll('.pwd-eye').forEach(btn => {
    btn.addEventListener('click', () => toggleVisibility(btn));
  });

  const genBtn  = form.querySelector('#btnGenPwd');
  const copyBtn = form.querySelector('#btnCopyPwd');

  genBtn.addEventListener('click', async () => {
    const newPwd = generateStrongPassword(12);
    pwd1.value = newPwd;
    pwd2.value = newPwd;
    triggerValidate();
    try {
      await copyToClipboard(newPwd);
      eventBus.emit('toast:show', { type:'info', message:'已生成并复制' });
    } catch {
      eventBus.emit('toast:show', { type:'warn', message:'已生成，复制失败，请手动复制' });
    }
  });

  copyBtn.addEventListener('click', async () => {
    if (!pwd1.value) {
      eventBus.emit('toast:show', { type:'warn', message:'无可复制密码' });
      return;
    }
    try {
      await copyToClipboard(pwd1.value);
      eventBus.emit('toast:show', { type:'success', message:'已复制密码' });
    } catch {
      eventBus.emit('toast:show', { type:'error', message:'复制失败，请手动复制' });
    }
  });

  pwd1.addEventListener('input', triggerValidate);
  pwd2.addEventListener('input', triggerValidate);
  if (oldPwd) oldPwd.addEventListener('input', triggerValidate);

  form.querySelector('[data-close]').addEventListener('click', () => {
    modalRef.close(); modalRef = null;
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    if (submitBtn.disabled) return;
    const newPwd = pwd1.value.trim();
    const oldPwdVal = oldPwd ? oldPwd.value.trim() : '';
    apiUserChangePassword(user.userId, newPwd, selfChange ? { oldPwd: oldPwdVal } : {})
      .then(() => {
        eventBus.emit('toast:show', { type:'success', message:'密码已更新' });
        modalRef.close(); modalRef = null;
      })
      .catch(err => {
        eventBus.emit('toast:show', { type:'error', message: err?.msg || '修改失败' });
      });
  });

  triggerValidate();

  function triggerValidate() {
    const vOld = oldPwd ? oldPwd.value : '';
    const v1 = pwd1.value;
    const v2 = pwd2.value;
    const { ok, msg, score, level } = validatePassword(v1, v2, selfChange, vOld);
    renderStrength(score, level);
    tipsEl.textContent = msg;
    tipsEl.className = 'pwd-inline-msg ' + (ok ? 'ok' : 'err');
    submitBtn.disabled = !ok;
  }
  function renderStrength(score, level) {
    const percent = Math.min(100, Math.round(score));
    strengthBar.style.width = percent + '%';
    strengthBar.dataset.level = level;
    strengthLabel.textContent = level ? level.toUpperCase() : '';
  }
}

function validatePassword(pwd1, pwd2, selfChange, oldPwdVal) {
  const res = { ok:false, msg:'', score:0, level:'' };
  if (selfChange && !oldPwdVal) { res.msg = '请输入旧密码'; return res; }
  if (!pwd1) { res.msg='请输入新密码'; return res; }
  if (pwd1.length < 8) { res.msg='新密码不足 8 位'; return res; }
  let classes = 0;
  if (/[a-z]/.test(pwd1)) classes++;
  if (/[A-Z]/.test(pwd1)) classes++;
  if (/\d/.test(pwd1)) classes++;
  if (/[^A-Za-z0-9]/.test(pwd1)) classes++;
  if (classes < 2) { res.msg='至少包含 2 类字符'; return res; }
  if (!pwd2) { res.msg='请再次输入确认密码'; return res; }
  if (pwd1 !== pwd2) { res.msg='两次密码不一致'; return res; }
  let score = Math.min(60, pwd1.length * 4);
  score += (classes - 2) * 15;
  if (/([A-Za-z0-9])\1{2,}/.test(pwd1)) score -= 10;
  score = Math.max(0, Math.min(100, score));
  let level = '弱'; if (score >= 75) level = '强'; else if (score >= 50) level = '中';
  res.ok = true; res.msg = '密码合法'; res.score = score; res.level = level;
  return res;
}

function toggleVisibility(btn) {
  const field = btn.parentElement.querySelector('input');
  if (!field) return;
  if (field.type === 'password') {
    field.type = 'text';
    btn.textContent = '🙈';
  } else {
    field.type = 'password';
    btn.textContent = '👁';
  }
}
function generateStrongPassword(len=12) {
  const pools = { upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower: 'abcdefghijkmnopqrstuvwxyz', digit: '23456789', symbol: '!@#$%^&*?_+-=~' };
  const pick = s => s[Math.floor(Math.random()*s.length)];
  let base = [pick(pools.upper), pick(pools.lower), pick(pools.digit), pick(pools.symbol)];
  const all = pools.upper + pools.lower + pools.digit + pools.symbol;
  while (base.length < len) base.push(pick(all));
  for (let i=base.length-1;i>0;i--) { const j = Math.floor(Math.random()*(i+1)); [base[i], base[j]] = [base[j], base[i]]; }
  return base.join('');
}
function copyToClipboard(text) {
  return new Promise(async (resolve, reject) => {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return resolve(true); } catch {}
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0';
      document.body.appendChild(ta);
      const selection = document.getSelection();
      const originalRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      ta.select();
      const ok = document.execCommand('copy');
      if (originalRange && selection) { selection.removeAllRanges(); selection.addRange(originalRange); } else { window.getSelection()?.removeAllRanges(); }
      ta.remove();
      if (ok) return resolve(true);
      return reject(new Error('execCommand copy failed'));
    } catch (err) { return reject(err); }
  });
}
function escapeHTML(str='') { return str.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
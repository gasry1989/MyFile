import { authLogin } from '../../core/auth.js';
import { eventBus } from '@core/eventBus.js';
import { importTemplate } from '@ui/templateLoader.js';

let captchaText = '';
let mounted = false;

export function mountLoginPage() {
  mounted = true;

  // 登录模式：隐藏侧栏 / 折叠按钮 / 头部登录按钮（保持原逻辑）
  const appLayout = document.getElementById('appLayout');
  appLayout && appLayout.classList.add('login-mode');
  const sideBar = document.getElementById('sideBar');
  if (sideBar) sideBar.style.display = 'none';
  const collapseBtn = document.querySelector('#sideBar .sb-collapse-btn');
  if (collapseBtn) collapseBtn.style.display = 'none';
  const headerLoginBtn = document.getElementById('headerLoginBtn');
  if (headerLoginBtn) headerLoginBtn.style.display = 'none';
  document.querySelectorAll('button, a').forEach(el => {
    if ((/登录/.test(el.textContent || '')) && !el.id) {
      el.style.display = 'none';
    }
  });

  // 占位并异步载入模板（不阻塞路由同步返回）
  const main = document.getElementById('mainView');
  main.innerHTML = `<div id="loginPageMount"></div>`;
  const mountPoint = main.querySelector('#loginPageMount');

  importTemplate('/modules/features/pages/login-page.html', 'tpl-login-page')
    .then(frag => {
      // 修复点：先获取元素，再安全赋值（不要用可选链在赋值左侧）
      const footer = frag.querySelector('.login-footer');
      if (footer) footer.innerHTML = `© ${new Date().getFullYear()} Company`;

      mountPoint.innerHTML = '';
      mountPoint.appendChild(frag);

      // 绑定交互（仅业务事件）
      const form = main.querySelector('#loginForm');
      form.addEventListener('submit', onSubmit);

      form.querySelector('.pwd-eye').addEventListener('click', togglePwdVisibility);
      form.querySelector('#btnCaptchaRefresh').addEventListener('click', generateCaptcha);
      form.querySelector('#captchaCanvas').addEventListener('click', generateCaptcha);

      generateCaptcha();
    })
    .catch(err => {
      console.error('[LoginPage] template load failed', err);
      // 简单回退：保持空白
    });

  return () => {};
}

export function unmountLoginPage() {
  mounted = false;
  // 还原（下次进入其他页面）
  const sideBar = document.getElementById('sideBar');
  if (sideBar) {
    sideBar.style.display = '';
  }
  const appLayout = document.getElementById('appLayout');
  appLayout && appLayout.classList.remove('login-mode');

  const headerLoginBtn = document.getElementById('headerLoginBtn');
  if (headerLoginBtn) headerLoginBtn.style.display = '';
  const collapseBtn = document.querySelector('#sideBar .sb-collapse-btn');
  if (collapseBtn) collapseBtn.style.display = '';
}

/* ---------------- 提交 ---------------- */
function onSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const acc = (fd.get('account') || '').trim();
  const pwd = (fd.get('pwd') || '').trim();
  const cap = (fd.get('captcha') || '').trim();

  const msgEl = form.querySelector('#loginInlineMsg');
  msgEl.textContent = '';
  msgEl.className = 'form-item inline-msg';

  if (!acc || !pwd || !cap) {
    msgEl.textContent = '请填写所有字段';
    msgEl.classList.add('err');
    return;
  }
  if (!validateCaptcha(cap)) {
    msgEl.textContent = '验证码错误';
    msgEl.classList.add('err');
    generateCaptcha();
    return;
  }

  const btn = form.querySelector('#btnLogin');
  btn.disabled = true;
  btn.textContent = '登录中...';

  authLogin(acc, pwd)
    .then(() => {
      eventBus?.emit?.('toast:show', { type:'success', message:'登录成功' });
      location.hash = '#/site';
    })
    .catch(err => {
      msgEl.textContent = (err && err.msg) || '登录失败';
      msgEl.classList.add('err');
      generateCaptcha();
      console.log('err: '+err+' err.msg:'+err.msg);
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = '登录';
    });
}

function togglePwdVisibility(e) {
  const input = e.currentTarget.parentElement.querySelector('input[name=pwd]');
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    e.currentTarget.textContent = '🙈';
  } else {
    input.type = 'password';
    e.currentTarget.textContent = '👁';
  }
}

/* ---------------- 验证码 ---------------- */
function generateCaptcha() {
  captchaText = randomCaptcha(5);
  drawCaptcha(captchaText);
}
function randomCaptcha(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function drawCaptcha(text) {
  const c = document.getElementById('captchaCanvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0,0,w,h);
  const g = ctx.createLinearGradient(0,0,w,h);
  g.addColorStop(0,'#1d252d');
  g.addColorStop(1,'#26323d');
  ctx.fillStyle = g;
  ctx.fillRect(0,0,w,h);
  for (let i=0;i<text.length;i++) {
    const ch = text[i];
    const fs = 20 + Math.random()*6;
    ctx.font = `${fs}px bold monospace`;
    ctx.fillStyle = randColor();
    const x = 10 + i*(w-20)/text.length;
    const y = 25 + Math.random()*8;
    const ang = (Math.random()-0.5)*0.6;
    ctx.save();
    ctx.translate(x,y);
    ctx.rotate(ang);
    ctx.fillText(ch,0,0);
    ctx.restore();
  }
  for (let i=0;i<4;i++) {
    ctx.strokeStyle = randColor();
    ctx.beginPath();
    ctx.moveTo(Math.random()*w, Math.random()*h);
    ctx.lineTo(Math.random()*w, Math.random()*h);
    ctx.stroke();
  }
  for (let i=0;i<18;i++) {
    ctx.fillStyle = randColor();
    ctx.fillRect(Math.random()*w, Math.random()*h, 2, 2);
  }
}
function randColor() { return `rgb(${100+Math.random()*155|0},${100+Math.random()*155|0},${100+Math.random()*155|0})`; }
function validateCaptcha(input) { return input.toLowerCase() === captchaText.toLowerCase(); }
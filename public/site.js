// Shared progressive enhancements for the public pages: mobile menu, copy buttons, server URL in examples.
(() => {
const $ = (s, r = document) => r.querySelector(s);

for (const el of document.querySelectorAll('.origin')) el.textContent = location.origin;

const menu = $('.menu-btn'), links = $('#site-nav');
if (menu && links) {
  const set = (open) => { links.classList.toggle('open', open); menu.setAttribute('aria-expanded', String(open)); };
  menu.onclick = () => set(!links.classList.contains('open'));
  links.onclick = (e) => { if (e.target.closest('a')) set(false); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && links.classList.contains('open')) { set(false); menu.focus(); } });
}

// Every .code block gets a Copy button; lines starting with # (comments) are not copied.
const status = Object.assign(document.createElement('span'), { className: 'sr-only', role: 'status' });
document.body.append(status);
for (const block of document.querySelectorAll('.code:not([data-nocopy])')) {
  const pre = $('pre', block);
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'copy', textContent: 'Copy' });
  b.setAttribute('aria-label', block.dataset.copyLabel || 'Copy code');
  b.onclick = async () => {
    const text = pre.innerText.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; status.textContent = 'Copied to clipboard.'; }
    catch { b.textContent = 'Select & copy'; }
    setTimeout(() => { b.textContent = 'Copy'; status.textContent = ''; }, 1500);
  };
  block.prepend(b);
}
})();

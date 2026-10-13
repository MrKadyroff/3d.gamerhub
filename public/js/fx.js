// Мелкие анимации по всему сайту: прогресс-нить, слова заголовка, счётчики, подсветка карточек, магнитные кнопки.
const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ── Нить-прогресс страницы ───────────────────────────────────
const bar = document.getElementById('scrollBar');
let tick = false;
function onScroll() {
  if (tick) return; tick = true;
  requestAnimationFrame(() => {
    const max = document.documentElement.scrollHeight - innerHeight;
    if (bar) bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
    tick = false;
  });
}
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// ── Заголовок героя: слова выезжают по очереди ───────────────
const h1 = document.querySelector('.hero h1');
if (h1 && !reduce) {
  let n = 0;
  const wrap = (node) => {
    [...node.childNodes].forEach((c) => {
      if (c.nodeType === 3) {
        const frag = document.createDocumentFragment();
        c.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.append(' '); return; }
          const w = document.createElement('span'); w.className = 'w';
          const i = document.createElement('span'); i.className = 'w__i';
          i.style.animationDelay = `${0.1 + n++ * 0.09}s`; i.textContent = part;
          w.append(i); frag.append(w);
        });
        c.replaceWith(frag);
      } else if (c.nodeType === 1 && c.tagName !== 'BR') wrap(c);
    });
  };
  wrap(h1);
}

// ── Счётчики ─────────────────────────────────────────────────
function countUp(el) {
  const m = el.textContent.trim().match(/^(\d+(?:\.\d+)?)(.*)$/);
  if (!m || reduce) return;
  const end = parseFloat(m[1]), dec = (m[1].split('.')[1] || '').length, tail = m[2];
  const t0 = performance.now(), dur = 1400;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 4);
    el.textContent = (end * e).toFixed(dec) + tail;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const statIO = new IntersectionObserver((en) => en.forEach((e) => {
  if (e.isIntersecting) { statIO.unobserve(e.target); countUp(e.target); }
}), { threshold: 0.6 });
$$('.hero__stats b').forEach((b) => statIO.observe(b));

// ── Каскадное появление карточек ─────────────────────────────
const stagger = ['.mat', '.steps__list li', '.clink', '.faq__item'];
stagger.forEach((sel) => $$(sel).forEach((el, i) => { el.classList.add('pop-in'); el.style.setProperty('--d', `${(i % 6) * 80}ms`); }));
const popIO = new IntersectionObserver((en) => en.forEach((e) => {
  if (e.isIntersecting) { e.target.classList.add('is-in'); popIO.unobserve(e.target); }
}), { threshold: 0.12 });
$$('.pop-in').forEach((el) => popIO.observe(el));
// FAQ строится скриптом позже — подхватим
new MutationObserver(() => $$('.faq__item:not(.pop-in)').forEach((el, i) => { el.classList.add('pop-in'); el.style.setProperty('--d', `${i * 70}ms`); popIO.observe(el); }))
  .observe(document.getElementById('faqList') || document.body, { childList: true });

if (fine && !reduce) {
  // ── Свечение за курсором ───────────────────────────────────
  const glow = document.getElementById('cursorGlow');
  let tx = innerWidth / 2, ty = innerHeight / 2, gx = tx, gy = ty, run = false;
  const loop = () => {
    gx += (tx - gx) * 0.12; gy += (ty - gy) * 0.12;
    glow.style.transform = `translate(${gx}px,${gy}px)`;
    if (Math.abs(tx - gx) + Math.abs(ty - gy) > 0.5) requestAnimationFrame(loop); else run = false;
  };
  addEventListener('pointermove', (e) => {
    tx = e.clientX; ty = e.clientY; glow.classList.add('is-on');
    if (!run) { run = true; requestAnimationFrame(loop); }
  }, { passive: true });

  // ── Подсветка границы карточек ─────────────────────────────
  $$('.panel, .mat, .clink, .contact__card, .steps__list li').forEach((el) => {
    el.classList.add('spot');
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  });

  // ── Магнитные кнопки ───────────────────────────────────────
  $$('.btn--primary, .nav__cta').forEach((b) => {
    b.addEventListener('pointermove', (e) => {
      const r = b.getBoundingClientRect();
      b.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * 0.18}px,${(e.clientY - r.top - r.height / 2) * 0.28}px)`;
    });
    b.addEventListener('pointerleave', () => { b.style.transform = ''; });
  });

  // ── Наклон карточки принтера в герое ───────────────────────
  const card = document.querySelector('.viz-card');
  const viz = document.querySelector('.hero__viz');
  if (card && viz) {
    viz.addEventListener('pointermove', (e) => {
      const r = viz.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform = `perspective(900px) rotateY(${x * 9}deg) rotateX(${-y * 9}deg)`;
    });
    viz.addEventListener('pointerleave', () => { card.style.transform = ''; });
  }
}

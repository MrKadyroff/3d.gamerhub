// Мелкие анимации по всему сайту: прогресс-нить, слова заголовка, счётчики, подсветка карточек, магнитные кнопки.
const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ── Нить-прогресс страницы ───────────────────────────────────
const bar = document.getElementById('scrollBar');
const layerEl = document.getElementById('layerNum'), layerBox = document.getElementById('layerHud');
const LAYERS = 1240;                 // «высота модели» = вся страница
let tick = false, maxScroll = 1, lastLayer = -1;
const measure = () => { maxScroll = Math.max(1, document.documentElement.scrollHeight - innerHeight); };
function onScroll() {
  if (tick) return; tick = true;
  requestAnimationFrame(() => {
    const k = Math.min(1, scrollY / maxScroll);
    if (bar) bar.style.transform = `scaleX(${k})`;
    if (layerEl) {
      const n = Math.round(k * LAYERS);
      if (n !== lastLayer) { lastLayer = n; layerEl.textContent = String(n).padStart(4, '0'); }
      layerBox.style.setProperty('--k', k.toFixed(3));
      layerBox.classList.toggle('is-on', scrollY > 240);
    }
    tick = false;
  });
}
addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', () => { measure(); onScroll(); }, { passive: true });
addEventListener('load', () => { measure(); onScroll(); });
measure(); onScroll();

// ── «Печать» при скролле: блоки выращиваются слой за слоем снизу вверх, по соплу-лучу ──
const printSel = ['.section__head h2', '.mat', '.steps__list li', '.clink'];
const printEls = [...new Set(printSel.flatMap((q) => $$(q)))].filter((el) => !el.closest('.modal, .orders'));
if (!reduce) {
  printEls.forEach((el, i) => {
    el.classList.add('print');
    el.style.setProperty('--pt', '.4s');
    el.style.setProperty('--ly', '8');
    const line = document.createElement('i'); line.className = 'pline'; line.setAttribute('aria-hidden', 'true');
    el.append(line);
  });
  // без IntersectionObserver: клип-путь на цели ломает его расчёт, поэтому проверяем позицию сами
  let pending = printEls.slice();
  const fire = (el) => {
    el.classList.add('is-printed');
    el.addEventListener('animationend', (ev) => { if (ev.animationName === 'layerUp') { el.classList.add('is-done'); el.querySelector(':scope > .pline')?.remove(); } });
  };
  const checkPrint = () => {
    const lim = innerHeight * 0.94;
    pending = pending.filter((el) => { const r = el.getBoundingClientRect(); if (r.top < lim && r.bottom > 0) { fire(el); return false; } return true; });
  };
  let pq = false;
  const checkSoon = () => { if (pending.length && !pq) { pq = true; requestAnimationFrame(() => { pq = false; checkPrint(); }); } };
  addEventListener('scroll', checkSoon, { passive: true });
  addEventListener('resize', checkSoon, { passive: true });
  addEventListener('load', checkPrint);
  checkPrint();
  setTimeout(checkPrint, 600);
}

// ── Заголовок героя: голова принтера «печатает» буквы одну за другой ──
const h1 = document.querySelector('.hero h1');
if (h1 && !reduce) {
  const chars = [];
  const wrap = (node) => {
    [...node.childNodes].forEach((c) => {
      if (c.nodeType === 3) {
        const frag = document.createDocumentFragment();
        c.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.append(' '); return; }
          const w = document.createElement('span'); w.className = 'pw';   // слово не рвём при переносе
          [...part].forEach((ch) => { const s = document.createElement('span'); s.className = 'pc'; s.textContent = ch; w.append(s); chars.push(s); });
          frag.append(w);
        });
        c.replaceWith(frag);
      } else if (c.nodeType === 1 && c.tagName !== 'BR') wrap(c);
    });
  };
  wrap(h1);
  h1.classList.add('is-typing');
  const showAll = () => { chars.forEach((c) => c.classList.add('is-on')); cv?.remove(); };
  let cv = null, dead = false;
  const bail = setTimeout(() => { dead = true; showAll(); }, 4000);   // шрифт не успел — просто показываем текст

  // Контуры букв из векторного шрифта → линия, по которой «едет» сопло, как по траектории печати.
  const SAMPLES = 6;
  const glyphContours = (g, sx, sy, ox, oy) => {
    const out = []; let cur = null, x = 0, y = 0;
    const o = g.o.split(' ');
    for (let k = 0; k < o.length;) {
      const t = o[k++];
      if (t === 'm') { x = +o[k++]; y = +o[k++]; cur = [[ox + x * sx, oy - y * sy]]; out.push(cur); }
      else if (t === 'l') { x = +o[k++]; y = +o[k++]; cur.push([ox + x * sx, oy - y * sy]); }
      else if (t === 'q') {
        const ex = +o[k++], ey = +o[k++], cx = +o[k++], cy = +o[k++];
        for (let n = 1; n <= SAMPLES; n++) { const u = n / SAMPLES, a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
          cur.push([ox + (a * x + b * cx + c * ex) * sx, oy - (a * y + b * cy + c * ey) * sy]); }
        x = ex; y = ey;
      } else if (t === 'b') {
        const ex = +o[k++], ey = +o[k++], c1x = +o[k++], c1y = +o[k++], c2x = +o[k++], c2y = +o[k++];
        for (let n = 1; n <= SAMPLES; n++) { const u = n / SAMPLES, v = 1 - u;
          const A = v * v * v, B = 3 * v * v * u, C = 3 * v * u * u, D = u * u * u;
          cur.push([ox + (A * x + B * c1x + C * c2x + D * ex) * sx, oy - (A * y + B * c1y + C * c2y + D * ey) * sy]); }
        x = ex; y = ey;
      }
    }
    return out;
  };

  fetch('vendor/fonts/droid_sans_bold.typeface.json').then((r) => r.json()).then(async (font) => {
    await document.fonts.ready;
    if (dead) return;
    const dpr = Math.min(devicePixelRatio || 1, 2), PAD = 24;
    const hr = h1.getBoundingClientRect();
    cv = document.createElement('canvas'); cv.className = 'ptrace'; cv.setAttribute('aria-hidden', 'true');
    cv.style.cssText = `left:${-PAD}px;top:${-PAD}px;width:${hr.width + PAD * 2}px;height:${hr.height + PAD * 2}px`;
    cv.width = Math.round((hr.width + PAD * 2) * dpr); cv.height = Math.round((hr.height + PAD * 2) * dpr);
    h1.append(cv);
    const g = cv.getContext('2d'); g.scale(dpr, dpr); g.lineCap = g.lineJoin = 'round';
    const fs = parseFloat(getComputedStyle(h1).fontSize), res = font.resolution, k = fs / res;
    g.font = `700 ${fs}px "Space Grotesk",sans-serif`;
    const asc = g.measureText('x').fontBoundingBoxAscent || fs * 0.95;
    g.lineWidth = Math.max(1.6, fs * 0.028);

    // подготовка: контур каждой буквы, уложенный в её реальную ширину и положение
    const items = chars.map((el) => {
      const r = el.getBoundingClientRect(), gl = font.glyphs[el.textContent] || null;
      if (!gl || !gl.o) return { el, pts: null };
      const sx = gl.ha ? (r.width / (gl.ha * k)) * k : k;
      const cs = glyphContours(gl, sx, k, r.left - hr.left + PAD, r.top - hr.top + PAD + asc);
      const len = (c) => c.reduce((t, q, n) => t + (n ? Math.hypot(q[0] - c[n - 1][0], q[1] - c[n - 1][1]) : 0), 0);
      return { el, pts: cs, total: cs.reduce((t, c) => t + len(c), 0) };
    });

    const TRACE = 330, GAP = 85, FADE = 260;       // мс: прорисовка буквы, шаг между буквами, затухание контура
    const t0 = performance.now() + 250;
    const done = new Set();
    const frame = (now) => {
      if (dead) return;
      g.clearRect(0, 0, cv.width, cv.height);
      let alive = false, tip = null;
      items.forEach((it, idx) => {
        const st = t0 + idx * GAP, tt = now - st;
        if (tt < 0) { alive = true; return; }
        const p = Math.min(1, tt / TRACE);
        if (!it.pts) { if (p >= 1 && !done.has(idx)) { done.add(idx); it.el.classList.add('is-on'); } return; }
        const fade = tt <= TRACE ? 1 : 1 - (tt - TRACE) / FADE;
        if (p >= 1 && !done.has(idx)) { done.add(idx); it.el.classList.add('is-on'); }
        if (fade <= 0) return;
        alive = true;
        // отрисовываем долю p общей длины по контурам
        let left = p * it.total;
        g.globalAlpha = Math.max(0, fade);
        g.strokeStyle = '#ff7a29';
        for (const c of it.pts) {
          if (c.length < 2) continue;
          g.beginPath(); g.moveTo(c[0][0], c[0][1]);
          let acc = 0, ended = false;
          for (let n = 1; n < c.length; n++) {
            const d = Math.hypot(c[n][0] - c[n - 1][0], c[n][1] - c[n - 1][1]);
            if (acc + d <= left) { g.lineTo(c[n][0], c[n][1]); acc += d; continue; }
            const u = d ? (left - acc) / d : 0;
            const px = c[n - 1][0] + (c[n][0] - c[n - 1][0]) * u, py = c[n - 1][1] + (c[n][1] - c[n - 1][1]) * u;
            g.lineTo(px, py); if (p < 1) tip = [px, py]; ended = true; break;
          }
          g.stroke();
          left -= acc; if (ended) break;
          left = Math.max(0, left);
        }
      });
      if (tip) {                                // светящийся кончик сопла
        g.globalAlpha = 0.35; g.fillStyle = '#ff7a29'; g.beginPath(); g.arc(tip[0], tip[1], fs * 0.1, 0, 7); g.fill();
        g.globalAlpha = 1; g.fillStyle = '#ffd9b8'; g.beginPath(); g.arc(tip[0], tip[1], fs * 0.04, 0, 7); g.fill();
      }
      g.globalAlpha = 1;
      if (alive) requestAnimationFrame(frame); else { clearTimeout(bail); cv.remove(); }
    };
    requestAnimationFrame(frame);
  }).catch(() => { dead = true; clearTimeout(bail); showAll(); });
}

// ── Пауза вечных анимаций героя, пока он не на экране ────────
const heroEl = document.querySelector('.hero');
if (heroEl) new IntersectionObserver((en) => heroEl.classList.toggle('is-off', !en[0].isIntersecting)).observe(heroEl);

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
const stagger = reduce ? ['.faq__item'] : ['.faq__item'];
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
    let r = null;                                   // прямоугольник считаем один раз при входе, а не на каждый пиксель
    el.addEventListener('pointerenter', () => { r = el.getBoundingClientRect(); });
    el.addEventListener('pointermove', (e) => {
      if (!r) r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    }, { passive: true });
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

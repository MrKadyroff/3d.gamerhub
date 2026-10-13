// Курсор-сопло: за курсором тянется оранжевый след из «пластика», который остывает и исчезает.
if (matchMedia('(hover: hover) and (pointer: fine)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const cv = document.createElement('canvas');
  cv.className = 'nozzle-trail'; cv.setAttribute('aria-hidden', 'true');
  document.body.append(cv);
  const g = cv.getContext('2d');
  const size = () => { cv.width = innerWidth; cv.height = innerHeight; g.lineCap = g.lineJoin = 'round'; };
  size(); addEventListener('resize', size);

  const LIFE = 520, pts = [];
  let raf = 0, mx = 0, my = 0;
  const draw = (now) => {
    raf = 0;
    while (pts.length && now - pts[0].t > LIFE) pts.shift();
    g.clearRect(0, 0, cv.width, cv.height);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], k = 1 - (now - b.t) / LIFE;       // 1 — свежий пластик
      g.strokeStyle = `rgba(255,${Math.round(110 + 110 * k * k)},${Math.round(40 + 90 * k * k)},${(k * 0.85).toFixed(3)})`;
      g.lineWidth = 1 + 5 * k;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    if (pts.length) raf = requestAnimationFrame(draw);
  };
  // ── Сам курсор: картинка хотэнда, остриём сопла в точку клика ──
  const cur = document.createElement('div');
  cur.className = 'nozzle-cur'; cur.setAttribute('aria-hidden', 'true');
  cur.innerHTML = `<svg width="30" height="46" viewBox="0 0 30 46">
    <defs>
      <linearGradient id="nzBlk" x1="0" x2="1"><stop offset="0" stop-color="#4a5058"/><stop offset=".5" stop-color="#2a2e34"/><stop offset="1" stop-color="#1a1d21"/></linearGradient>
      <linearGradient id="nzBrs" x1="0" x2="1"><stop offset="0" stop-color="#8a6a28"/><stop offset=".45" stop-color="#f0cd78"/><stop offset="1" stop-color="#9a7430"/></linearGradient>
    </defs>
    <rect x="6" y="1" width="18" height="6" rx="2" fill="#15171a" stroke="#3a3f46"/>
    <rect x="4" y="7" width="22" height="17" rx="3" fill="url(#nzBlk)" stroke="#4a535e"/>
    <rect x="8" y="11" width="14" height="2" rx="1" fill="#ff7a29" opacity=".85"/>
    <path d="M9 24h12l-2.5 9h-7z" fill="url(#nzBrs)"/>
    <path d="M11.5 33h7L16 42h-2z" fill="url(#nzBrs)"/>
    <circle class="nz-tip" cx="15" cy="43.5" r="2.2" fill="#ffd9b8"/>
  </svg>`;
  document.body.append(cur);
  document.documentElement.classList.add('has-nozzle');
  const HOT = 'a,button,[role=button],summary,label[for],select,.btn,.swatch,.carousel__btn,input[type=range],input[type=checkbox],input[type=radio],input[type=file],.faq__q,.mat,.drop,[data-close]';
  const TEXT = 'input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button]):not([type=submit]),textarea,[contenteditable=true]';
  const html = document.documentElement;
  addEventListener('pointermove', (e) => {
    mx = e.clientX; my = e.clientY;
    cur.style.transform = `translate(${mx - 15}px,${my - 43.5}px)`;
    cur.classList.add('is-on');
    const l = pts[pts.length - 1];
    if (!l || Math.hypot(l.x - mx, l.y - my) > 3) pts.push({ x: mx, y: my, t: performance.now() });
    if (!raf) raf = requestAnimationFrame(draw);
  }, { passive: true });
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest ? e.target : e.target.parentElement;
    html.classList.toggle('native-cur', !!t?.closest(TEXT));
    cur.classList.toggle('is-hot', !!t?.closest(HOT));
  }, { passive: true });
  addEventListener('pointerdown', () => cur.classList.add('is-press'));
  addEventListener('pointerup', () => cur.classList.remove('is-press'));
  document.documentElement.addEventListener('pointerleave', () => cur.classList.remove('is-on'));
}

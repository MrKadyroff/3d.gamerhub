// Плавный инерционный скролл (Lenis). На сенсорных и слабых устройствах не включаем — родной скролл там лучше.
const coarse = matchMedia('(pointer: coarse)').matches;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const weak = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
if (!coarse && !reduce && !weak) {
  import('../vendor/lenis.mjs').then(({ default: Lenis }) => {
    const lenis = new Lenis({ lerp: 0.1, wheelMultiplier: 1, anchors: { offset: -64 } });
    const raf = (t) => { lenis.raf(t); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    window.lenis = lenis;
    // при открытом окне/панели общий скролл останавливаем
    const watch = (el) => new MutationObserver(() => (el.hidden ? lenis.start() : lenis.stop())).observe(el, { attributes: true, attributeFilter: ['hidden'] });
    document.querySelectorAll('#orderModal, #ordersPanel').forEach(watch);
  }).catch(() => {});
}

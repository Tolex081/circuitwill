// Presentation-only interaction layer. No app logic lives here and app.js does not depend on it.
//  - Motion (vendor/motion-14.14.0.min.js): spring hover / press on every link, button, tab and disclosure,
//    delegated from the document so rows and buttons that app.js renders later get it too.
//  - GSAP + ScrollTrigger (vendor/gsap-3.15.1.min.js): the page's one scroll moment. As the hero scrolls away,
//    the large "CircuitWill" wordmark lifts out and the same name settles into the sticky top bar, so the
//    name and the network badge stay with you while you read the record.
// If a library fails to load, or the visitor prefers reduced motion, the CSS states (colour, underline, focus)
// still work and nothing is hidden.

const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const M = window.Motion;
const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;

/* ---------- hover and press (Motion) ---------- */
const TARGET = 'a, .btn, .tab, summary';
const spring = { type: 'spring', stiffness: 560, damping: 34, mass: 0.6 };
const soft = { duration: 0.32, ease: [0.16, 1, 0.3, 1] };
const wide = matchMedia('(min-width: 761px)');

function hoverTo(el, on) {
  if (!M || reduce.matches || el.matches(':disabled')) return;
  if (el.matches('a, .btn.ghost')) {
    M.animate(el, { '--u': on ? 1 : 0.35 }, soft);
  } else if (el.matches('.btn')) {
    M.animate(el, { y: on ? -2 : 0 }, spring);
  } else if (el.matches('.tab')) {
    M.animate(el, wide.matches ? { x: on ? 4 : 0 } : { y: on ? -1 : 0 }, spring);
  } else if (el.matches('summary')) {
    M.animate(el, { x: on ? 3 : 0 }, spring);
  }
}

function pressTo(el, down) {
  if (!M || reduce.matches || el.matches(':disabled')) return;
  M.animate(el, { scale: down ? 0.97 : 1 }, { type: 'spring', stiffness: 700, damping: 30 });
}

const owner = (e) => (e.target instanceof Element ? e.target.closest(TARGET) : null);
const left = (el, related) => !(related instanceof Node && el.contains(related));

document.addEventListener('pointerover', (e) => {
  const el = owner(e);
  if (el && e.pointerType !== 'touch' && left(el, e.relatedTarget)) hoverTo(el, true);
});
document.addEventListener('pointerout', (e) => {
  const el = owner(e);
  if (el && left(el, e.relatedTarget)) { hoverTo(el, false); pressTo(el, false); }
});
document.addEventListener('pointerdown', (e) => { const el = owner(e); if (el) pressTo(el, true); });
document.addEventListener('pointerup', (e) => { const el = owner(e); if (el) pressTo(el, false); });
document.addEventListener('pointercancel', (e) => { const el = owner(e); if (el) pressTo(el, false); });
// Keyboard users get the same answer as pointer users.
document.addEventListener('focusin', (e) => { const el = owner(e); if (el && el.matches(':focus-visible')) hoverTo(el, true); });
document.addEventListener('focusout', (e) => { const el = owner(e); if (el) hoverTo(el, false); });

/* ---------- the scroll moment (GSAP ScrollTrigger) ---------- */
const hero = document.getElementById('connect-screen');
const word = hero?.querySelector('h1');
const brand = document.querySelector('.brand');
const topbar = document.querySelector('.topbar');
let tl = null;

function buildHandoff() {
  if (tl) { tl.scrollTrigger?.kill(); tl.kill(); tl = null; }
  if (!gsap || !ScrollTrigger || !hero || !word || !brand) return;
  gsap.set([word, brand], { clearProps: 'opacity,transform,clipPath,filter' });
  document.documentElement.classList.remove('has-handoff');
  if (reduce.matches || hero.classList.contains('hidden')) return;

  document.documentElement.classList.add('has-handoff');
  tl = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      start: 0,
      // Done when the wordmark's baseline passes under the sticky bar.
      end: () => Math.max(1, word.getBoundingClientRect().bottom + scrollY - topbar.offsetHeight),
      scrub: 0.6,
      invalidateOnRefresh: true,
    },
  });
  tl.fromTo(word,
    { yPercent: 0, opacity: 1, filter: 'blur(0px)', clipPath: 'inset(-10% 0% -10% 0%)' },
    { yPercent: -18, opacity: 0, filter: 'blur(6px)', clipPath: 'inset(-10% 0% 60% 0%)' }, 0)
    .fromTo(brand,
      { opacity: 0, y: 10, clipPath: 'inset(0% 100% 0% 0%)' },
      { opacity: 1, y: 0, clipPath: 'inset(0% 0% 0% 0%)', ease: 'power2.out' }, 0.45);
}

if (gsap && ScrollTrigger) {
  gsap.registerPlugin(ScrollTrigger);
  buildHandoff();
  // app.js shows and hides screens by toggling .hidden; rebuild when the hero comes or goes,
  // and re-measure when the dashboard changes the page height.
  if (hero) new MutationObserver(buildHandoff).observe(hero, { attributes: true, attributeFilter: ['class'] });
  let pending = 0;
  new ResizeObserver(() => { cancelAnimationFrame(pending); pending = requestAnimationFrame(() => ScrollTrigger.refresh()); })
    .observe(document.body);
  reduce.addEventListener('change', buildHandoff);
  document.fonts?.ready.then(() => ScrollTrigger.refresh());
}

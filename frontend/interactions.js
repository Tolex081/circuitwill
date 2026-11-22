// Presentation-only interaction layer. No app logic lives here and app.js does not depend on it.
// Motion (vendor/motion-14.14.0.min.js): a small spring lift / press on buttons and tabs, delegated from the document
// so buttons that app.js renders later get it too. If the library fails to load, or the visitor prefers reduced
// motion, the CSS states (colour, border, focus ring) still work and nothing is hidden.

const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const M = window.Motion;

const TARGET = '.btn, .chip, .recent-list button';
const spring = { type: 'spring', stiffness: 560, damping: 34, mass: 0.6 };

function hoverTo(el, on) {
  if (!M || reduce.matches || el.matches(':disabled') || el.matches('.ghost')) return;
  M.animate(el, { y: on ? -1 : 0 }, spring);
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

// Colour theme: dark (default) or light. Presentation only: no app state, no wallet, no network.
// Loaded in <head> without defer so a saved choice applies before the first paint (no flash).
// The choice is kept per browser in localStorage; if storage is blocked the page stays dark.
(function () {
  var KEY = 'circuitwill:theme:v1';
  var PAPER = { light: '#ebe8e1', dark: '#111514' }; // matches --field in style.css
  var root = document.documentElement;

  function read() {
    try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch (e) { return 'dark'; }
  }
  function write(t) {
    try { if (t === 'light') localStorage.setItem(KEY, 'light'); else localStorage.removeItem(KEY); } catch (e) { /* stays dark */ }
  }
  function apply(t) {
    if (t === 'light') root.setAttribute('data-theme', 'light'); else root.removeAttribute('data-theme');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', PAPER[t]);
    var btn = document.getElementById('theme-btn');
    if (btn) {
      var label = t === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    }
  }

  var current = read();
  apply(current);

  function bindButton() {
    var btn = document.getElementById('theme-btn');
    if (!btn) return;
    apply(current);
    btn.hidden = false;
    btn.addEventListener('click', function () {
      current = current === 'light' ? 'dark' : 'light';
      write(current);
      apply(current);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindButton); else bindButton();

  // Another tab changed the theme.
  window.addEventListener('storage', function (e) { if (e.key === KEY) { current = read(); apply(current); } });
})();

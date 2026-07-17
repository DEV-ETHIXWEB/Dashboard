'use strict';

// Self-contained accessibility widget -- works on any page that includes
// this script. Injects its own floating button + panel, and persists
// preferences in localStorage so they carry across pages/sessions.

(function () {
  const STORAGE_KEY = 'ethixweb_a11y_prefs';
  const DEFAULTS = { fontScale: 1, highContrast: false, dyslexiaFont: false, reduceMotion: false, underlineLinks: false };

  // Loaded once, lazily, only if someone actually turns on the dyslexia
  // toggle -- avoids paying for a font nobody asked for.
  let dyslexiaFontLoaded = false;
  function ensureDyslexiaFontLoaded() {
    if (dyslexiaFontLoaded) return;
    dyslexiaFontLoaded = true;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Comic+Neue:wght@400;700&display=swap';
    document.head.appendChild(link);
  }

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    } catch {
      return { ...DEFAULTS };
    }
  }
  function savePrefs(prefs) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }

  let prefs = loadPrefs();

  function applyPrefs() {
    if (prefs.dyslexiaFont) ensureDyslexiaFontLoaded();
    const root = document.documentElement;
    root.style.setProperty('--ew-a11y-font-scale', prefs.fontScale);
    root.classList.toggle('ew-a11y-high-contrast', prefs.highContrast);
    root.classList.toggle('ew-a11y-dyslexia', prefs.dyslexiaFont);
    root.classList.toggle('ew-a11y-reduce-motion', prefs.reduceMotion);
    root.classList.toggle('ew-a11y-underline-links', prefs.underlineLinks);
  }

  function buildWidget() {
    const btn = document.createElement('button');
    btn.id = 'ewA11yBtn';
    btn.setAttribute('aria-label', 'Accessibility options');
    btn.className = 'ew-a11y-fab';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="1.8" fill="white" stroke="none"/><path d="M12 7v6M7 9.5h10M12 13L8.5 20M12 13l3.5 7"/></svg>';

    const panel = document.createElement('div');
    panel.id = 'ewA11yPanel';
    panel.className = 'ew-a11y-panel ew-hidden';
    panel.innerHTML = `
      <div class="ew-a11y-head">Accessibility</div>
      <div class="ew-a11y-row">
        <span>Text size</span>
        <div class="ew-a11y-stepper">
          <button data-action="font-down" aria-label="Decrease text size">A-</button>
          <button data-action="font-up" aria-label="Increase text size">A+</button>
        </div>
      </div>
      <label class="ew-a11y-toggle-row"><span>High contrast</span><input type="checkbox" data-pref="highContrast"></label>
      <label class="ew-a11y-toggle-row"><span>Dyslexia-friendly font</span><input type="checkbox" data-pref="dyslexiaFont"></label>
      <label class="ew-a11y-toggle-row"><span>Reduce motion</span><input type="checkbox" data-pref="reduceMotion"></label>
      <label class="ew-a11y-toggle-row"><span>Underline links</span><input type="checkbox" data-pref="underlineLinks"></label>
      <button class="ew-a11y-reset" data-action="reset">Reset to default</button>
    `;

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.toggle('ew-hidden');
    });
    document.addEventListener('click', (e) => {
      if (!panel.contains(e.target) && !btn.contains(e.target)) panel.classList.add('ew-hidden');
    });

    panel.querySelectorAll('input[data-pref]').forEach((input) => {
      input.checked = prefs[input.dataset.pref];
      input.addEventListener('change', () => {
        prefs[input.dataset.pref] = input.checked;
        savePrefs(prefs);
        applyPrefs();
      });
    });

    panel.querySelector('[data-action="font-up"]').addEventListener('click', () => {
      prefs.fontScale = Math.min(1.5, Math.round((prefs.fontScale + 0.1) * 10) / 10);
      savePrefs(prefs);
      applyPrefs();
    });
    panel.querySelector('[data-action="font-down"]').addEventListener('click', () => {
      prefs.fontScale = Math.max(0.85, Math.round((prefs.fontScale - 0.1) * 10) / 10);
      savePrefs(prefs);
      applyPrefs();
    });
    panel.querySelector('[data-action="reset"]').addEventListener('click', () => {
      prefs = { ...DEFAULTS };
      savePrefs(prefs);
      applyPrefs();
      panel.querySelectorAll('input[data-pref]').forEach((input) => { input.checked = prefs[input.dataset.pref]; });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { buildWidget(); applyPrefs(); });
  } else {
    buildWidget();
    applyPrefs();
  }
})();

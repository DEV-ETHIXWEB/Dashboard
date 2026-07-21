'use strict';

// Self-contained accessibility widget -- works on any page that includes
// this script. Injects its own floating button + panel *inside* the app's
// themed wrapper (.ew) so it correctly follows light/dark theme instead of
// being hardcoded dark. Persists preferences in localStorage so they carry
// across pages/sessions.

(function () {
  const STORAGE_KEY = 'ethixweb_a11y_prefs';
  const DEFAULTS = { fontScale: 1, highContrast: false, dyslexiaFont: false, reduceMotion: false, underlineLinks: false };

  const ICONS = {
    contrast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 2.5a9.5 9.5 0 0 1 0 19z" fill="currentColor" stroke="none"/></svg>',
    dyslexia: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    motion: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M9 9v6M15 9v6"/></svg>',
    underline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v6a6 6 0 0 0 12 0V4"/><path d="M4 20h16"/></svg>',
  };

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
    // Mount inside the app's themed wrapper (.ew) instead of document.body,
    // so the widget correctly inherits the current light/dark theme's CSS
    // variables instead of being stuck looking dark all the time.
    const mount = document.querySelector('.ew') || document.body;

    const btn = document.createElement('button');
    btn.id = 'ewA11yBtn';
    btn.setAttribute('aria-label', 'Accessibility options');
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'ewA11yPanel');
    btn.className = 'ew-a11y-fab';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="1.8" fill="white" stroke="none"/><path d="M12 7v6M7 9.5h10M12 13L8.5 20M12 13l3.5 7"/></svg>';

    const panel = document.createElement('div');
    panel.id = 'ewA11yPanel';
    panel.className = 'ew-a11y-panel ew-hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Accessibility options');
    panel.innerHTML = `
      <div class="ew-a11y-head">Accessibility</div>
      <div class="ew-a11y-row">
        <span id="ewA11yFontLabel">Text size</span>
        <div class="ew-a11y-stepper">
          <button data-action="font-down" aria-label="Decrease text size">A-</button>
          <button data-action="font-up" aria-label="Increase text size">A+</button>
        </div>
      </div>
      <label class="ew-a11y-toggle-row">
        <span class="label-with-icon">${ICONS.contrast}<span>High contrast</span></span>
        <input type="checkbox" data-pref="highContrast">
      </label>
      <label class="ew-a11y-toggle-row">
        <span class="label-with-icon">${ICONS.dyslexia}<span>Dyslexia-friendly font</span></span>
        <input type="checkbox" data-pref="dyslexiaFont">
      </label>
      <label class="ew-a11y-toggle-row">
        <span class="label-with-icon">${ICONS.motion}<span>Reduce motion</span></span>
        <input type="checkbox" data-pref="reduceMotion">
      </label>
      <label class="ew-a11y-toggle-row">
        <span class="label-with-icon">${ICONS.underline}<span>Underline links</span></span>
        <input type="checkbox" data-pref="underlineLinks">
      </label>
      <button class="ew-a11y-reset" data-action="reset">Reset to default</button>
    `;

    mount.appendChild(btn);
    mount.appendChild(panel);

    function openPanel() {
      panel.classList.remove('ew-hidden');
      btn.setAttribute('aria-expanded', 'true');
      panel.querySelector('input, button')?.focus();
    }
    function closePanel({ returnFocus } = {}) {
      panel.classList.add('ew-hidden');
      btn.setAttribute('aria-expanded', 'false');
      if (returnFocus) btn.focus();
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel.classList.contains('ew-hidden')) openPanel();
      else closePanel();
    });
    document.addEventListener('click', (e) => {
      if (!panel.contains(e.target) && !btn.contains(e.target)) closePanel();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.classList.contains('ew-hidden')) closePanel({ returnFocus: true });
    });

    panel.querySelectorAll('input[data-pref]').forEach((input) => {
      input.checked = prefs[input.dataset.pref];
      input.addEventListener('change', () => {
        prefs[input.dataset.pref] = input.checked;
        savePrefs(prefs);
        applyPrefs();
      });
    });

    function updateFontLabel() {
      document.getElementById('ewA11yFontLabel').textContent = `Text size (${Math.round(prefs.fontScale * 100)}%)`;
    }
    updateFontLabel();

    panel.querySelector('[data-action="font-up"]').addEventListener('click', () => {
      prefs.fontScale = Math.min(1.5, Math.round((prefs.fontScale + 0.1) * 10) / 10);
      savePrefs(prefs);
      applyPrefs();
      updateFontLabel();
    });
    panel.querySelector('[data-action="font-down"]').addEventListener('click', () => {
      prefs.fontScale = Math.max(0.85, Math.round((prefs.fontScale - 0.1) * 10) / 10);
      savePrefs(prefs);
      applyPrefs();
      updateFontLabel();
    });
    panel.querySelector('[data-action="reset"]').addEventListener('click', () => {
      prefs = { ...DEFAULTS };
      savePrefs(prefs);
      applyPrefs();
      updateFontLabel();
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
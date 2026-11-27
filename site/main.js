// Theme toggle and demo video controls. Everything works without this file; it only adds
// conveniences.
(function () {
  var root = document.documentElement;
  var systemLight = window.matchMedia('(prefers-color-scheme: light)');

  function currentTheme() {
    var set = root.getAttribute('data-theme');
    if (set === 'dark' || set === 'light') return set;
    return systemLight.matches ? 'light' : 'dark';
  }

  var toggle = document.getElementById('theme-toggle');
  function labelToggle() {
    if (!toggle) return;
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    toggle.setAttribute('aria-label', 'Switch to ' + next + ' theme');
    toggle.setAttribute('title', 'Switch to ' + next + ' theme');
  }
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try {
        localStorage.setItem('theme', next);
      } catch {
        // Not persisted; the choice still applies to this visit.
      }
      labelToggle();
    });
    systemLight.addEventListener('change', labelToggle);
    labelToggle();
  }

  // Demo video: stop autoplay for visitors who prefer reduced motion, and offer pause / play.
  var video = document.getElementById('demo-video');
  var button = document.getElementById('video-toggle');
  if (!video || !button) return;
  var text = button.querySelector('span');

  function sync() {
    var paused = video.paused;
    button.setAttribute('data-state', paused ? 'paused' : 'playing');
    if (text) text.textContent = paused ? 'Play demo' : 'Pause demo';
  }

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduceMotion.matches) {
    video.removeAttribute('autoplay');
    video.pause();
    video.currentTime = 0;
  }

  button.hidden = false;
  button.addEventListener('click', function () {
    if (video.paused) {
      var started = video.play();
      if (started && typeof started.catch === 'function') started.catch(sync);
    } else {
      video.pause();
    }
  });
  video.addEventListener('play', sync);
  video.addEventListener('pause', sync);
  sync();
})();

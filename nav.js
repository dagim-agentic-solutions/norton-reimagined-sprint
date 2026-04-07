// Norton Reimagined Sprint — shared nav: mobile toggle + Sprint Tools dropdown
(function () {
  // ── Mobile hamburger toggle ────────────────────────────────────────────────
  var btn   = document.getElementById('nav-toggle');
  var links = document.getElementById('nav-links');
  if (btn && links) {
    btn.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.classList.toggle('active', open);
    });
    document.addEventListener('click', function (e) {
      if (!btn.contains(e.target) && !links.contains(e.target)) {
        links.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
        btn.classList.remove('active');
      }
    });
  }

  // ── Sprint Tools dropdown ──────────────────────────────────────────────────
  var dropBtn  = document.getElementById('sprintToolsBtn');
  var dropMenu = document.getElementById('sprintToolsMenu');

  if (!dropBtn || !dropMenu) return;

  // Mark active link inside dropdown based on current page
  var currentPath = window.location.pathname.split('/').pop() || 'index.html';
  var menuLinks = dropMenu.querySelectorAll('a');
  var hasActive = false;
  menuLinks.forEach(function (a) {
    var href = a.getAttribute('href');
    if (href === currentPath) {
      a.classList.add('active');
      hasActive = true;
    }
  });
  if (hasActive) {
    dropBtn.classList.add('active');
  }

  function openMenu() {
    dropMenu.classList.add('open');
    dropBtn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    dropMenu.classList.remove('open');
    dropBtn.setAttribute('aria-expanded', 'false');
  }
  function toggleMenu() {
    dropMenu.classList.contains('open') ? closeMenu() : openMenu();
  }

  // Toggle on click / tap
  dropBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    toggleMenu();
  });

  // Close when clicking outside
  document.addEventListener('click', function (e) {
    if (!dropBtn.contains(e.target) && !dropMenu.contains(e.target)) {
      closeMenu();
    }
  });

  // Keyboard support: Escape closes
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
  });
})();

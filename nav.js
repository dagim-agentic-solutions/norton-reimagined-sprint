// Norton Reimagined Sprint — shared mobile nav toggle
(function () {
  var btn = document.getElementById('nav-toggle');
  var links = document.getElementById('nav-links');
  if (!btn || !links) return;
  btn.addEventListener('click', function () {
    var open = links.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.classList.toggle('active', open);
  });
  // Close on outside click
  document.addEventListener('click', function (e) {
    if (!btn.contains(e.target) && !links.contains(e.target)) {
      links.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('active');
    }
  });
})();

(function(){
  let searchData = [];
  let overlay, input, resultsWrap;

  function ensureElements() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'search-overlay';
    overlay.innerHTML = `
      <div class="search-modal">
        <header>
          <h4>Universal Search</h4>
          <span style="font-size:11px;color:var(--ink-softer);">⌘K</span>
          <button type="button" aria-label="Close" onclick="window.closeSearchModal()">×</button>
        </header>
        <div class="search-input-wrap">
          <input type="text" id="searchInput" placeholder="Search pages, sections, tools..." autocomplete="off" />
        </div>
        <div class="search-results" id="searchResults"></div>
      </div>`;
    document.body.appendChild(overlay);
    input = overlay.querySelector('#searchInput');
    resultsWrap = overlay.querySelector('#searchResults');

    input.addEventListener('input', () => renderResults(input.value.trim()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = resultsWrap.querySelector('.search-result');
        if (first) first.click();
      }
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSearch();
    });
  }

  async function loadIndex() {
    if (searchData.length) return;
    try {
      const res = await fetch('/search-index.json');
      if (!res.ok) throw new Error(res.statusText);
      searchData = await res.json();
    } catch (err) {
      resultsWrap.innerHTML = `<div class="search-empty">Unable to load search index (${err.message}).</div>`;
    }
  }

  function scoreEntry(entry, query) {
    const q = query.toLowerCase();
    const title = entry.title.toLowerCase();
    const summary = entry.summary.toLowerCase();
    let score = 0;
    if (title.includes(q)) score += 3;
    if (summary.includes(q)) score += 1;
    return score;
  }

  function renderResults(query) {
    if (!query) {
      resultsWrap.innerHTML = '<div class="search-empty">Start typing to search across Concept Builder, Competitive, Resources, and more.</div>';
      return;
    }
    const matches = searchData
      .map(entry => ({ entry, score: scoreEntry(entry, query) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    if (!matches.length) {
      resultsWrap.innerHTML = `<div class="search-empty">No matches for “${query}”.</div>`;
      return;
    }

    resultsWrap.innerHTML = matches.map(item => `
      <div class="search-result" data-url="${item.entry.url}">
        <h5>${item.entry.title}</h5>
        <p>${item.entry.summary}</p>
      </div>`).join('');

    resultsWrap.querySelectorAll('.search-result').forEach(el => {
      el.addEventListener('click', () => {
        const url = el.getAttribute('data-url');
        closeSearch();
        window.location.href = url;
      });
    });
  }

  async function openSearch() {
    ensureElements();
    overlay.classList.add('open');
    await loadIndex();
    renderResults('');
    setTimeout(() => {
      input.focus();
      input.select();
    }, 10);
  }

  function closeSearch() {
    if (!overlay) return;
    overlay.classList.remove('open');
    input.value = '';
    resultsWrap.innerHTML = '';
  }

  function initNavButton() {
    const navList = document.getElementById('nav-links');
    if (navList) {
      navList.querySelectorAll('.nav-search-btn').forEach(btn => btn.remove());
    }
    const navInner = document.querySelector('.nav-inner');
    const toggle = document.getElementById('nav-toggle');
    if (!navInner || navInner.querySelector('.nav-search-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-search-btn';
    btn.innerHTML = '<span class="nav-search-icon" aria-hidden="true">🔍</span><span class="sr-only">Open search</span>';
    btn.addEventListener('click', openSearch);
    if (toggle) {
      navInner.insertBefore(btn, toggle);
    } else {
      navInner.appendChild(btn);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initNavButton();
    ensureElements();
    renderResults('');
  });

  document.addEventListener('keydown', (e) => {
    const meta = navigator.platform.match('Mac') ? e.metaKey : e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openSearch();
    } else if (e.key === 'Escape') {
      closeSearch();
    }
  });

  window.openSearchModal = openSearch;
  window.closeSearchModal = closeSearch;
})();

(function () {
  const STORAGE_KEY = 'norton:sprintAdminKey';
  let cachedKey = null;

  function loadCachedKey() {
    if (cachedKey) return cachedKey;
    cachedKey = localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(STORAGE_KEY);
    return cachedKey;
  }

  function persistKey(value) {
    cachedKey = value;
    localStorage.setItem(STORAGE_KEY, value);
    sessionStorage.setItem(STORAGE_KEY, value);
  }

  function clearKey() {
    cachedKey = null;
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  }

  async function promptForKey() {
    while (true) {
      const input = window.prompt('Enter the sprint admin key to access these tools:');
      if (input && input.trim()) {
        const trimmed = input.trim();
        persistKey(trimmed);
        return trimmed;
      }
      const retry = window.confirm('Admin key is required to continue. Try again?');
      if (!retry) throw new Error('Admin key required');
    }
  }

  async function ensureKey() {
    return loadCachedKey() || promptForKey();
  }

  async function adminFetch(url, init = {}, allowRetry = true) {
    const attempt = async (key) => {
      const headers = new Headers(init.headers || {});
      if (key) headers.set('x-admin-key', key);
      return fetch(url, { ...init, headers });
    };

    let key = loadCachedKey();
    let response = await attempt(key);

    if ((response.status === 401 || response.status === 403) && allowRetry) {
      // First failure — prompt for a key and retry once
      clearKey();
      const freshKey = await promptForKey();
      response = await attempt(freshKey);
      if (response.status === 401 || response.status === 403) {
        // Key invalid — clear cache so next call starts clean
        clearKey();
      }
    }

    return response;
  }

  window.adminAuth = {
    fetch: adminFetch,
    clear: clearKey,
    getKey: ensureKey,
  };
})();

/**
 * Shared auth helpers: token in localStorage, redirect if not logged in for protected pages.
 */
const AUTH_TOKEN_KEY = 'shop_token';
const AUTH_USER_KEY = 'shop_user';

function getToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

function getUser() {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function setAuth(user, token) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
}

function clearAuth() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: 'Bearer ' + token } : {};
}

function isLoggedIn() {
  return !!getToken();
}

/** Fetch with auth header */
function authFetch(url, options = {}) {
  const headers = { ...options.headers, ...authHeaders() };
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData) && !(options.body instanceof URLSearchParams)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  return fetch(url, { ...options, headers });
}

/** Redirect to login if not authenticated (for profile page) */
function requireAuth() {
  if (!isLoggedIn()) {
    window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
    return false;
  }
  return true;
}

/** Redirect to products if already logged in (for login/signup pages) */
function redirectIfLoggedIn() {
  if (isLoggedIn()) {
    window.location.href = '/products.html';
    return true;
  }
  return false;
}

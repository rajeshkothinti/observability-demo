(function () {
  const API = '/api';
  const pageSize = 10;
  let currentPage = 1;

  const el = (id) => document.getElementById(id);

  if (typeof isLoggedIn !== 'function' || !isLoggedIn()) {
    window.location.href = '/login.html?redirect=' + encodeURIComponent('/products.html');
    return;
  }

  const user = typeof getUser === 'function' ? getUser() : null;
  if (user) el('nav-user-name').textContent = user.name || user.email || 'User';

  el('nav-logout').addEventListener('click', (e) => {
    e.preventDefault();
    if (typeof clearAuth === 'function') clearAuth();
    window.location.href = '/';
  });

  function updateCartCount() {
    const n = typeof getCartCount === 'function' ? getCartCount() : 0;
    const span = el('cart-count');
    if (span) span.textContent = n;
  }
  updateCartCount();

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  async function fetchProducts(page) {
    const res = await fetch(`${API}/products?page=${page}&page_size=${pageSize}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body.error || body.detail || body.message || 'Failed to load products';
      throw new Error(typeof msg === 'string' ? msg : 'Failed to load products');
    }
    return body;
  }

  function renderProducts(data) {
    const products = data.data || [];
    const list = el('products-list');
    const loading = el('products-loading');
    const err = el('products-error');

    loading.hidden = true;
    err.hidden = true;
    list.hidden = false;

    list.innerHTML = products
      .map(
        (p) => `
        <div class="product-card">
          <h3>${escapeHtml(p.name)}</h3>
          <p class="description">${escapeHtml(p.description || '')}</p>
          <p class="price">$${Number(p.price).toFixed(2)}</p>
          <p class="stock">In stock: ${p.stock}</p>
          <button type="button" data-id="${p.id}" data-name="${escapeHtml(p.name)}" data-price="${p.price}" data-stock="${p.stock}">Add to cart</button>
        </div>
      `
      )
      .join('');

    list.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const d = btn.dataset;
        const stock = parseInt(d.stock, 10);
        if (stock < 1) return;
        if (typeof addToCartStored === 'function') {
          addToCartStored({
            product_id: d.id,
            name: d.name,
            price: parseFloat(d.price),
            quantity: 1,
            maxStock: stock,
          });
          updateCartCount();
        }
      });
    });

    const pag = el('products-pagination');
    const total = data.total || 0;
    const page = data.page || 1;
    const pageSizeVal = data.page_size || pageSize;
    if (total <= pageSizeVal) {
      pag.hidden = true;
    } else {
      pag.hidden = false;
      const totalPages = Math.ceil(total / pageSizeVal);
      pag.innerHTML = `
        <button type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Previous</button>
        <span>Page ${page} of ${totalPages} (${total} products)</span>
        <button type="button" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>Next</button>
      `;
      pag.querySelectorAll('button').forEach((b) => {
        b.addEventListener('click', () => loadPage(parseInt(b.dataset.page, 10)));
      });
    }
  }

  function loadPage(page) {
    currentPage = page;
    el('products-loading').hidden = false;
    el('products-list').hidden = true;
    el('products-error').hidden = true;
    fetchProducts(page)
      .then(renderProducts)
      .catch((e) => {
        el('products-loading').hidden = true;
        el('products-error').textContent = e.message || 'Failed to load products';
        el('products-error').hidden = false;
      });
  }

  loadPage(1);
})();

(function () {
  const API = '/api';

  let products = [];
  let currentPage = 1;
  const pageSize = 10;
  const cart = [];

  const el = (id) => document.getElementById(id);

  // Auth: header nav and pre-fill order form
  if (typeof isLoggedIn === 'function' && isLoggedIn()) {
    const user = typeof getUser === 'function' ? getUser() : null;
    el('nav-guest').hidden = true;
    el('nav-user').hidden = false;
    if (user) el('nav-user-name').textContent = user.name || user.email || 'User';
    el('nav-logout').addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof clearAuth === 'function') clearAuth();
      window.location.href = '/';
    });
    // Pre-fill order form from profile
    const orderForm = document.getElementById('order-form');
    if (orderForm && user) {
      orderForm.customer_id.value = user.id || '';
      orderForm.email.value = user.email || '';
      orderForm.name.value = user.name || '';
    }
  } else {
    el('nav-guest').hidden = false;
    el('nav-user').hidden = true;
  }

  async function fetchProducts(page = 1) {
    const res = await fetch(`${API}/products?page=${page}&page_size=${pageSize}`);
    if (!res.ok) throw new Error('Failed to load products');
    return res.json();
  }

  function renderProducts(data) {
    products = data.data || [];
    const list = el('products-list');
    const loading = el('products-loading');
    const err = el('products-error');

    loading.hidden = true;
    err.hidden = true;
    list.hidden = false;

    list.innerHTML = products
      .map(
        (p) => `
        <div class="product-card" data-product-id="${p.id}">
          <h3>${escapeHtml(p.name)}</h3>
          <p class="description">${escapeHtml(p.description || '')}</p>
          <p class="price">$${Number(p.price).toFixed(2)}</p>
          <p class="stock">In stock: ${p.stock}</p>
          <button type="button" data-id="${p.id}" data-name="${escapeHtml(p.name)}" data-price="${p.price}" data-stock="${p.stock}">Add to order</button>
        </div>
      `
      )
      .join('');

    list.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => addToCart(btn.dataset));
    });

    renderPagination(data.total, data.page, data.page_size);
  }

  function renderPagination(total, page, pageSizeVal) {
    const pag = el('products-pagination');
    if (total <= pageSizeVal) {
      pag.hidden = true;
      return;
    }
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

  function addToCart(dataset) {
    const stock = parseInt(dataset.stock, 10);
    if (stock < 1) return;
    const existing = cart.find((c) => c.product_id === dataset.id);
    if (existing) {
      if (existing.quantity >= stock) return;
      existing.quantity += 1;
    } else {
      cart.push({
        product_id: dataset.id,
        name: dataset.name,
        price: parseFloat(dataset.price),
        quantity: 1,
        maxStock: stock,
      });
    }
    renderCart();
  }

  function removeFromCart(index) {
    cart.splice(index, 1);
    renderCart();
  }

  function renderCart() {
    const container = el('cart-items');
    if (cart.length === 0) {
      container.innerHTML = '<p class="hint">No items. Add products above.</p>';
      return;
    }
    container.innerHTML = cart
      .map(
        (c, i) => `
        <div class="cart-line">
          <span>${escapeHtml(c.name)} × ${c.quantity} @ $${c.price.toFixed(2)} = $${(c.quantity * c.price).toFixed(2)}</span>
          <button type="button" data-index="${i}">Remove</button>
        </div>
      `
      )
      .join('');
    container.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => removeFromCart(parseInt(b.dataset.index, 10)));
    });
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  el('order-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (cart.length === 0) {
      showOrderResult('Add at least one product to the order.', false);
      return;
    }
    const form = e.target;
    const customer = {
      customer_id: form.customer_id.value.trim(),
      email: form.email.value.trim(),
      name: form.name.value.trim(),
    };
    const items = cart.map((c) => ({
      product_id: c.product_id,
      quantity: c.quantity,
      unit_price: c.price,
    }));

    const submitBtn = el('submit-order');
    submitBtn.disabled = true;
    el('order-result').hidden = true;

    try {
      const res = await fetch(`${API}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer, items }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showOrderResult(`Order placed: ${data.id}. Status: ${data.status}`, true, data);
        cart.length = 0;
        renderCart();
        form.reset();
      } else {
        showOrderResult(data.detail || data.error || `Error ${res.status}`, false, data);
      }
    } catch (err) {
      showOrderResult('Network error: ' + err.message, false);
    } finally {
      submitBtn.disabled = false;
    }
  });

  function showOrderResult(message, success, data) {
    const box = el('order-result');
    box.className = 'order-result ' + (success ? 'success' : 'error');
    box.innerHTML = '<p>' + escapeHtml(message) + '</p>' + (data ? '<pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>' : '');
    box.hidden = false;
  }

  loadPage(1);
})();

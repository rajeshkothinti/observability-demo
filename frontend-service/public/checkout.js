(function () {
  const API = '/api';

  const el = (id) => document.getElementById(id);

  if (typeof isLoggedIn !== 'function' || !isLoggedIn()) {
    window.location.href = '/login.html?redirect=' + encodeURIComponent('/checkout.html');
    return;
  }

  const user = typeof getUser === 'function' ? getUser() : null;
  if (user) el('nav-user-name').textContent = user.name || user.email || 'User';

  el('nav-logout').addEventListener('click', (e) => {
    e.preventDefault();
    if (typeof clearAuth === 'function') clearAuth();
    window.location.href = '/';
  });

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  let cart = typeof getCart === 'function' ? getCart() : [];

  function renderCart() {
    cart = typeof getCart === 'function' ? getCart() : [];
    const container = el('cart-items');
    const emptyEl = el('cart-empty');
    const form = el('order-form');

    if (cart.length === 0) {
      container.innerHTML = '';
      emptyEl.hidden = false;
      form.hidden = true;
      return;
    }
    emptyEl.hidden = true;
    form.hidden = false;

    container.innerHTML = cart
      .map(
        (c, i) => `
        <div class="cart-line">
          <span>${escapeHtml(c.name)} × ${c.quantity} @ $${Number(c.price).toFixed(2)} = $${(c.quantity * c.price).toFixed(2)}</span>
          <button type="button" data-index="${i}">Remove</button>
        </div>
      `
      )
      .join('');

    container.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        if (typeof removeFromCartStored === 'function') removeFromCartStored(parseInt(b.dataset.index, 10));
        renderCart();
      });
    });

    if (user) {
      form.customer_id.value = user.id || '';
      form.email.value = user.email || '';
      form.name.value = user.name || '';
    }
  }

  renderCart();

  el('order-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    cart = typeof getCart === 'function' ? getCart() : [];
    if (cart.length === 0) {
      showOrderResult('Your cart is empty.', false);
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

    const ORDER_TIMEOUT_MS = 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ORDER_TIMEOUT_MS);

    try {
      const res = await fetch(`${API}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer, items }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (typeof clearCart === 'function') clearCart();
        showOrderResult('Order placed: ' + data.id + '. Status: ' + data.status + '. <a href=\"/products.html\">Continue shopping</a>', true, data);
        form.hidden = true;
        el('cart-items').innerHTML = '';
      } else {
        showOrderResult(data.detail || data.error || 'Error ' + res.status, false, data);
      }
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = err.name === 'AbortError'
        ? 'Request timed out. The order service may be slow or unavailable.'
        : 'Network error: ' + (err.message || 'Could not reach server.');
      showOrderResult(msg, false);
    } finally {
      submitBtn.disabled = false;
    }
  });

  function showOrderResult(message, success, data) {
    const box = el('order-result');
    box.className = 'order-result ' + (success ? 'success' : 'error');
    box.innerHTML = '<p>' + (success ? message : escapeHtml(message)) + '</p>' + (data && !success ? '<pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>' : '');
    box.hidden = false;
  }
})();

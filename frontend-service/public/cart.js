/**
 * Cart in localStorage – shared between products and checkout pages.
 */
const CART_KEY = 'shop_cart';

function getCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

function setCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

function getCartCount() {
  return getCart().reduce((n, c) => n + (c.quantity || 0), 0);
}

function addToCartStored(item) {
  const cart = getCart();
  const existing = cart.find((c) => c.product_id === item.product_id);
  if (existing) {
    existing.quantity = Math.min((existing.quantity || 0) + (item.quantity || 1), item.maxStock != null ? item.maxStock : 999);
  } else {
    cart.push({
      product_id: item.product_id,
      name: item.name,
      price: parseFloat(item.price),
      quantity: item.quantity || 1,
      maxStock: item.maxStock,
    });
  }
  setCart(cart);
  return cart;
}

function removeFromCartStored(index) {
  const cart = getCart();
  cart.splice(index, 1);
  setCart(cart);
  return cart;
}

function clearCart() {
  setCart([]);
}

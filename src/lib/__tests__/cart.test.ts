import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock global window and localStorage before importing the client-store
const mockStore: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => mockStore[key] || null,
  setItem: (key: string, value: string) => {
    mockStore[key] = value;
  },
  removeItem: (key: string) => {
    delete mockStore[key];
  },
  clear: () => {
    for (const key in mockStore) {
      delete mockStore[key];
    }
  },
};

global.window = {
  localStorage: mockLocalStorage,
  dispatchEvent: () => true,
} as unknown as Window & typeof globalThis;

global.CustomEvent = class CustomEvent extends Event {
  constructor(type: string) {
    super(type);
  }
} as any;

// Import our client-store modules which use window.localStorage
import { getCart, addToCart, updateCartQty, removeFromCart, clearCart, type CartItem } from "@/lib/client-store";

describe("Shopping Cart Logic", () => {
  beforeEach(() => {
    mockLocalStorage.clear();
  });

  it("retrieves an empty cart initially", () => {
    expect(getCart()).toEqual([]);
  });

  it("can add a new unique product to the cart", () => {
    const item: CartItem = {
      id: "prod-1",
      slug: "luxury-watch",
      title: "Luxury Watch",
      image: "watch.jpg",
      price: 3500,
      mrp: 4500,
      variant: "Silver",
      qty: 2,
      sku: "WTCH-01",
    };

    addToCart(item);
    const cart = getCart();
    expect(cart).toHaveLength(1);
    expect(cart[0]).toEqual(item);
  });

  it("increments quantity when adding the exact same product and variant", () => {
    const item: CartItem = {
      id: "prod-1",
      slug: "luxury-watch",
      title: "Luxury Watch",
      image: "watch.jpg",
      price: 3500,
      mrp: 4500,
      variant: "Silver",
      qty: 2,
      sku: "WTCH-01",
    };

    addToCart(item);
    addToCart({ ...item, qty: 1 }); // add same item again with quantity 1

    const cart = getCart();
    expect(cart).toHaveLength(1);
    expect(cart[0].qty).toBe(3); // total quantity should be 3
  });

  it("adds as separate items if the variant is different", () => {
    const item1: CartItem = {
      id: "prod-1",
      slug: "luxury-watch",
      title: "Luxury Watch",
      image: "watch.jpg",
      price: 3500,
      mrp: 4500,
      variant: "Silver",
      qty: 1,
      sku: "WTCH-01",
    };

    const item2: CartItem = {
      id: "prod-1",
      slug: "luxury-watch",
      title: "Luxury Watch",
      image: "watch.jpg",
      price: 3500,
      mrp: 4500,
      variant: "Gold",
      qty: 1,
      sku: "WTCH-01",
    };

    addToCart(item1);
    addToCart(item2);

    const cart = getCart();
    expect(cart).toHaveLength(2);
    expect(cart[0].variant).toBe("Silver");
    expect(cart[1].variant).toBe("Gold");
  });

  it("can update an item's quantity directly", () => {
    const item: CartItem = {
      id: "prod-1",
      slug: "luxury-watch",
      title: "Luxury Watch",
      image: "watch.jpg",
      price: 3500,
      mrp: 4500,
      variant: "Silver",
      qty: 1,
      sku: "WTCH-01",
    };

    addToCart(item);
    updateCartQty("prod-1", "Silver", 5);

    const cart = getCart();
    expect(cart[0].qty).toBe(5);
  });

  it("removes item from cart when quantity is set to 0 or less", () => {
    const item: CartItem = {
      id: "prod-1",
      slug: "luxury-watch",
      title: "Luxury Watch",
      image: "watch.jpg",
      price: 3500,
      mrp: 4500,
      variant: "Silver",
      qty: 1,
      sku: "WTCH-01",
    };

    addToCart(item);
    updateCartQty("prod-1", "Silver", 0);

    expect(getCart()).toHaveLength(0);
  });

  it("can remove an item by id and variant", () => {
    const item: CartItem = {
      id: "prod-1",
      slug: "luxury-watch",
      title: "Luxury Watch",
      image: "watch.jpg",
      price: 3500,
      mrp: 4500,
      variant: "Silver",
      qty: 1,
      sku: "WTCH-01",
    };

    addToCart(item);
    removeFromCart("prod-1", "Silver");

    expect(getCart()).toHaveLength(0);
  });

  it("can clear the entire cart", () => {
    addToCart({
      id: "prod-1",
      slug: "luxury-watch",
      title: "Luxury Watch",
      image: "watch.jpg",
      price: 3500,
      mrp: 4500,
      qty: 1,
      sku: "WTCH-01",
    });
    addToCart({
      id: "prod-2",
      slug: "designer-bag",
      title: "Designer Bag",
      image: "bag.jpg",
      price: 4000,
      mrp: 5000,
      qty: 1,
      sku: "BAG-01",
    });

    expect(getCart()).toHaveLength(2);
    clearCart();
    expect(getCart()).toHaveLength(0);
  });
});

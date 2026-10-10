import { MtajirStore } from "../schema/store.schema.js";

export const SEED_STORE: MtajirStore = {
  id: "store_darb_001",
  name: "Darb Roastery",
  slug: "darb-roastery",
  description: "Specialty coffee beans and artisanal brewing equipment roasted in Riyadh.",
  currency: "SAR",
  locale: "ar",
  status: "active",
  theme: {
    logoUrl: "https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd",
    colors: {
      primary: "#1E293B",
      secondary: "#D97706",
      background: "#FFFFFF",
      text: "#0F172A",
    },
    typography: {
      fontFamily: "Tajawal",
      headingFont: "Tajawal",
    },
    banner: {
      enabled: false,
      text: "Free shipping across Saudi Arabia on orders over 150 SAR!",
      backgroundColor: "#D97706",
      linkUrl: "",
    },
  },
  navigation: [
    { id: "nav_1", label: "Home", url: "/", order: 0, children: [] },
    { id: "nav_2", label: "Coffee Beans", url: "/collections/coffee", order: 1, children: [] },
    { id: "nav_3", label: "Brewing Gear", url: "/collections/gear", order: 2, children: [] },
    { id: "nav_4", label: "About Us", url: "/about", order: 3, children: [] },
  ],
  products: [
    {
      id: "prod_001",
      title: "Ethiopian Yirgacheffe",
      description: "Floral notes with citrus and bergamot finish. Light roast.",
      price: 65,
      compareAtPrice: 75,
      sku: "COF-ETH-001",
      inventory: 40,
      status: "active",
      categories: ["Single Origin", "Coffee Beans"],
    },
    {
      id: "prod_002",
      title: "Colombian Huila",
      description: "Caramel sweetness with red apple acidity. Medium roast.",
      price: 58,
      sku: "COF-COL-002",
      inventory: 25,
      status: "active",
      categories: ["Single Origin", "Coffee Beans"],
    },
    {
      id: "prod_003",
      title: "V60 Ceramic Dripper",
      description: "Size 02 pour-over coffee brewer in matte white.",
      price: 90,
      sku: "GEAR-V60-WHT",
      inventory: 15,
      status: "active",
      categories: ["Brewing Gear"],
    },
  ],
  shippingZones: [
    {
      id: "zone_sa",
      name: "Saudi Arabia (Domestic)",
      countries: ["SA"],
      rates: [
        { id: "rate_std", name: "Standard Delivery (2-4 days)", price: 25, freeAboveAmount: 200 },
        { id: "rate_exp", name: "Express Riyadh Same-Day", price: 40 },
      ],
    },
  ],
  paymentProviders: [
    { id: "mada", name: "Mada Debit Card", enabled: true, testMode: false },
    { id: "apple_pay", name: "Apple Pay", enabled: true, testMode: false },
    { id: "credit_card", name: "Visa / Mastercard", enabled: true, testMode: false },
    { id: "tabby", name: "Tabby (Split in 4)", enabled: false, testMode: true },
    { id: "cod", name: "Cash on Delivery", enabled: false, testMode: false },
  ],
  policies: {
    refundPolicy: "Returns accepted within 14 days for unopened beans and equipment.",
    shippingPolicy: "Orders are processed within 24 hours from Sunday to Thursday.",
    termsOfService: "Standard Mtajir commercial terms apply.",
  },
  version: 1,
  updatedAt: new Date().toISOString(),
};

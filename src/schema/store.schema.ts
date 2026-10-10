import { z } from "zod";

// Hex color validator regex
const hexColorRegex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const ColorSchema = z
  .string()
  .regex(hexColorRegex, { message: "Must be a valid hex color code (e.g. #FFFFFF or #000)" });

export const NavigationItemSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.string(),
    label: z.string().min(1, "Navigation label cannot be empty"),
    url: z.string(),
    order: z.number().int().nonnegative(),
    children: z.array(NavigationItemSchema).optional().default([]),
  })
);

export const ProductSchema = z.object({
  id: z.string(),
  title: z.string().min(1, "Product title cannot be empty"),
  description: z.string().default(""),
  price: z.number().nonnegative("Price must be 0 or greater"),
  compareAtPrice: z.number().nonnegative().optional(),
  sku: z.string().min(1, "SKU is required"),
  inventory: z.number().int().nonnegative("Inventory cannot be negative"),
  status: z.enum(["active", "draft", "archived"]).default("active"),
  categories: z.array(z.string()).default([]),
});

export const ShippingRateSchema = z.object({
  id: z.string(),
  name: z.string().min(1, "Rate name cannot be empty"),
  price: z.number().nonnegative("Shipping price cannot be negative"),
  freeAboveAmount: z.number().nonnegative().optional(),
});

export const ShippingZoneSchema = z.object({
  id: z.string(),
  name: z.string().min(1, "Zone name cannot be empty"),
  countries: z.array(z.string()).min(1, "At least one country code required"),
  rates: z.array(ShippingRateSchema).min(1, "At least one shipping rate required"),
});

export const PaymentProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  testMode: z.boolean().default(false),
});

export const StoreThemeSchema = z.object({
  logoUrl: z.string().url().optional().or(z.literal("")),
  colors: z.object({
    primary: ColorSchema,
    secondary: ColorSchema,
    background: ColorSchema,
    text: ColorSchema,
  }),
  typography: z.object({
    fontFamily: z.string().default("Inter"),
    headingFont: z.string().default("Inter"),
  }),
  banner: z.object({
    enabled: z.boolean().default(false),
    text: z.string().default(""),
    backgroundColor: ColorSchema.default("#2563EB"),
    linkUrl: z.string().optional().or(z.literal("")),
  }),
});

export const StorePoliciesSchema = z.object({
  refundPolicy: z.string().default(""),
  shippingPolicy: z.string().default(""),
  termsOfService: z.string().default(""),
});

export const MtajirStoreSchema = z.object({
  id: z.string(),
  name: z.string().min(2, "Store name must be at least 2 characters"),
  slug: z.string().min(2, "Slug must be at least 2 characters"),
  description: z.string().default(""),
  currency: z.enum(["SAR", "AED", "KWD", "QAR", "BHD", "OMR", "USD"]).default("SAR"),
  locale: z.enum(["ar", "en"]).default("ar"),
  status: z.enum(["draft", "active", "maintenance"]).default("active"),
  theme: StoreThemeSchema,
  navigation: z.array(NavigationItemSchema).default([]),
  products: z.array(ProductSchema).default([]),
  shippingZones: z.array(ShippingZoneSchema).default([]),
  paymentProviders: z.array(PaymentProviderSchema).default([]),
  policies: StorePoliciesSchema.default({
    refundPolicy: "",
    shippingPolicy: "",
    termsOfService: "",
  }),
  version: z.number().int().positive().default(1),
  updatedAt: z.string().default(() => new Date().toISOString()),
});

export type MtajirStore = z.infer<typeof MtajirStoreSchema>;
export type StoreTheme = z.infer<typeof StoreThemeSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type ShippingZone = z.infer<typeof ShippingZoneSchema>;
export type PaymentProvider = z.infer<typeof PaymentProviderSchema>;
export type NavigationItem = z.infer<typeof NavigationItemSchema>;

---
id: doc_products_inventory
title: Managing Products, SKUs, and Stock
category: Catalog
entities: ["Product", "SKU", "Inventory", "Categories"]
supportedCurrencies: ["SAR", "AED", "KWD", "QAR", "BHD", "OMR", "USD"]
supportedCountries: ["SA", "AE", "KW", "QA", "BH", "OM"]
requiresCommercialRegistration: false
relatedDocs: ["doc_shipping_zones", "doc_version_rollback"]
tags: ["products", "sku", "inventory", "stock", "catalog", "price", "discount", "categories", "منتجات", "مخزون", "اسعار", "تصنيفات"]
---

# Managing Products, SKUs, and Stock

Every product in the Mtajir catalog (`/products`) requires a unique `id`, `title`, `sku`, non-negative `price`, and integer `inventory` stock count.

## Pricing, Discounts, and Bulk Updates
Products support a regular `price` and an optional `compareAtPrice` to show strikethrough sale pricing. Using Khadoom AI, merchants can adjust individual product prices (`/products[id=prod_001]/price`) or apply store-wide percentage discounts and markups across all products (`/products[*]/price`) or specific categories (`/products[categories=Coffee Beans]/price`).

## Stock Management and Product Status
Inventory counts (`/products[id=prod_001]/inventory`) are automatically clamped at `0` so stock never becomes negative. Products can be categorized into collections via `categories` and marked as `active` (visible in storefront), `draft` (hidden while editing), or `archived`.

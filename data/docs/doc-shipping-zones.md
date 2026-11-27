---
id: doc_shipping_zones
title: Setting Up Shipping Zones and Rates
category: Shipping
entities: ["ShippingZone", "ShippingRate"]
supportedCurrencies: ["SAR", "AED", "KWD", "QAR", "BHD", "OMR", "USD"]
supportedCountries: ["SA", "AE", "KW", "QA", "BH", "OM"]
requiresCommercialRegistration: false
relatedDocs: ["doc_payment_providers", "doc_products_inventory"]
tags:
  [
    "shipping",
    "delivery",
    "rates",
    "zones",
    "free shipping",
    "domestic",
    "express",
    "شحن",
    "توصيل",
    "مناطق الشحن",
    "شحن مجاني",
  ]
---

# Setting Up Shipping Zones and Rates

Shipping in Mtajir is configured through geographical zones (`/shippingZones`), such as Saudi Arabia Domestic (`zone_sa`), GCC, or International.

## Tiered Shipping Rates

Each shipping zone contains one or more delivery rates (`/shippingZones[id=zone_sa]/rates`), such as Standard Delivery (`rate_std`) and Express Same-Day Delivery (`rate_exp`). Every rate specifies a `name` and a non-negative `price`.

## Free Shipping Thresholds

You can incentivize larger basket sizes by setting `freeAboveAmount` on any shipping rate (for example, free Standard Delivery on orders over 200 SAR via `/shippingZones[id=zone_sa]/rates[id=rate_std]/freeAboveAmount`).

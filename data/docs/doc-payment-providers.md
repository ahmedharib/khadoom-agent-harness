---
id: doc_payment_providers
title: Configuring Payment Gateways in Mtajir
category: Payments
entities: ["PaymentProvider", "Mada", "ApplePay", "CreditCard", "Tabby", "COD"]
supportedCurrencies: ["SAR", "AED", "KWD", "QAR", "BHD", "OMR", "USD"]
supportedCountries: ["SA", "AE", "KW", "QA", "BH", "OM"]
requiresCommercialRegistration: false
relatedDocs: ["doc_payment_tabby", "doc_payment_knet", "doc_shipping_zones"]
tags: ["payment", "mada", "apple pay", "tabby", "credit card", "cod", "cash on delivery", "checkout", "مدى", "دفع", "بوابات الدفع", "الدفع عند الاستلام"]
---

# Configuring Payment Gateways in Mtajir

Mtajir supports regional and global payment gateways including Mada (`mada`), Apple Pay (`apple_pay`), Credit Card Visa/Mastercard (`credit_card`), Tabby (`tabby`), and Cash on Delivery (`cod`).

## Enabling and Disabling Gateways
Each payment provider in `/paymentProviders` can be toggled via its `enabled` boolean flag (e.g., `/paymentProviders[id=cod]/enabled`). Merchants can enable multiple gateways simultaneously so customers can choose their preferred method at checkout.

## Sandbox and Test Mode
Payment providers include a `testMode` property (`/paymentProviders[id=tabby]/testMode`). When `testMode` is `true`, checkout transactions are routed through the sandbox environment so you can verify payment flows before launching to the public.

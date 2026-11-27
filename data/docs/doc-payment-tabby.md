---
id: doc_payment_tabby
title: Configuring Tabby (Buy Now, Pay Later)
category: Payments
entities: ["Tabby", "PaymentProvider", "BNPL"]
supportedCurrencies: ["SAR", "AED"]
supportedCountries: ["SA", "AE"]
requiresCommercialRegistration: true
relatedDocs: ["doc_payment_providers"]
tags: ["installments", "bnpl", "checkout", "tabby", "finance", "mada", "تابي", "تقسيط", "دفعات"]
---

# Tabby Integration Guide

Mtajir integrates natively with Tabby (`id: tabby`) to allow merchants in Saudi Arabia (`SAR`) and the UAE (`AED`) to split customer purchases into 4 interest-free installments (Buy Now, Pay Later / BNPL).

## Eligibility and Requirements
To activate Tabby in live mode, your store must operate in `SAR` or `AED` and you must hold an active Saudi or UAE Commercial Registration (CR / السجل التجاري) or Freelance Certificate (وثيقة العمل الحر).

## Activation Steps
1. Navigate to `/settings/payments` or ask Khadoom AI to enable Tabby (`/paymentProviders[id=tabby]/enabled`).
2. Verify checkout behavior while `testMode` is set to `true`.
3. Switch `testMode` to `false` once your merchant account is verified.

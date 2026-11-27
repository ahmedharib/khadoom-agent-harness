---
id: doc_version_rollback
title: Store Versioning and Safe Rollbacks
category: System
entities: ["StagingSession", "StoreRepository", "VersionChangelogEntry"]
supportedCurrencies: ["SAR", "AED", "KWD", "QAR", "BHD", "OMR", "USD"]
supportedCountries: ["SA", "AE", "KW", "QA", "BH", "OM"]
requiresCommercialRegistration: false
relatedDocs: ["doc_theme_customization", "doc_products_inventory"]
tags: ["versioning", "rollback", "snapshots", "history", "staging", "undo", "revert", "استرجاع", "نسخ", "سجل التغييرات"]
---

# Store Versioning and Safe Rollbacks

Every store modification proposed by Khadoom AI enters a reversible staging phase and is validated against the Mtajir schema before going live.

## Immutable Snapshots and High-Water Mark Versioning
Every time a staged update is accepted, Mtajir automatically snapshots the entire store state into an immutable version file (`v1.json`, `v2.json`, `v3.json`, ...) alongside an audit changelog entry. Version numbers strictly increment from the highest recorded version (high-water mark) so historical snapshots are never overwritten even after a rollback.

## Rolling Back to a Previous Version
If you want to revert your store to an earlier state, use the deterministic CLI command `/rollback <version_number>` (for example, `/rollback 1`). You can view all historical snapshots, timestamps, and patch summaries at any time by running `/history`.

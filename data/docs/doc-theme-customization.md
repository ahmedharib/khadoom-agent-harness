---
id: doc_theme_customization
title: Customizing Store Colors and Typography
category: Design & Themes
entities: ["StoreTheme", "ColorSchema", "Banner", "Typography"]
supportedCurrencies: ["SAR", "AED", "KWD", "QAR", "BHD", "OMR", "USD"]
supportedCountries: ["SA", "AE", "KW", "QA", "BH", "OM"]
requiresCommercialRegistration: false
relatedDocs: ["doc_version_rollback"]
tags: ["theme", "colors", "hex", "font", "typography", "banner", "branding", "logo", "ثيم", "الوان", "شعار", "خطوط", "بنر"]
---

# Customizing Store Colors and Typography

Mtajir stores support full visual branding customization through the `theme` configuration object, including colors, typography, logos, and promotional announcement banners.

## Theme Colors and Hex Validation
Mtajir stores support full hex code customization (`#RRGGBB` or `#RGB`) for four core palette slots:
- **Primary Color (`/theme/colors/primary`)**: Used for primary action buttons, active navigation highlights, and key accents.
- **Secondary Color (`/theme/colors/secondary`)**: Used for badges, secondary buttons, and promotional highlights.
- **Background Color (`/theme/colors/background`)**: Main page canvas background color.
- **Text Color (`/theme/colors/text`)**: Primary body and heading text color.

## Promotional Announcement Banner
The top announcement banner (`/theme/banner`) can be toggled on or off (`enabled: true | false`) to announce flash sales, National Day promotions, or free shipping notices. You can customize `/theme/banner/text`, `/theme/banner/backgroundColor`, and `/theme/banner/linkUrl`.

## Typography and Fonts
Fonts can be configured independently for body text (`/theme/typography/fontFamily`) and headings (`/theme/typography/headingFont`). Popular Arabic and bilingual fonts include `Tajawal`, `Cairo`, and `Inter`.

# Lattice logo — integration guide

## Files in this package

| File | Use |
|---|---|
| `lattice-mark-mocha.svg` | Primary mark, dark backgrounds (Mocha theme) |
| `lattice-mark-latte.svg` | Primary mark, light backgrounds (Latte theme) |
| `lattice-wordmark-mocha.svg` | Mark + "lattice" + AI.NEWS tagline — dark |
| `lattice-wordmark-latte.svg` | Mark + "lattice" + AI.NEWS tagline — light |
| `favicon.svg` | Adaptive favicon — auto-switches on system theme |
| `favicon.ico` | Multi-resolution ICO (16, 32, 48) for legacy browsers |
| `favicon-16x16.png` | Explicit 16px PNG |
| `favicon-32x32.png` | Explicit 32px PNG |
| `favicon-48x48.png` | Explicit 48px PNG |
| `apple-touch-icon.png` | 180×180 — iOS home screen |
| `android-chrome-192x192.png` | 192×192 — PWA manifest |
| `android-chrome-512x512.png` | 512×512 — PWA manifest |
| `site.webmanifest` | PWA manifest file |

## HTML `<head>` snippet

Drop this into the `<head>` of `readlattice.co`:

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#1e1e2e">
```

## Colour reference (Catppuccin)

**Mocha (dark):**
- Teal primary: `#94e2d5`
- Pink accent: `#f5c2e7`
- Backgrounds: crust `#11111b`, mantle `#181825`, base `#1e1e2e`
- Text: `#cdd6f4`

**Latte (light):**
- Teal primary: `#179299`
- Pink accent: `#ea76cb`
- Backgrounds: base `#eff1f5`
- Text: `#4c4f69`

## Minimum sizing

- Favicon: works down to 12px but 16px recommended minimum
- Full mark (with interior edges): 24px minimum
- Wordmark lockup: 120px minimum width for legibility

## Clear space

Keep padding equal to ~25% of the mark height on all sides.

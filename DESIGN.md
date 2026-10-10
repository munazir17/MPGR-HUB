---
name: MPGR HUB
preset: base-maia
colors:
  canvas: "#05080F"
  elevated: "#070C16"
  surface: "#0A101B"
  surface-2: "#0D1524"
  ink: "#EEF3FA"
  muted: "#8FA0B6"
  primary: "#4DA3FF"
  primary-pressed: "#2472EB"
  primary-glow: "#8CC7FF"
  on-primary: "#FFFFFF"
  gold: "#E2C073"
  gold-2: "#DDB765"
  good: "#3DDC84"
  bad: "#FF6B6B"
  hairline: "#182234"
rounded:
  control: 16px
  card: 24px
  pill: 999px
typography:
  sans: Inter
  mono: ui-monospace
spacing:
  control: 44px
  control-lg: 56px
---

# MPGR HUB

Base-native product UI. Dark, restrained, one blue and one gold. Not a generic light SaaS theme and not a glow-pill crypto landing page.

## Overview

The live app already paints with these tokens (`tailwind.config.ts`, `app/globals.css`). shadcn/ui on **Base UI** (`style: base-maia`) is the component foundation for new work. Geometry follows maia: 44–56px controls, 16px control radius, 24px cards, generous padding. The stock maia palette and Figtree face are not used.

Existing screens keep `.btn-primary` and feature components. New screens use `@/components/ui/button` and the other Base UI primitives. Do not restyle a shipped screen in the same change as a behavior fix.

## Colors

| Role | Token | Use |
| --- | --- | --- |
| Page floor | `background` `#05080F` | `bg-background`. One cool top glow lives on `body::before`. Do not add grids or particles. |
| Elevated | `elevated` `#070C16` | Nav, sticky bars. |
| Card | `surface` `#0A101B` | Cards, inputs, dialogs. |
| Soft band | `surface-2` `#0D1524` | Secondary buttons, tab tracks. |
| Ink | `foreground` `#EEF3FA` | Headlines and body. |
| Secondary text | `muted` `#8FA0B6` | Descriptions. This token is text, never a fill. |
| Primary | `primary` `#4DA3FF` | CTA fill, links, focus. |
| Pressed | `primary-2` `#2472EB` | The lip under the extruded primary button. |
| On primary | `primary-foreground` `#FFFFFF` | Text on the blue CTA. |
| Gold | `gold` `#E2C073` | Rank, premium, one accent per view. Not a second CTA. |
| Good / bad | `good` `#3DDC84` / `bad` `#FF6B6B` | Status only. Destructive actions are outlined, not filled. |
| Hairline | `border` `#182234` | 1px structural borders. |

`muted` stays a text color. Ghost and tab tracks use `accent` `#122033` or `surface-2`, never `bg-muted`.

## Typography

Inter only, already loaded as `--font-sans`. Do not swap in Figtree, a serif, or a display face.

- Page title: weight 700, tracking `-0.03em` to `-0.04em`, line-height about 1.0–1.04 (`.display-l`, `.display-xl`).
- Section kicker: `.eyebrow` — 11px, semibold, uppercase, tracking `0.18em`, `text-muted`.
- UI labels: 14px semibold. Badges: 11px semibold uppercase.
- Mono is for addresses and amounts only.

## Layout

- Controls: default 44px (`h-11`), large 56px (`h-14`). Icon buttons match those heights. 44px is the floor on touch.
- Cards: `rounded-2xl` (24px in this config), `border-border`, `bg-surface`, `shadow-soft`.
- Dialogs: same card recipe, max width `sm:max-w-md`, scrim `bg-black/70` with a light blur.
- Space sections with `gap-6` inside cards. Do not invent a new spacing scale.

## Elevation

Hairline first. Shadows are quiet.

- Card: `shadow-soft` — inset top sheen plus a short drop shadow.
- Primary button: extruded lip (`0 3px 0 #1e63db`) and a small blue shadow. Press collapses it (`translate-y-0.5` and `scale-[0.98]`).
- Dialog / toast: `shadow-glow-lg`.
- Do not add neon glows, animated gradients, or glassmorphism stacks.

## Shapes

- Controls and inputs: `rounded-xl` (16px). Not pills.
- Cards and dialogs: `rounded-2xl`.
- Badges: `rounded-full`.
- Do not use `rounded-4xl` or Tailwind v4-only utilities. This app is Tailwind v3.

## Components

Base UI, not Radix. Triggers take `render={<a href="…" />}` or `nativeButton={false}`. Never `asChild`.

| Recipe | Component |
| --- | --- |
| Primary CTA | `Button` `default`. Same extrusion as `.btn-primary`. |
| Secondary | `Button` `outline` or `secondary`. |
| Nav / quiet | `Button` `ghost`. |
| Destructive | `Button` `destructive`. Red outline, not a filled red button. |
| Status chip | `Badge`. Gold variant is the only extra recipe. |
| Field | `Input` `h-11`, surface fill, blue focus ring. |
| Tabs | `Tabs`. Active tab is `surface` on a `surface-2` track. |
| Toast | `toast.add({ title, description, type })` from `@/components/ui/toast`. `Toaster` is mounted in `Providers`. |

Icons stay `lucide-react`.

## Do's and Don'ts

- Do keep Base chain UI on this dark system. One blue CTA per region.
- Do use the primitives in `components/ui/{button,card,badge,input,separator,tabs,tooltip,dialog,toast}.tsx`.
- Don't overwrite `components/ui/Skeleton.tsx`. A lowercase `skeleton.tsx` collides on macOS.
- Don't remap `background`, `primary`, `border`, or `muted` in `tailwind.config.ts` onto shadcn's default light tokens.
- Don't import `shadcn/tailwind.css`. It is Tailwind v4 (`@theme`) and this app is Tailwind v3.
- Don't put a second global `* { border-color }` or `body { background }` rule on top of the existing shell.
- Don't use gold as a button fill.
- Don't let an agent "refresh" the whole hub onto the stock maia theme.

## Known gaps

- Tailwind stays on v3, so official registry components are restyled to v3 utilities after `shadcn add`. Re-check new primitives for `rounded-4xl`, `data-open:`, `h-(--token)`, and `has-data-[]`.
- Not every shipped screen uses these primitives yet. Adopt them when that screen is already being edited.
- The showcase is `/design-system`. It is not linked from the nav.

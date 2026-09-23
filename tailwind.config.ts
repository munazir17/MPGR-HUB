import type { Config } from "tailwindcss";

// MPGR HUB — premium design tokens.
// Dark, Base-native, restrained: deep neutral-navy surfaces, one blue
// accent + one gold accent, hairline borders, layered soft shadows.
const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: [
          "ui-monospace",
          "SF Mono",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        background: "#05080F",
        elevated: "#070C16",
        surface: "#0A101B",
        "surface-2": "#0D1524",
        border: "#182234",
        primary: "#4DA3FF",
        "primary-glow": "#8CC7FF",
        "primary-2": "#2472EB",
        gold: "#E2C073",
        "gold-glow": "#F3DA9B",
        "gold-2": "#DDB765",
        good: "#3DDC84",
        bad: "#FF6B6B",
        muted: "#8FA0B6",
      },
      backgroundImage: {
        "gradient-premium": "linear-gradient(180deg, #55A9FF 0%, #2472EB 100%)",
        "gradient-blue": "linear-gradient(135deg, #3E97FF 0%, #1E63DB 100%)",
        "gradient-gold": "linear-gradient(180deg, #F3DA9B 0%, #DDB765 100%)",
        "gradient-radial":
          "radial-gradient(circle at center, var(--tw-gradient-stops))",
        "gradient-mesh":
          "radial-gradient(ellipse 70% 42% at 50% -12%, rgba(77,163,255,0.10), transparent 60%), radial-gradient(ellipse 42% 28% at 100% 0%, rgba(226,192,115,0.05), transparent 55%)",
        "gradient-shine":
          "linear-gradient(115deg, transparent 20%, rgba(255,255,255,0.06) 40%, rgba(255,255,255,0.10) 50%, rgba(255,255,255,0.06) 60%, transparent 80%)",
        // Card fill: a faint top-lit sheen over the surface color.
        "gradient-surface":
          "linear-gradient(180deg, rgba(255,255,255,0.032) 0%, rgba(255,255,255,0.010) 100%)",
      },
      boxShadow: {
        glow: "0 0 24px rgba(77, 163, 255, 0.10)",
        "glow-gold": "0 0 20px rgba(226, 192, 115, 0.10)",
        "glow-lg": "0 24px 64px -24px rgba(0, 0, 0, 0.65)",
        "glow-gold-lg": "0 12px 32px rgba(3, 8, 20, 0.4)",
        soft: "inset 0 1px 0 0 rgba(255,255,255,0.03), 0 12px 32px -16px rgba(0,0,0,0.55)",
        "inner-top": "inset 0 1px 0 0 rgba(255,255,255,0.05)",
      },
      borderRadius: {
        xl: "1rem",
        "2xl": "1.5rem",
        "3xl": "2rem",
      },
      transitionTimingFunction: {
        out: "cubic-bezier(.23, 1, .32, 1)",
      },
      transitionDuration: {
        fast: "120ms",
        med: "200ms",
        slow: "400ms",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-6px)" },
        },
        // Agent Core (components/features/agent/AgentCore.tsx): a slow
        // ±6px idle hover. 6s — a calm instrument, not a bobbing toy.
        "core-float": {
          "0%, 100%": { transform: "translateY(-6px)" },
          "50%": { transform: "translateY(6px)" },
        },
        // Contact-shadow breathing, phase-locked to the core float.
        "core-shadow": {
          "0%, 100%": { transform: "translateY(6px) scale(1)", opacity: "0.55" },
          "50%": { transform: "translateY(-6px) scale(0.9)", opacity: "0.35" },
        },
        "glow-pulse": {
          "0%, 100%": { opacity: "0.45" },
          "50%": { opacity: "0.9" },
        },
        shine: {
          "0%": { backgroundPosition: "-150% 0" },
          "100%": { backgroundPosition: "150% 0" },
        },
        // Base Stocks live tape (components/markets/LiveTape.tsx): the
        // track holds N identical copies of the interleaved chip
        // sequence and translates by exactly one copy
        // (-100% / --tape-copies), so the loop is seamless. The variable
        // defaults to 2, which is the original -50% behavior when unset.
        // Paired with hover:animation-play-state-paused for "pause on
        // hover".
        "core-filament": {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        marquee: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(calc(-100% / var(--tape-copies, 2)))" },
        },
      },
      animation: {
        shimmer: "shimmer 2.2s linear infinite",
        float: "float 5s ease-in-out infinite",
        "core-float": "core-float 6s ease-in-out infinite",
        "core-shadow": "core-shadow 6s ease-in-out infinite",
        "core-filament": "core-filament 9s linear infinite",
        "glow-pulse": "glow-pulse 3s ease-in-out infinite",
        shine: "shine 3s ease-in-out infinite",
        "tape-marquee": "marquee 48s linear infinite",
        "tape-marquee-fast": "marquee 32s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;

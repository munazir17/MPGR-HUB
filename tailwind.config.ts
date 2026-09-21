import type { Config } from "tailwindcss";

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
      },
      colors: {
        background: "#070B14",
        surface: "#0E1628",
        "surface-2": "#121C32",
        border: "#1C2A42",
        primary: "#38BDF8",
        "primary-glow": "#7DD3FC",
        gold: "#E8C36A",
        "gold-glow": "#F5D78A",
        muted: "#8B9BB4",
      },
      backgroundImage: {
        "gradient-premium": "linear-gradient(135deg, #38BDF8 0%, #2563EB 100%)",
        "gradient-blue": "linear-gradient(135deg, #38BDF8 0%, #1D4ED8 100%)",
        "gradient-gold": "linear-gradient(135deg, #F5D78A 0%, #E8C36A 100%)",
        "gradient-radial": "radial-gradient(circle at center, var(--tw-gradient-stops))",
        "gradient-mesh":
          "radial-gradient(ellipse 80% 50% at 18% -12%, rgba(56,189,248,0.14), transparent 58%), radial-gradient(ellipse 60% 40% at 100% 0%, rgba(37,99,235,0.10), transparent 55%)",
        "gradient-shine":
          "linear-gradient(115deg, transparent 20%, rgba(255,255,255,0.08) 40%, rgba(255,255,255,0.14) 50%, rgba(255,255,255,0.08) 60%, transparent 80%)",
      },
      boxShadow: {
        glow: "0 0 28px rgba(56, 189, 248, 0.12)",
        "glow-gold": "0 0 20px rgba(232, 195, 106, 0.12)",
        "glow-lg": "0 16px 40px rgba(3, 8, 20, 0.45)",
        "glow-gold-lg": "0 12px 32px rgba(3, 8, 20, 0.4)",
        soft: "0 8px 28px rgba(3, 8, 20, 0.35)",
        "inner-top": "inset 0 1px 0 0 rgba(255,255,255,0.05)",
      },
      borderRadius: {
        xl: "1rem",
        "2xl": "1.5rem",
        "3xl": "1.75rem",
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
        "glow-pulse": {
          "0%, 100%": { opacity: "0.45" },
          "50%": { opacity: "0.9" },
        },
        shine: {
          "0%": { backgroundPosition: "-150% 0" },
          "100%": { backgroundPosition: "150% 0" },
        },
        // Base Stocks live tape (components/markets/LiveTape.tsx): the
        // track holds two identical chip sequences and translates exactly
        // -50%, so the loop is seamless. Paired with hover:animation-play-
        // state-paused for "pause on hover".
        marquee: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
      },
      animation: {
        shimmer: "shimmer 2s linear infinite",
        float: "float 5s ease-in-out infinite",
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

import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#0A0B0D",
        surface: "#111318",
        border: "#1E2128",
        primary: "#3B82F6",
        "primary-glow": "#60A5FA",
        gold: "#F0B90B",
        "gold-glow": "#FCD34D",
        muted: "#9CA3AF",
      },
      backgroundImage: {
        "gradient-premium": "linear-gradient(135deg, #3B82F6 0%, #1D4ED8 50%, #F0B90B 100%)",
        "gradient-blue": "linear-gradient(135deg, #3B82F6 0%, #1E40AF 100%)",
        "gradient-gold": "linear-gradient(135deg, #FCD34D 0%, #F0B90B 100%)",
        "gradient-radial": "radial-gradient(circle at center, var(--tw-gradient-stops))",
        "gradient-mesh":
          "radial-gradient(ellipse 80% 60% at 20% -10%, rgba(59,130,246,0.20), transparent 60%), radial-gradient(ellipse 70% 50% at 100% 0%, rgba(240,185,11,0.14), transparent 60%)",
        "gradient-shine":
          "linear-gradient(115deg, transparent 20%, rgba(255,255,255,0.10) 40%, rgba(255,255,255,0.16) 50%, rgba(255,255,255,0.10) 60%, transparent 80%)",
      },
      boxShadow: {
        glow: "0 0 40px rgba(59, 130, 246, 0.25)",
        "glow-gold": "0 0 40px rgba(240, 185, 11, 0.2)",
        "glow-lg": "0 8px 32px rgba(0, 0, 0, 0.35), 0 0 60px rgba(59, 130, 246, 0.18)",
        "glow-gold-lg": "0 8px 32px rgba(0, 0, 0, 0.35), 0 0 60px rgba(240, 185, 11, 0.22)",
        soft: "0 4px 24px rgba(0, 0, 0, 0.28)",
        "inner-top": "inset 0 1px 0 0 rgba(255,255,255,0.06)",
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
          "0%, 100%": { opacity: "0.5" },
          "50%": { opacity: "1" },
        },
        shine: {
          "0%": { backgroundPosition: "-150% 0" },
          "100%": { backgroundPosition: "150% 0" },
        },
      },
      animation: {
        shimmer: "shimmer 2s linear infinite",
        float: "float 5s ease-in-out infinite",
        "glow-pulse": "glow-pulse 3s ease-in-out infinite",
        shine: "shine 3s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;

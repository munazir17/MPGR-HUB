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
      },
      boxShadow: {
        glow: "0 0 40px rgba(59, 130, 246, 0.25)",
        "glow-gold": "0 0 40px rgba(240, 185, 11, 0.2)",
      },
      borderRadius: {
        xl: "1rem",
        "2xl": "1.5rem",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        shimmer: "shimmer 2s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;

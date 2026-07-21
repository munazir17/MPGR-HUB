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
        muted: "#9CA3AF",
      },
      boxShadow: {
        glow: "0 0 40px rgba(59, 130, 246, 0.25)",
      },
      borderRadius: {
        xl: "1rem",
        "2xl": "1.5rem",
      },
    },
  },
  plugins: [],
};

export default config;
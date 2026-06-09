/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        bg:             "var(--bg)",
        surface:        "var(--surface)",
        surface2:       "var(--surface-2)",
        surface3:       "var(--surface-3)",
        border:         "var(--border)",
        "border-light": "var(--border-light)",
        accent:         "var(--accent)",
        "accent-hover": "var(--accent-hover)",
        "accent-dim":   "var(--accent-dim)",
        "accent-contrast": "var(--accent-contrast)",
        text:           "var(--text)",
        "text-secondary": "var(--text-secondary)",
        "text-muted":   "var(--text-muted)",
        success:        "var(--success)",
        warning:        "var(--warning)",
        error:          "var(--error)",
        "error-dim":    "var(--error-dim)",
      },
      borderRadius: {
        sm: "6px",
        DEFAULT: "10px",
        md: "12px",
        lg: "16px",
        xl: "20px",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      }
    },
  },
  plugins: [
    require("@tailwindcss/forms"),
  ],
}


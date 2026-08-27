import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'background': 'rgb(var(--atlas-background-rgb) / <alpha-value>)',
        'surface': 'rgb(var(--atlas-surface-rgb) / <alpha-value>)',
        'surface-muted': 'rgb(var(--atlas-muted-rgb) / <alpha-value>)',
        'foreground': 'rgb(var(--atlas-foreground-rgb) / <alpha-value>)',
        'muted-foreground': 'rgb(var(--atlas-secondary-rgb) / <alpha-value>)',
        'border': 'rgb(var(--atlas-border-rgb) / <alpha-value>)',
        'primary': 'rgb(var(--atlas-action-rgb) / <alpha-value>)',
        'primary-hover': 'rgb(var(--atlas-action-hover-rgb) / <alpha-value>)',
        'primary-ink': 'rgb(var(--atlas-link-rgb) / <alpha-value>)',
        'accent': 'rgb(var(--atlas-accent-rgb) / <alpha-value>)',
        'success': 'rgb(var(--atlas-success-rgb) / <alpha-value>)',
        'success-bg': 'rgb(var(--atlas-success-bg-rgb) / <alpha-value>)',
        'warning': 'rgb(var(--atlas-warning-rgb) / <alpha-value>)',
        'warning-bg': 'rgb(var(--atlas-warning-bg-rgb) / <alpha-value>)',
        'danger': 'rgb(var(--atlas-danger-rgb) / <alpha-value>)',
        'danger-bg': 'rgb(var(--atlas-danger-bg-rgb) / <alpha-value>)',
        'violet': 'rgb(var(--atlas-violet-rgb) / <alpha-value>)',
        'violet-bg': 'rgb(var(--atlas-violet-bg-rgb) / <alpha-value>)',
        'info': 'rgb(var(--atlas-link-rgb) / <alpha-value>)',
        'primary-foreground': '#ffffff',
      },
      fontFamily: { sans: ['var(--font-outfit)', 'Outfit', 'system-ui', 'sans-serif'], mono: ['ui-monospace', 'SFMono-Regular', 'monospace'] },
      borderRadius: {
        '4xl': '2rem',
      },
      boxShadow: {
        'elevation-1': '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        'elevation-2': '0 4px 6px -1px rgba(0,0,0,0.07), 0 2px 4px -1px rgba(0,0,0,0.04)',
        'elevation-3': '0 10px 15px -3px rgba(0,0,0,0.08), 0 4px 6px -2px rgba(0,0,0,0.04)',
        'elevation-4': '0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)',
      },
      animation: {
        'slide-in': 'slideIn 0.2s ease-out',
        'fade-in': 'fadeIn 0.3s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        slideIn: {
          '0%': { transform: 'translateY(-8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}

export default config

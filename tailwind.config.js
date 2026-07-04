/**
 * Tailwind build config — replaces the runtime Play CDN (cdn.tailwindcss.com).
 *
 * The `theme.extend` block below is copied 1:1 from the old inline
 * `tailwind.config = {...}` that lived in index.html, so the generated CSS
 * matches the CDN output exactly.
 *
 * The safelist covers class names the app BUILDS AT RUNTIME from data, e.g.
 * `bg-${template.color}-50` in the permissions UI (script.js ~11785-11907).
 * The static scanner cannot see those, so they are listed here explicitly.
 * Color families used in data objects: amber, blue, cyan, emerald, indigo,
 * purple, rose, slate, violet (grep `color: '` in script.js to re-check).
 * If you ever add a NEW color name to PERMISSION_TEMPLATES / PERMISSION_MODULES,
 * add it to the pattern lists below and re-run:  npm run build:css
 */
const DYNAMIC_COLORS = '(amber|blue|cyan|emerald|indigo|purple|rose|slate|violet)';

module.exports = {
  darkMode: 'class',
  content: ['./index.html', './script.js'],
  safelist: [
    { pattern: new RegExp(`^bg-${DYNAMIC_COLORS}-(50|100|600|800)$`), variants: ['hover', 'dark', 'dark:hover'] },
    { pattern: new RegExp(`^bg-${DYNAMIC_COLORS}-900/20$`), variants: ['dark', 'dark:hover'] },
    { pattern: new RegExp(`^text-${DYNAMIC_COLORS}-(400|600)$`), variants: ['dark', 'group-hover'] },
    { pattern: new RegExp(`^border-${DYNAMIC_COLORS}-(300|500|700)$`), variants: ['hover', 'dark:hover'] },
    { pattern: new RegExp(`^ring-${DYNAMIC_COLORS}-500$`), variants: ['focus'] },
  ],
  theme: {
    extend: {
      colors: {
        slate: {
          850: '#151e2e',
          900: '#0f172a',
          950: '#020617',
        },
      },
      animation: {
        'fade-in-up': 'fadeInUp 0.8s cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-slow': 'pulse 6s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'blob': 'blob 20s infinite alternate',
        'shimmer': 'shimmer 2.5s linear infinite',
        'shake': 'shake 0.3s ease-in-out',
      },
      keyframes: {
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(40px) scale(0.95)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        blob: {
          '0%': { transform: 'translate(0px, 0px) scale(1)' },
          '33%': { transform: 'translate(50px, -50px) scale(1.2)' },
          '66%': { transform: 'translate(-40px, 20px) scale(0.8)' },
          '100%': { transform: 'translate(0px, 0px) scale(1)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-1000px 0' },
          '100%': { backgroundPosition: '1000px 0' },
        },
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '25%': { transform: 'translateX(-5px)' },
          '75%': { transform: 'translateX(5px)' },
        },
      },
    },
  },
};

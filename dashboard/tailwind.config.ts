import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: { DEFAULT: '#1a1a2e', light: '#16213e', lighter: '#1e2d4a' },
        accent: { green: '#00ff88', red: '#ff4444', yellow: '#ffaa00', blue: '#4da6ff' },
      },
    },
  },
  plugins: [],
} satisfies Config;

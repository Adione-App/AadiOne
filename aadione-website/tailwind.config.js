/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    container: {
      center: true,
      padding: '1.25rem',
    },
    extend: {
      colors: {
        // Aadione brand tokens
        cream: {
          DEFAULT: '#FCFBF6',
          50: '#FFFFFF',
          100: '#FCFBF6',
          200: '#F5F2E9',
        },
        ink: {
          DEFAULT: '#0E2E22',
          light: '#1B4636',
        },
        leaf: {
          50: '#EEF7EE',
          100: '#D8EDDA',
          200: '#B2DBB6',
          300: '#83C48C',
          400: '#57AC66',
          500: '#2F8F45',
          600: '#1F7A3B',
          700: '#176230',
          800: '#124D28',
          900: '#0E3D20',
        },
        mango: {
          DEFAULT: '#F0A63C',
          light: '#FCE3B4',
          dark: '#C97F1F',
        },
      },
      fontFamily: {
        display: ['"Fraunces"', 'ui-serif', 'Georgia', 'serif'],
        sans: ['"Manrope"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        blob: '42% 58% 65% 35% / 45% 40% 60% 55%',
      },
      boxShadow: {
        soft: '0 20px 45px -20px rgba(14, 46, 34, 0.25)',
        card: '0 10px 30px -12px rgba(14, 46, 34, 0.18)',
      },
      keyframes: {
        floaty: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-14px)' },
        },
        riseIn: {
          '0%': { opacity: 0, transform: 'translateY(18px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
      },
      animation: {
        floaty: 'floaty 6s ease-in-out infinite',
        riseIn: 'riseIn 0.7s ease-out both',
      },
    },
  },
  plugins: [],
}

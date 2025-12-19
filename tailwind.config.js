/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./web/views/**/*.ejs", "./web/static/js/**/*.js"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        // ViniPlay-inspired color palette
        primary: {
          50: '#fef2f2',
          100: '#fee2e2',
          200: '#fecaca',
          300: '#fca5a5',
          400: '#f87171',
          500: '#E50914',  // Netflix-style red
          600: '#dc2626',
          700: '#b91c1c',
          800: '#991b1b',
          900: '#7f1d1d',
          950: '#450a0a',
        },
        // Deep blacks for ViniPlay style
        dark: {
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#e5e5e5',
          300: '#d4d4d4',
          400: '#a3a3a3',
          500: '#737373',
          600: '#525252',
          700: '#404040',
          800: '#262626',
          900: '#171717',
          950: '#0a0a0a',
          // Named shades
          bg: '#0A0A0A',
          card: '#141414',
          surface: '#1F1F1F',
          border: '#2D2D2D',
          hover: '#333333',
        },
        // Text colors
        text: {
          primary: '#FFFFFF',
          secondary: '#B3B3B3',
          muted: '#808080',
        },
        // Accent colors
        success: {
          400: '#4ade80',
          500: '#46D369',
          600: '#16a34a',
        },
        warning: {
          400: '#fbbf24',
          500: '#F5A623',
          600: '#d97706',
        },
        danger: {
          400: '#f87171',
          500: '#E50914',
          600: '#dc2626',
        },
        info: {
          400: '#60a5fa',
          500: '#0080FF',
          600: '#2563eb',
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'hero-gradient': 'linear-gradient(180deg, transparent 0%, rgba(10, 10, 10, 0.6) 50%, rgba(10, 10, 10, 1) 100%)',
        'hero-gradient-top': 'linear-gradient(0deg, transparent 0%, rgba(10, 10, 10, 0.8) 100%)',
        'card-gradient': 'linear-gradient(180deg, transparent 0%, rgba(10, 10, 10, 0.95) 100%)',
        'row-fade-left': 'linear-gradient(90deg, rgba(10, 10, 10, 1) 0%, transparent 100%)',
        'row-fade-right': 'linear-gradient(270deg, rgba(10, 10, 10, 1) 0%, transparent 100%)',
      },
      boxShadow: {
        'glow': '0 0 20px rgba(229, 9, 20, 0.3)',
        'glow-lg': '0 0 40px rgba(229, 9, 20, 0.4)',
        'glow-white': '0 0 20px rgba(255, 255, 255, 0.1)',
        'card': '0 4px 6px -1px rgba(0, 0, 0, 0.5), 0 2px 4px -2px rgba(0, 0, 0, 0.5)',
        'card-hover': '0 20px 40px -10px rgba(0, 0, 0, 0.6)',
        'header': '0 4px 30px rgba(0, 0, 0, 0.5)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'fade-in-up': 'fadeInUp 0.4s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-in-right': 'slideInRight 0.3s ease-out',
        'slide-in-left': 'slideInLeft 0.3s ease-out',
        'scale-in': 'scaleIn 0.2s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'shimmer': 'shimmer 2s infinite linear',
        'carousel': 'carousel 8s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(20px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        slideInLeft: {
          '0%': { opacity: '0', transform: 'translateX(-20px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      spacing: {
        '18': '4.5rem',
        '88': '22rem',
        'header': '64px',
      },
      borderRadius: {
        'xl': '0.75rem',
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
      height: {
        'hero': '55vh',
        'hero-sm': '40vh',
      },
      transitionDuration: {
        '400': '400ms',
      },
      zIndex: {
        'header': '100',
        'modal': '200',
        'toast': '300',
      },
    },
  },
  plugins: [],
}

import { createTheme } from '@mui/material/styles'

/**
 * The page's only colour source. Two schemes of one identity: cool neutrals,
 * violet as the single accent (focus, the new-messages pill, the arrival tint),
 * green means live, amber means reconnecting or waiting for Discord, and nothing else is coloured.
 * Each colour is darkened for light so text and status dots keep their contrast.
 * The page follows the OS until the reader picks a mode (ThemeToggle in app.tsx).
 */
/** The page background per scheme; also the browser's toolbar colour. */
export const GROUND = { dark: '#0D0E11', light: '#F7F8FA' }

export const theme = createTheme({
  cssVariables: { colorSchemeSelector: 'data-color-scheme' },
  colorSchemes: {
    dark: {
      palette: {
        background: { default: GROUND.dark, paper: '#15171B' },
        divider: '#24272E',
        text: { primary: '#E7E8EB', secondary: '#A0A5AE' },
        primary: { main: '#A493F7', contrastText: '#0D0E11' },
        success: { main: '#4CC38A' },
        warning: { main: '#E5A93B' },
      },
    },
    light: {
      palette: {
        background: { default: GROUND.light, paper: '#FFFFFF' },
        divider: '#E1E3E8',
        text: { primary: '#16181D', secondary: '#5C626E' },
        primary: { main: '#5B45D6', contrastText: '#FFFFFF' },
        success: { main: '#1A8F5C' },
        warning: { main: '#B7791F' },
      },
    },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontSize: 14,
    body1: { fontSize: 15, lineHeight: 1.5 },
    body2: { fontSize: 14, lineHeight: 1.45 },
    caption: { fontSize: 12, lineHeight: 1.4, fontVariantNumeric: 'tabular-nums' },
    subtitle2: { fontSize: 14, fontWeight: 600, lineHeight: 1.3 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        html: { scrollbarColor: 'var(--mui-palette-divider) var(--mui-palette-background-default)' },
        body: { caretColor: 'var(--mui-palette-primary-main)', WebkitFontSmoothing: 'antialiased' },
        '::selection': { backgroundColor: 'rgba(var(--mui-palette-primary-mainChannel) / 0.35)', color: 'var(--mui-palette-text-primary)' },
        ':focus-visible': { outline: '2px solid var(--mui-palette-primary-main)', outlineOffset: 2 },
      },
    },
  },
})

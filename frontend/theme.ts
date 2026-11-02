import { alpha, createTheme } from '@mui/material/styles'

/**
 * The page's only colour source. Dark by design: reviewers keep it open
 * beside Discord on a laptop. Violet is the single accent (focus, the
 * new-messages pill, the arrival tint); green means live, amber means
 * reconnecting, and nothing else is coloured.
 */
const ground = '#0D0E11'
const surface = '#15171B'
const line = '#24272E'
const ink = '#E7E8EB'
const inkMuted = '#A0A5AE'
const accent = '#A493F7'

export const theme = createTheme({
  palette: {
    mode: 'dark',
    background: { default: ground, paper: surface },
    divider: line,
    text: { primary: ink, secondary: inkMuted },
    primary: { main: accent, contrastText: ground },
    success: { main: '#4CC38A' },
    warning: { main: '#E5A93B' },
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
        html: { colorScheme: 'dark', scrollbarColor: `${line} ${ground}` },
        body: { caretColor: accent, WebkitFontSmoothing: 'antialiased' },
        '::selection': { backgroundColor: alpha(accent, 0.35), color: ink },
        ':focus-visible': { outline: `2px solid ${accent}`, outlineOffset: 2 },
      },
    },
  },
})

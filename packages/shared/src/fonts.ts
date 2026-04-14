export const GEIST_VERSION = "1.7.0"

export const GEIST_SANS_WOFF2_URL = `https://cdn.jsdelivr.net/npm/geist@${GEIST_VERSION}/dist/fonts/geist-sans/Geist-Variable.woff2`
export const GEIST_MONO_WOFF2_URL = `https://cdn.jsdelivr.net/npm/geist@${GEIST_VERSION}/dist/fonts/geist-mono/GeistMono-Variable.woff2`

export function getGeistFontFaceCss(): string {
  return `@font-face {
  font-family: 'Geist';
  src: url('${GEIST_SANS_WOFF2_URL}') format('woff2');
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
}
@font-face {
  font-family: 'Geist Mono';
  src: url('${GEIST_MONO_WOFF2_URL}') format('woff2');
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
}`
}

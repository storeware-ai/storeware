/**
 * The stylesheet behind `@storeware/app-ui`, as a string.
 *
 * Every colour, corner and typeface here is one of the 13 `--sw-*` variables
 * the admin posts to a framed page (`theme` in App Bridge), and nothing else:
 * no colour of our own, so a page built from these components looks like the
 * admin around it in whatever scheme the admin is in. `AppUiStyles` puts it in
 * the page; `createAppBridge`'s `applyTheme`, or `AppBridgeProvider`, sets the
 * variables.
 */

/** The 13 variables, in the order the admin sends them. */
export const SW_VARIABLES = [
  '--sw-bg',
  '--sw-surface',
  '--sw-fg',
  '--sw-muted',
  '--sw-line',
  '--sw-accent',
  '--sw-accent-fg',
  '--sw-ok',
  '--sw-warn',
  '--sw-bad',
  '--sw-radius',
  '--sw-font-sans',
  '--sw-font-mono',
] as const;

const tone = (name: 'ok' | 'warn' | 'bad', colour: string) => `
.sw-badge-${name} { color: var(${colour}); border-color: color-mix(in oklab, var(${colour}) 45%, var(--sw-line)); }
.sw-banner-${name} { border-inline-start-color: var(${colour}); background: color-mix(in oklab, var(${colour}) 8%, var(--sw-surface)); }
.sw-text-${name} { color: var(${colour}); }`;

export const css = `
.sw-page { box-sizing: border-box; min-height: 100%; padding: 16px; background: var(--sw-bg); color: var(--sw-fg); font-family: var(--sw-font-sans); font-size: 14px; line-height: 1.5; }
.sw-page *, .sw-page *::before, .sw-page *::after { box-sizing: border-box; }
.sw-card { background: var(--sw-surface); border: 1px solid var(--sw-line); border-radius: var(--sw-radius); padding: 16px; }
.sw-card-title { margin: 0 0 12px; font-size: 15px; font-weight: 600; line-height: 1.3; }
.sw-stack { display: flex; flex-direction: column; }
.sw-inline { display: flex; flex-wrap: wrap; align-items: center; }
.sw-gap-tight { gap: 4px; }
.sw-gap-base { gap: 12px; }
.sw-gap-loose { gap: 24px; }
.sw-heading { margin: 0; color: var(--sw-fg); font-weight: 600; line-height: 1.25; }
.sw-heading-1 { font-size: 22px; }
.sw-heading-2 { font-size: 17px; }
.sw-heading-3 { font-size: 15px; }
.sw-text { margin: 0; }
.sw-text-small { font-size: 12px; }
.sw-text-muted { color: var(--sw-muted); }
.sw-mono { font-family: var(--sw-font-mono); }
.sw-button { appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 0 12px; border: 1px solid var(--sw-line); border-radius: var(--sw-radius); background: var(--sw-surface); color: var(--sw-fg); font: inherit; font-weight: 500; cursor: pointer; }
.sw-button:hover { border-color: var(--sw-muted); }
.sw-button:disabled { opacity: 0.5; cursor: not-allowed; }
.sw-button-primary { background: var(--sw-accent); border-color: var(--sw-accent); color: var(--sw-accent-fg); }
.sw-button-primary:hover { border-color: var(--sw-accent); opacity: 0.9; }
.sw-button-danger { background: var(--sw-bad); border-color: var(--sw-bad); color: var(--sw-bg); }
.sw-button-danger:hover { border-color: var(--sw-bad); opacity: 0.9; }
.sw-button-plain { background: transparent; border-color: transparent; color: var(--sw-accent); padding: 0 4px; }
.sw-button:focus-visible, .sw-input:focus-visible, .sw-select:focus-visible, .sw-checkbox input:focus-visible { outline: 2px solid var(--sw-accent); outline-offset: 2px; }
.sw-field { display: flex; flex-direction: column; gap: 4px; }
.sw-label { font-weight: 500; }
.sw-hint { color: var(--sw-muted); font-size: 12px; }
.sw-error { color: var(--sw-bad); font-size: 12px; }
.sw-input, .sw-select { width: 100%; min-height: 36px; padding: 6px 10px; border: 1px solid var(--sw-line); border-radius: var(--sw-radius); background: var(--sw-bg); color: var(--sw-fg); font: inherit; }
.sw-input[aria-invalid='true'] { border-color: var(--sw-bad); }
.sw-checkbox { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.sw-checkbox input { width: 16px; height: 16px; margin: 0; accent-color: var(--sw-accent); }
.sw-badge { display: inline-flex; align-items: center; padding: 1px 8px; border: 1px solid var(--sw-line); border-radius: 999px; color: var(--sw-muted); font-size: 12px; font-weight: 500; }
.sw-banner { border: 1px solid var(--sw-line); border-inline-start-width: 3px; border-inline-start-color: var(--sw-accent); border-radius: var(--sw-radius); padding: 12px 14px; background: var(--sw-surface); }
.sw-banner-title { margin: 0 0 4px; font-weight: 600; }
.sw-spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--sw-line); border-top-color: var(--sw-accent); border-radius: 50%; animation: sw-spin 0.8s linear infinite; }
.sw-divider { margin: 0; border: 0; border-top: 1px solid var(--sw-line); }
.sw-empty { padding: 32px 16px; color: var(--sw-muted); text-align: center; }
.sw-empty-title { margin: 0 0 4px; color: var(--sw-fg); font-weight: 600; }
.sw-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
${tone('ok', '--sw-ok')}
${tone('warn', '--sw-warn')}
${tone('bad', '--sw-bad')}
@keyframes sw-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .sw-spinner { animation: none; } }
`;

// Browser-only progressive operator UI. Presentation helpers are also imported
// by Node tests, so keep DOM code behind an explicit runtime boundary.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  await import('./operator-browser.js');
}

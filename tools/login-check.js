// Login check for the paid services the reading pipeline depends on. Run with the
// Playwright MCP tool `browser_run_code_unsafe` (filename: tools/login-check.js)
// BEFORE any crawl. The Playwright profile persists across sessions, so a login done
// once in that browser window sticks — but verify every run: a preview summary of a
// paid source is a failure, not a fallback.
async (page) => {
  const checks = [
    { service: 'substack', url: 'https://substack.com/home', loggedIn: () => !document.body.innerText.match(/\bSign in\b/) || !!document.querySelector('a[href="/inbox"], a[href="/notes"], [data-testid="user-menu"], img[alt*="avatar" i]') },
    { service: 'x', url: 'https://x.com/home', loggedIn: () => !/\/i\/flow\/login|\/login/.test(location.href) && !!document.querySelector('a[href="/home"][aria-label], a[data-testid="AppTabBar_Home_Link"]') },
    { service: 'medium', url: 'https://medium.com/me', loggedIn: () => !/signin|sign-in|login/.test(location.href) },
    { service: 'linkedin', url: 'https://www.linkedin.com/feed/', loggedIn: () => !/login|authwall|signup/.test(location.href) },
  ];
  const out = [];
  for (const c of checks) {
    try {
      await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      const ok = await page.evaluate(c.loggedIn);
      out.push(`${c.service}: ${ok ? 'logged in' : 'LOGGED OUT'}  (${page.url().split('?')[0]})`);
    } catch (e) {
      out.push(`${c.service}: ERROR ${String(e).slice(0, 80)}`);
    }
  }
  return out.join('\n');
}

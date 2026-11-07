// Browser crawl for the processor and the monitor. Run it with the Playwright MCP tool
// `browser_run_code_unsafe` (filename: tools/crawl.js) while `bun tools/sink.ts` is up.
//
// Reads  <work>/readlist.json : [{ n, url, source?, title?, date?, time?, key? }]
//        <work>/range.json    : [from, to]  — inclusive n range for this batch (10–12 per run)
// Writes <work>/<n>.txt       : the page text (never passes through the conversation)
//        <work>/<n>.json      : meta — finalUrl, h1, time, paywall, byline, chars, attachedArticle
//
// Extraction order: .available-content (Substack) → article → main → body. Substack
// notes are cut at "Related notes" and report the first attached /p/ link, so the
// orchestrator can decide thin-note→article. "Show more" buttons are clicked first.
async (page) => {
  const SINK = 'http://127.0.0.1:4399/';
  const get = async (name) => (await page.request.get(SINK + name)).json();
  const save = (name, body) => page.request.post(SINK, { data: { name, body } });
  const list = await get('readlist.json');
  const range = await get('range.json');
  const results = [];
  for (const it of list) {
    if (it.n < range[0] || it.n > range[1]) continue;
    const meta = { ...it };
    try {
      await page.goto(it.target || it.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3500);
      try { await page.evaluate(() => { for (const b of document.querySelectorAll('button')) if (/^(…more|Show more|See more)$/i.test(b.innerText.trim())) b.click(); }); } catch {}
      const r = await page.evaluate(() => {
        const pick = (sel) => { const e = document.querySelector(sel); return e && e.innerText.trim().length > 200 ? e : null; };
        const el = pick('.available-content') || pick('article') || pick('main') || document.body;
        let text = el.innerText;
        const isNote = /\/note\/[cp]-/.test(location.pathname) && !document.querySelector('.available-content');
        if (isNote) { const i = text.indexOf('Related notes'); if (i > 0) text = text.slice(0, i); }
        const h1 = document.querySelector('h1')?.innerText.trim() || '';
        const time = document.querySelector('time')?.getAttribute('datetime') || '';
        const paywall = !!document.querySelector('.paywall, [class*="paywall"], [data-testid="paywall"]');
        const byline = Array.from(document.querySelectorAll('a[href*="/@"], [rel="author"], .author-name, [class*="byline"] a')).map(a => a.innerText.trim()).filter(t => t && t.length < 60).slice(0, 3);
        const art = isNote ? Array.from(document.querySelectorAll('a[href*="/p/"]')).find(a => a.innerText.trim()) : null;
        return { finalUrl: location.href.split('?')[0], h1, time, paywall, byline, chars: text.length, text, selector: el.className || el.tagName, attachedArticle: art ? art.getAttribute('href').split('?')[0] : '' };
      });
      await save(`${it.n}.txt`, r.text);
      delete r.text;
      Object.assign(meta, r);
    } catch (e) {
      meta.error = String(e).slice(0, 200);
    }
    await save(`${it.n}.json`, JSON.stringify(meta, null, 1));
    results.push(`${meta.n} ${meta.chars ?? 'ERR'} ${meta.paywall ? 'PAYWALL ' : ''}${(meta.h1 || meta.title || meta.url).slice(0, 60)}${meta.attachedArticle ? ' → ' + meta.attachedArticle : ''}${meta.error ? ' :: ' + meta.error : ''}`);
    await page.waitForTimeout(4000);
  }
  return results.join('\n');
}

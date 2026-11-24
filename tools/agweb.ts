// agweb reader for the processor and the monitor: a WebKit browser driven from the shell
// (https://github.com/paul-nameless/agweb, macOS 26+, app in /Applications). Its named profile
// `reading` keeps the logins (Substack, X, LinkedIn, Medium) across sessions. A domain that must be
// read with another account gets its own profile: `agwebProfiles` in the gitignored
// monitor.local.json maps domain → profile (subdomains included); the crawl routes each item by it.
//
//   bun tools/agweb.ts login-check [domain …]   which account each service / Substack domain is on
//   bun tools/agweb.ts crawl <work> <from> <to> read readlist items n=from…to into <work>/<n>.txt + .json
//
// Same readlist and meta as tools/crawl.js, but the CLI writes the files itself: no sink, and
// the text never passes through the conversation. Text is agweb's `text` (article as markdown);
// a short result falls back to `text --all`.
import { $ } from "bun";

export const AGWEB = process.env.AGWEB_BIN ?? "/Applications/Agweb.app/Contents/Helpers/agweb";
export const PROFILE = process.env.AGWEB_PROFILE ?? "reading";

/** The profile for a URL: the longest `map` entry matching its host (www. ignored), else `fallback`. */
export function profileFor(url: string, map: Record<string, string>, fallback = PROFILE): string {
  let host: string;
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { return fallback; }
  let best = "", prof = fallback;
  for (const [d, p] of Object.entries(map)) {
    const dd = d.replace(/^www\./, "");
    if ((host === dd || host.endsWith("." + dd)) && dd.length > best.length) { best = dd; prof = p; }
  }
  return prof;
}

async function profileMap(): Promise<Record<string, string>> {
  const f = Bun.file(`${import.meta.dir}/../monitor.local.json`);
  if (!(await f.exists())) return {};
  return (await f.json()).agwebProfiles ?? {};
}

/** The value of an `eval` reply: the line after "### Result", JSON-decoded (twice if the page returned a JSON string). */
export function parseEval(out: string): unknown {
  const lines = out.split("\n");
  const i = lines.findIndex((l) => l.trim() === "### Result");
  if (i < 0) throw new Error(out.trim().split("\n")[0] || "no result");
  const end = lines.findIndex((l, j) => j > i && l.startsWith("### "));
  let v: unknown = JSON.parse(lines.slice(i + 1, end < 0 ? undefined : end).join("\n"));
  if (typeof v === "string") try { v = JSON.parse(v); } catch {}
  return v;
}

/** The markdown of a `text` reply, without agweb's "### Page" header and trailing note lines. */
export function cleanText(out: string): string {
  const lines = out.split("\n");
  const r = lines.findIndex((l) => l.trim() === "### Result");
  let body = r >= 0 ? lines.slice(r + 1) : lines;
  const end = body.findIndex((l) => /^### (Page|Changes|Console|Requests)\b/.test(l));
  if (end >= 0) body = body.slice(0, end);
  body = body.filter((l) => !/^- Note: main content only/.test(l));
  return body.join("\n").trim();
}

// A workspace name carries its profile after "@" (rq-crawl-1@substack-old); plain names use PROFILE.
async function ag(w: string, ...args: string[]): Promise<string> {
  const [name, prof = PROFILE] = w.split("@");
  const r = await $`${AGWEB} ${["-w", `${name}-${prof}`, "-p", prof]} ${args}`.nothrow().quiet();
  return r.stdout.toString() + r.stderr.toString();
}
async function load(w: string, url: string, settle = 3500) {
  await ag(w, "goto", url);
  await ag(w, "wait", "--load", "--timeout=30000");
  await ag(w, "wait", String(settle));
}
async function evaluate(w: string, js: string): Promise<any> {
  return parseEval(await ag(w, "eval", js));
}

const META_JS = `() => {
  for (const b of document.querySelectorAll('button')) if (/^(…more|Show more|See more)$/i.test(b.innerText.trim())) b.click();
  const isNote = /\\/note\\/[cp]-/.test(location.pathname) && !document.querySelector('.available-content');
  const art = isNote ? [...document.querySelectorAll('a[href*="/p/"]')].find(a => a.innerText.trim()) : null;
  const p = window._preloads;
  return JSON.stringify({
    finalUrl: location.href.split('?')[0],
    h1: (document.querySelector('h1.post-title') || document.querySelector('article h1') || document.querySelector('h1'))?.innerText.trim() || document.title,
    published: document.querySelector('time')?.getAttribute('datetime') || p?.post?.post_date || '',
    paywall: !!document.querySelector('.paywall:not(.paywall-jump), [data-testid="paywall"]'),
    audience: p?.post?.audience || '',
    handle: p ? (p.user?.handle || 'none') : '',
    byline: [...document.querySelectorAll('a[href*="/@"], [rel="author"], .author-name, [class*="byline"] a')].map(a => a.innerText.trim()).filter(t => t && t.length < 60).slice(0, 3),
    attachedArticle: art ? art.getAttribute('href').split('?')[0] : '',
  });
}`;

async function crawl(work: string, from: number, to: number) {
  const list: any[] = await Bun.file(`${work}/readlist.json`).json();
  const map = process.env.AGWEB_PROFILE ? {} : await profileMap();
  const opened = new Set<string>();
  for (const it of list) {
    if (it.n < from || it.n > to) continue;
    const meta: any = { ...it };
    const prof = profileFor(it.target || it.url, map);
    const w = `rq-crawl-${from}@${prof}`;
    if (!opened.has(w)) { await ag(w, "open"); opened.add(w); }
    if (prof !== PROFILE) meta.profile = prof;
    try {
      await load(w, it.target || it.url);
      Object.assign(meta, await evaluate(w, META_JS));
      await ag(w, "wait", "1000");
      let text = cleanText(await ag(w, "text"));
      if (text.length < 400) text = cleanText(await ag(w, "text", "--all"));
      meta.chars = text.length;
      await Bun.write(`${work}/${it.n}.txt`, text);
    } catch (e) {
      meta.error = String(e).slice(0, 200);
    }
    await Bun.write(`${work}/${it.n}.json`, JSON.stringify(meta, null, 1));
    const paid = meta.audience === "only_paid" ? ` paid handle=${meta.handle}${meta.profile ? ` profile=${meta.profile}` : ""}` : "";
    console.log(`${meta.n} ${meta.chars ?? "ERR"} ${meta.paywall ? "PAYWALL " : ""}${String(meta.h1 || meta.title || meta.url).slice(0, 60)}${paid}${meta.attachedArticle ? " → " + meta.attachedArticle : ""}${meta.error ? " :: " + meta.error : ""}`);
    await Bun.sleep(4000);
  }
  for (const w of opened) await ag(w, "close");
}

const SERVICES = [
  { service: "substack", url: "https://substack.com/home", js: `() => window._preloads?.user?.handle || 'LOGGED OUT'` },
  { service: "x", url: "https://x.com/home", js: `() => /login|flow/.test(location.href) || !/(^|; )twid=/.test(document.cookie) ? 'LOGGED OUT' : 'logged in'` },
  { service: "linkedin", url: "https://www.linkedin.com/feed/", js: `() => /login|authwall|signup/.test(location.href) ? 'LOGGED OUT' : 'logged in'` },
  { service: "medium", url: "https://medium.com/me", js: `() => /signin|sign-in|login/.test(location.href) ? 'LOGGED OUT' : 'logged in'` },
];

async function loginCheck(domains: string[]) {
  const w = "rq-login-check";
  await ag(w, "open");
  for (const s of SERVICES) {
    try { await load(w, s.url, 2500); console.log(`${s.service}: ${await evaluate(w, s.js)}`); }
    catch (e) { console.log(`${s.service}: ERROR ${String(e).slice(0, 80)}`); }
  }
  // Custom Substack domains keep their own login. /account?lli=1 copies substack.com's account
  // onto most of them; a domain that stays "none" needs a sign-in in agweb (`agweb … ask`).
  for (const d of domains) {
    try {
      await load(w, `https://${d}/`, 2500);
      let h = await evaluate(w, `() => window._preloads?.user?.handle || 'none'`);
      if (h === "none") {
        await load(w, `https://${d}/account?lli=1`, 4000);
        await load(w, `https://${d}/`, 2500);
        h = await evaluate(w, `() => window._preloads?.user?.handle || 'none'`);
      }
      console.log(`${d}: ${h === "none" ? "NOT SIGNED IN" : h}`);
    } catch (e) { console.log(`${d}: ERROR ${String(e).slice(0, 80)}`); }
    await Bun.sleep(2000);
  }
  await ag(w, "close");
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!(await Bun.file(AGWEB).exists())) { console.error(`agweb not found at ${AGWEB}`); process.exit(2); }
  if (cmd === "crawl" && rest.length === 3) await crawl(rest[0]!, Number(rest[1]), Number(rest[2]));
  else if (cmd === "login-check") await loginCheck(rest);
  else { console.error("usage: bun tools/agweb.ts login-check [domain …] | crawl <work> <from> <to>"); process.exit(2); }
}

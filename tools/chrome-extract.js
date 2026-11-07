// Claude in Chrome route — READ THIS BEFORE USING THE CHROME TOOLS FOR A CRAWL.
//
// Chrome (Michael's real profile, logged in everywhere) is the preferred reader, but a page
// script there cannot reach the local sink: Chrome's Private Network Access blocks a public
// https page from fetching http://127.0.0.1 and the pending permission prompt wedges the tab
// (every later `javascript_tool` call times out after 45 s; verified 2026-09-26). Clipboard
// writes from page scripts hang the same way. So there is no file sink on this route.
//
// Instead, delegate: one general-purpose Agent per batch of 8–10 items. Each agent loads the
// Chrome tools, creates ITS OWN tab (`tabs_create_mcp`), and per item does `navigate` →
// `get_page_text` → writes the page per WRITER.md → `bun process.ts check`. The page text
// stays in the agent's context and never enters the orchestrator's. Agents run in parallel
// on separate tabs. The orchestrator collects their JSON rows and records the run.
//
// Paywall test inside an agent (javascript_tool):
//   ({ paywall: !!document.querySelector('.paywall, [class*="paywall"]'),
//      chars: document.querySelector('.available-content')?.innerText.length })
// A PAYWALL with the text ending mid-argument = a publication Michael does not pay for.
//
// The Playwright route (tools/crawl.js + tools/sink.ts) remains for when the extension is
// not connected; it needs tools/login-check.js to pass first.

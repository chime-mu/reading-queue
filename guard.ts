// The app has no login: being able to reach it is the only credential. That
// leaves two browser attacks once it listens beyond localhost, because any web
// page open on a device on the mesh can talk to it:
//   - DNS rebinding: a page gets its own name to resolve to this server and
//     reads the library. Stopped by only answering to names we know.
//   - Cross-site POST: a page fires a write at this server. Stopped by refusing
//     writes whose Origin is not this server. (Browsers always send Origin on a
//     cross-site POST; a request with no Origin is not coming from a web page.)

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

export function allowedHosts(extra = ""): Set<string> {
  return new Set([...LOOPBACK, ...extra.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)]);
}

function hostOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function requestAllowed(req: Request, hosts: Set<string>): boolean {
  const hostHeader = req.headers.get("host") ?? "";
  const host = hostOf(hostHeader);
  if (!host || !hosts.has(host)) return false;
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host.toLowerCase() === hostHeader.toLowerCase();
  } catch {
    return false; // includes the "null" origin of sandboxed frames
  }
}

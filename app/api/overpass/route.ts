import { NextRequest, NextResponse } from "next/server";
import { buildQuery } from "@/lib/overpass";
import { fetchWithRetry, TTLCache } from "@/lib/osm-server";

// Public Overpass mirrors, tried in order. If one fails (rate-limit, error,
// timeout or unreachable) we fall through to the next rather than failing.
// kumi.systems is last: it has been observed serving data months out of date.
const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Time budget for the whole request (all mirrors together) and for one attempt.
// Without these a single hung mirror kept the map spinning indefinitely.
const TOTAL_BUDGET_MS = 40_000;
const ATTEMPT_TIMEOUT_MS = 20_000;

// Overpass reports query timeouts / memory exhaustion as HTTP 200 with a
// "remark" — the elements are partial or empty, so it must not be cached.
function isIncomplete(json: { remark?: string }): boolean {
  return typeof json.remark === "string" && /error|timed out|out of memory/i.test(json.remark);
}

export const maxDuration = 60;

// Overpass's frontend returns 406 for requests with a default/bot User-Agent, so
// we must send an identifying UA and an explicit Accept.
const OVERPASS_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
  "User-Agent":
    "instagram-area-tool/1.0 (https://sho-san.co.jp; contact: sns_div@sho-san.co.jp)",
};

// Cache results by rounded bbox for 10 minutes. The map fires a query on every
// pan; without this, revisiting the same area re-hits Overpass every time.
const cache = new TTLCache<unknown>(10 * 60 * 1000);

export async function POST(req: NextRequest) {
  const { bbox } = (await req.json()) as { bbox?: number[] };
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((n) => typeof n !== "number")) {
    return NextResponse.json({ error: "invalid bbox" }, { status: 400 });
  }

  const key = bbox.map((n) => n.toFixed(3)).join(",");
  const cached = cache.get(key);
  if (cached) return NextResponse.json(cached);

  const query = buildQuery(bbox as [number, number, number, number]);
  const body = `data=${encodeURIComponent(query)}`;

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastStatus = 0;
  let timedOut = false;
  for (const url of MIRRORS) {
    if (Date.now() >= deadline) break;
    try {
      const res = await fetchWithRetry(
        url,
        { method: "POST", headers: OVERPASS_HEADERS, body },
        { retries: 1, timeoutMs: ATTEMPT_TIMEOUT_MS, deadline }
      );

      if (res.ok) {
        const json = await res.json(); // throws → caught → next mirror
        if (isIncomplete(json)) {
          console.warn(`[overpass] incomplete result from ${url}: ${json.remark}`);
          continue;
        }
        cache.set(key, json);
        return NextResponse.json(json);
      }
      lastStatus = res.status;
      console.warn(`[overpass] ${url} → HTTP ${res.status}`);
      // Any non-OK status: mirrors are interchangeable, so try the next one.
    } catch (e) {
      // Timeout / network error / non-JSON body — try the next mirror.
      const name = (e as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") timedOut = true;
      console.warn(`[overpass] ${url} failed: ${name ?? e}`);
    }
  }

  // All mirrors failed. Surface 429 for rate-limits and 504 for timeouts so
  // the client can show an appropriate message.
  const status = lastStatus === 429 ? 429 : timedOut ? 504 : 502;
  return NextResponse.json(
    { error: "all overpass mirrors failed", lastStatus },
    { status }
  );
}

import type { FacilityCategory, OsmElement, Facility } from "@/types";

// Scoring weights for area analysis — adjust here to tune rankings
export const AREA_SCORE_WEIGHTS = {
  relatedFacilityWeight: 2,
  constructionPenaltyWeight: 3,
};

export function buildQuery(bbox: [number, number, number, number]): string {
  const [south, west, north, east] = bbox;
  const b = `${south},${west},${north},${east}`;
  return `[out:json][timeout:25];
(
  node["craft"="builder"](${b});
  node["office"="construction"](${b});
  node["craft"="carpenter"](${b});
  node["amenity"="events_venue"](${b});
  node["shop"="wedding"](${b});
  node["amenity"="wedding_venue"](${b});
  node["highway"="services"]["name"~"道の駅",i](${b});
  node["tourism"="information"]["name"~"道の駅",i](${b});
  node["amenity"="kindergarten"](${b});
  node["shop"="furniture"](${b});
  way["craft"="builder"](${b});
  way["office"="construction"](${b});
  way["craft"="carpenter"](${b});
  way["amenity"="events_venue"](${b});
  way["shop"="wedding"](${b});
  way["amenity"="wedding_venue"](${b});
  way["highway"="services"]["name"~"道の駅",i](${b});
  way["amenity"="kindergarten"](${b});
  way["shop"="furniture"](${b});
);
out center;`;
}

function classifyElement(tags: Record<string, string>): FacilityCategory | null {
  const name = (tags.name || tags["name:ja"] || "").toLowerCase();

  if (
    tags.craft === "builder" ||
    tags.office === "construction" ||
    tags.craft === "carpenter"
  )
    return "construction";

  if (
    tags.amenity === "events_venue" ||
    tags.shop === "wedding" ||
    tags.amenity === "wedding_venue"
  )
    return "wedding";

  if (name.includes("道の駅") && (tags.highway === "services" || tags.tourism === "information"))
    return "roadside_station";

  if (tags.amenity === "kindergarten") return "kindergarten";

  if (tags.shop === "furniture") return "furniture";

  return null;
}

export function osmElementToFacility(el: OsmElement): Facility | null {
  const tags = el.tags || {};
  const category = classifyElement(tags);
  if (!category) return null;

  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat === undefined || lon === undefined) return null;

  return {
    id: `osm-${el.type}-${el.id}`,
    source: "osm",
    category,
    name: tags["name:ja"] || tags.name || "名称不明",
    name_ja: tags["name:ja"],
    lat,
    lng: lon,
    website: tags.website,
  };
}

/** Thrown when /api/overpass fails; `status` lets the UI pick a message. */
export class OverpassError extends Error {
  constructor(public status: number) {
    super(`Overpass API error: ${status}`);
    this.name = "OverpassError";
  }
}

// Slightly longer than the server's total budget (40s) so the server can
// answer with a proper error before the browser gives up.
const CLIENT_TIMEOUT_MS = 50_000;

export async function fetchOverpassFacilities(
  bbox: [number, number, number, number],
  signal?: AbortSignal
): Promise<Facility[]> {
  // Goes through our server-side proxy (/api/overpass), which adds caching,
  // retry/backoff, timeouts and mirror rotation to avoid Overpass 429s.
  const timeout = AbortSignal.timeout(CLIENT_TIMEOUT_MS);
  const res = await fetch("/api/overpass", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bbox }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });

  if (!res.ok) throw new OverpassError(res.status);

  const json = await res.json();
  const elements: OsmElement[] = json.elements || [];

  return elements
    .map(osmElementToFacility)
    .filter((f): f is Facility => f !== null);
}

export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  // Via /api/geocode — server sends a valid User-Agent and rate-limits to
  // Nominatim's 1-req/sec policy so we don't get blocked.
  const res = await fetch(`/api/geocode?reverse=${lat},${lng}`);
  if (!res.ok) return "";
  const json = await res.json();
  return json.display_name || "";
}

export interface PlaceSearchResult {
  display_name: string;
  boundingbox: [string, string, string, string];
}

export async function searchPlaces(query: string): Promise<PlaceSearchResult[]> {
  // Nominatim place search via /api/geocode. The "日本" suffix keeps results in Japan.
  const res = await fetch(`/api/geocode?q=${encodeURIComponent(query + " 日本")}`);
  if (!res.ok) return [];
  const data = (await res.json()) as PlaceSearchResult[];
  return Array.isArray(data) ? data.filter((d) => d.boundingbox) : [];
}

/** User-facing (Japanese) message for a failed Overpass fetch. */
export function overpassErrorMessage(e: unknown): string {
  if (e instanceof OverpassError && e.status === 429) {
    return "地図データのサーバーが混雑しています。少し時間をおいて再試行してください。";
  }
  if (
    (e instanceof OverpassError && e.status === 504) ||
    (e as Error)?.name === "TimeoutError"
  ) {
    return "地図データの取得がタイムアウトしました。範囲を狭めるか、再試行してください。";
  }
  return "地図データの取得に失敗しました。再試行してください。";
}

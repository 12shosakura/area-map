"use client";

import { useEffect, useRef, useState } from "react";
import type { Facility, FacilityCategory } from "@/types";
import { CATEGORY_COLORS, CATEGORY_EMOJI, CATEGORY_LABELS } from "@/types";
import {
  fetchOverpassFacilities,
  overpassErrorMessage,
  reverseGeocode,
} from "@/lib/overpass";
import { listFacilities, getFacility } from "@/lib/db";
import FacilityPanel from "./FacilityPanel";
import AddFacilityModal from "./AddFacilityModal";

import type { Map as LeafletMap, Marker } from "leaflet";


const DEBOUNCE_MS = 800;
const ACTIVE_CATEGORIES = Object.keys(CATEGORY_COLORS) as FacilityCategory[];

function makePinIcon(
  L: typeof import("leaflet"),
  color: string,
  emoji: string
) {
  return L.divIcon({
    html: `<div style="
      position:relative;
      width:36px;
      height:44px;
      display:flex;
      flex-direction:column;
      align-items:center;
    ">
      <div style="
        width:36px;
        height:36px;
        border-radius:50% 50% 50% 0;
        transform:rotate(-45deg);
        background:${color};
        border:2px solid white;
        box-shadow:0 2px 6px rgba(0,0,0,0.3);
        display:flex;
        align-items:center;
        justify-content:center;
      ">
        <span style="transform:rotate(45deg);font-size:17px;line-height:1;">${emoji}</span>
      </div>
      <div style="
        width:4px;height:8px;
        background:${color};
        border-radius:0 0 2px 2px;
        margin-top:-1px;
      "></div>
    </div>`,
    className: "",
    iconSize: [36, 44],
    iconAnchor: [18, 44],
    popupAnchor: [0, -44],
  });
}

export default function MapView() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // refs for values accessed inside map event callbacks (avoids stale closure)
  const activeCategoriesRef = useRef<Set<FacilityCategory>>(new Set(ACTIVE_CATEGORIES));
  const manualFacilitiesRef = useRef<Facility[]>([]);
  const allOsmRef = useRef<Map<string, Facility>>(new Map());
  const leafletRef = useRef<typeof import("leaflet") | null>(null);

  // React state (for re-rendering UI only)
  const [activeCategories, setActiveCategories] = useState<Set<FacilityCategory>>(
    new Set(ACTIVE_CATEGORIES)
  );
  const [manualFacilities, setManualFacilities] = useState<Facility[]>([]);
  const [selected, setSelected] = useState<Facility | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [tooWide, setTooWide] = useState(false);
  // In-flight Overpass request; aborted when the map moves again.
  const inflightRef = useRef<AbortController | null>(null);

  // keep refs in sync with state
  useEffect(() => { activeCategoriesRef.current = activeCategories; }, [activeCategories]);
  useEffect(() => { manualFacilitiesRef.current = manualFacilities; }, [manualFacilities]);

  // Load manual facilities once (via /api/facilities)
  useEffect(() => {
    listFacilities({ source: "manual" })
      .then((data) => setManualFacilities(data))
      .catch(() => {});
  }, []);

  // ── marker helpers ────────────────────────────────────────────────────────

  function addMarker(facility: Facility) {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return;
    if (!activeCategoriesRef.current.has(facility.category)) return;
    if (markersRef.current.has(facility.id)) return;

    const color = CATEGORY_COLORS[facility.category];
    const emoji = CATEGORY_EMOJI[facility.category];
    const icon = makePinIcon(L, color, emoji);
    const marker = L.marker([facility.lat, facility.lng], { icon });

    async function onActivate() {
      // 即パネルを開く（住所は後から差し込む）
      setSelected(facility);

      // 保存済みデータをマージ（/api/facilities 経由）
      let f = facility;
      const saved = await getFacility(facility.id);
      if (saved) f = { ...facility, ...saved };

      // 住所が無ければ逆ジオコーディング（バックグラウンド）
      if (!f.address) {
        f = { ...f, address: "住所を取得中…" };
        setSelected({ ...f });
        const address = await reverseGeocode(f.lat, f.lng);
        f = { ...f, address };
      }
      setSelected({ ...f });
    }

    marker.on("click", onActivate);
    marker.on("touchend", (e) => {
      (e as unknown as { originalEvent?: TouchEvent }).originalEvent?.preventDefault();
      onActivate();
    });

    marker.addTo(map);
    markersRef.current.set(facility.id, marker);
  }

  function clearAllMarkers() {
    markersRef.current.forEach((m) => m.remove());
    markersRef.current.clear();
  }

  function redrawMarkers() {
    clearAllMarkers();
    allOsmRef.current.forEach((f) => addMarker(f));
    manualFacilitiesRef.current.forEach((f) => addMarker(f));
  }

  // ── fetch from Overpass for current viewport ──────────────────────────────

  async function fetchAndRender() {
    const map = mapRef.current;
    if (!map) return;
    const bounds = map.getBounds();
    const south = bounds.getSouth();
    const west = bounds.getWest();
    const north = bounds.getNorth();
    const east = bounds.getEast();

    // Cancel the previous (now stale) request so pans don't pile up requests.
    inflightRef.current?.abort();

    if (north - south > 1 || east - west > 1) {
      inflightRef.current = null;
      setTooWide(true);
      setLoading(false);
      return;
    }
    setTooWide(false);

    const ctrl = new AbortController();
    inflightRef.current = ctrl;
    setLoading(true);
    setFetchError("");
    try {
      const facilities = await fetchOverpassFacilities(
        [south, west, north, east],
        ctrl.signal
      );
      facilities.forEach((f) => {
        allOsmRef.current.set(f.id, f);
        addMarker(f);
      });
      manualFacilitiesRef.current.forEach((f) => addMarker(f));
    } catch (e) {
      if (ctrl.signal.aborted) return; // superseded by a newer request
      console.error("Overpass fetch failed", e);
      setFetchError(overpassErrorMessage(e));
    } finally {
      if (inflightRef.current === ctrl) {
        inflightRef.current = null;
        setLoading(false);
      }
    }
  }

  // ── initialize map once ───────────────────────────────────────────────────

  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current) return;

    // Leaflet CSS はブラウザ側でのみ読み込む（SSR/HMRループを防ぐ）
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(link);

    import("leaflet").then((L) => {
      leafletRef.current = L;

      delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
      });

      // エリアページからのジャンプ座標を localStorage から読む
      let centerLat = 34.6937;
      let centerLng = 135.5023;
      let zoom = 13;
      try {
        const jump = localStorage.getItem("mapJump");
        if (jump) {
          const j = JSON.parse(jump) as { lat: number; lng: number; zoom: number };
          centerLat = j.lat;
          centerLng = j.lng;
          zoom = j.zoom;
          localStorage.removeItem("mapJump");
        }
      } catch { /* ignore */ }
      const map = L.map(mapContainerRef.current!).setView([centerLat, centerLng], zoom);
      // 背景地図: 国土地理院「淡色地図」（無料・APIキー不要）。
      // 以前の CARTO basemaps は APIキー必須になり「API KEY REQUIRED」画像しか返さなくなった。
      L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
        attribution:
          '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a> | 施設データ © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        minZoom: 5,
        maxNativeZoom: 18,
        maxZoom: 20,
      }).addTo(map);

      mapRef.current = map;

      map.on("moveend", () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(fetchAndRender, DEBOUNCE_MS);
      });

      fetchAndRender();
    });

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      inflightRef.current?.abort();
      mapRef.current?.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── redraw when categories or manual facilities change ────────────────────
  // Use a ref-flag to skip the very first render (map not ready yet)
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    if (!mapRef.current) return;
    redrawMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategories, manualFacilities]);

  // ── UI handlers ───────────────────────────────────────────────────────────

  function toggleCategory(cat: FacilityCategory) {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  }

  function handleFacilityUpdated(updated: Facility) {
    setSelected(updated);
    allOsmRef.current.set(updated.id, updated);
  }

  function handleFacilityAdded(facility: Facility) {
    setManualFacilities((prev) => [...prev, facility]);
    setShowAddModal(false);
  }

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainerRef} className="w-full h-full" />

      {/* Category filter */}
      <div className="absolute top-3 left-3 z-[1000] bg-white rounded-lg shadow p-2 space-y-1">
        {ACTIVE_CATEGORIES.map((cat) => (
          <label
            key={cat}
            className="flex items-center gap-2 cursor-pointer select-none"
          >
            <input
              type="checkbox"
              checked={activeCategories.has(cat)}
              onChange={() => toggleCategory(cat)}
              className="hidden"
            />
            <span className="text-base flex-shrink-0 leading-none">
              {CATEGORY_EMOJI[cat]}
            </span>
            <span
              className={`text-xs ${
                activeCategories.has(cat) ? "text-gray-800" : "text-gray-400"
              }`}
            >
              {CATEGORY_LABELS[cat]}
            </span>
          </label>
        ))}
      </div>

      {/* Add facility button */}
      <button
        onClick={() => setShowAddModal(true)}
        className="absolute bottom-8 left-3 z-[1000] bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium px-3 py-2 rounded-lg shadow"
      >
        ＋ 施設を手動追加
      </button>

      {/* Loading */}
      {loading && (
        <div className="absolute top-3 right-3 z-[1000] bg-white rounded-full shadow px-3 py-1 text-xs text-gray-500">
          読み込み中…
        </div>
      )}

      {/* Too wide / error */}
      {!loading && tooWide && (
        <div className="absolute top-3 right-3 z-[1000] bg-white rounded-full shadow px-3 py-1 text-xs text-gray-600">
          範囲が広すぎます。ズームインすると施設を表示します
        </div>
      )}
      {!loading && !tooWide && fetchError && (
        <div className="absolute top-3 right-3 z-[1000] max-w-xs bg-red-50 border border-red-200 rounded-lg shadow px-3 py-2 text-xs text-red-700 space-y-1">
          <p>{fetchError}</p>
          <button
            onClick={() => fetchAndRender()}
            className="font-medium underline"
          >
            再試行
          </button>
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <>
          <div
            className="fixed inset-0 z-[2000] bg-black/20 md:hidden"
            onClick={() => setSelected(null)}
          />
          <div className="
            fixed z-[2001]
            bottom-0 left-0 right-0 h-[70vh]
            md:absolute md:top-0 md:right-0 md:bottom-0 md:left-auto md:h-full md:w-80
            bg-white shadow-2xl overflow-hidden rounded-t-2xl md:rounded-none
          ">
            <FacilityPanel
              facility={selected}
              onClose={() => setSelected(null)}
              onUpdated={handleFacilityUpdated}
            />
          </div>
        </>
      )}

      {showAddModal && (
        <AddFacilityModal
          defaultLat={mapRef.current?.getCenter().lat}
          defaultLng={mapRef.current?.getCenter().lng}
          onClose={() => setShowAddModal(false)}
          onAdded={handleFacilityAdded}
        />
      )}
    </div>
  );
}

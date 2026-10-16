"use client";

import { useState, useRef } from "react";
import {
  fetchOverpassFacilities,
  overpassErrorMessage,
  searchPlaces,
  AREA_SCORE_WEIGHTS,
  type PlaceSearchResult,
} from "@/lib/overpass";
import type { AreaScore, FacilityCategory } from "@/types";

const RELATED_CATEGORIES: FacilityCategory[] = [
  "wedding",
  "roadside_station",
  "kindergarten",
  "furniture",
];
const GRID_SIZE = 3;

// Nominatim search result (boundingbox: [south, north, west, east])
type NominatimResult = PlaceSearchResult;

interface SelectedArea {
  label: string;
  south: number;
  west: number;
  north: number;
  east: number;
}

export default function AreasPage() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([]);
  const [selectedArea, setSelectedArea] = useState<SelectedArea | null>(null);
  const [scores, setScores] = useState<AreaScore[]>([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Nominatim autocomplete (via /api/geocode proxy — throttled + cached server-side)
  async function searchNominatim(q: string) {
    if (!q.trim()) { setSuggestions([]); return; }
    setSearching(true);
    try {
      setSuggestions(await searchPlaces(q));
    } catch {
      setSuggestions([]);
    } finally {
      setSearching(false);
    }
  }

  function handleQueryChange(v: string) {
    setQuery(v);
    setSelectedArea(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => searchNominatim(v), 400);
  }

  function selectSuggestion(s: NominatimResult) {
    // Nominatim boundingbox: [south, north, west, east]
    const [south, north, west, east] = s.boundingbox.map(Number);
    setSelectedArea({
      label: s.display_name.split(",")[0],
      south,
      west,
      north,
      east,
    });
    setQuery(s.display_name.split(",")[0]);
    setSuggestions([]);
    setScores([]);
  }

  async function analyze() {
    if (!selectedArea) {
      setError("先に市区町村を選択してください");
      return;
    }
    setLoading(true);
    setError("");
    setScores([]);

    try {
      const { south, west, north, east, label } = selectedArea;

      // Overpass に 1 回だけリクエスト（9 回に分けてレート制限に引っかかるのを防ぐ）
      const facilities = await fetchOverpassFacilities([south, west, north, east]);

      // グリッド分類（クライアント側で座標を見て振り分け）
      const latStep = (north - south) / GRID_SIZE;
      const lngStep = (east - west) / GRID_SIZE;

      const cells: AreaScore[] = [];
      for (let row = 0; row < GRID_SIZE; row++) {
        for (let col = 0; col < GRID_SIZE; col++) {
          const cs = south + row * latStep;
          const cn = cs + latStep;
          const cw = west + col * lngStep;
          const ce = cw + lngStep;

          const inCell = facilities.filter(
            (f) => f.lat >= cs && f.lat < cn && f.lng >= cw && f.lng < ce
          );
          const constructionCount = inCell.filter(
            (f) => f.category === "construction"
          ).length;
          const relatedCount = inCell.filter((f) =>
            RELATED_CATEGORIES.includes(f.category)
          ).length;
          const score =
            relatedCount * AREA_SCORE_WEIGHTS.relatedFacilityWeight -
            constructionCount * AREA_SCORE_WEIGHTS.constructionPenaltyWeight;

          cells.push({
            area_name: `${label} エリア${row * GRID_SIZE + col + 1}`,
            construction_count: constructionCount,
            related_facility_count: relatedCount,
            score,
            calculated_at: new Date().toISOString(),
            lat: (cs + cn) / 2,
            lng: (cw + ce) / 2,
          });
        }
      }

      setScores(cells.sort((a, b) => b.score - a.score));
    } catch (e) {
      console.error(e);
      setError(overpassErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  function jumpToMap(score: AreaScore) {
    if (score.lat == null || score.lng == null) return;
    localStorage.setItem(
      "mapJump",
      JSON.stringify({ lat: score.lat, lng: score.lng, zoom: 14 })
    );
    window.location.href = "/map";
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <h1 className="text-xl font-bold text-gray-800 mb-1">狙い目エリア一覧</h1>
      <p className="text-sm text-gray-500 mb-6">
        市区町村名で検索 → グリッド分割してスコアリングします。
        <br />
        スコア = 関連施設数×{AREA_SCORE_WEIGHTS.relatedFacilityWeight} − 工務店数×
        {AREA_SCORE_WEIGHTS.constructionPenaltyWeight}
      </p>

      {/* 検索ボックス */}
      <div className="relative mb-4">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder="例：豊中市、宝塚市、浜松市…"
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            {searching && (
              <span className="absolute right-2 top-2.5 text-xs text-gray-400">
                検索中…
              </span>
            )}
          </div>
          <button
            onClick={analyze}
            disabled={loading || !selectedArea}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium px-4 py-2 rounded-lg whitespace-nowrap"
          >
            {loading ? "取得中…" : "分析する"}
          </button>
        </div>

        {/* サジェスト */}
        {suggestions.length > 0 && (
          <ul className="absolute top-full left-0 right-0 z-50 bg-white border rounded-lg shadow-lg mt-1 divide-y max-h-56 overflow-y-auto">
            {suggestions.map((s, i) => (
              <li key={i}>
                <button
                  onClick={() => selectSuggestion(s)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 truncate"
                >
                  {s.display_name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selectedArea && !loading && scores.length === 0 && (
        <p className="text-xs text-blue-700 bg-blue-50 rounded px-3 py-1.5 mb-4">
          選択中：<strong>{selectedArea.label}</strong> を {GRID_SIZE}×{GRID_SIZE} グリッドで分析します
        </p>
      )}

      {error && (
        <p className="text-red-500 text-sm mb-4 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      {loading && (
        <div className="flex items-center gap-3 text-sm text-gray-500 mb-4">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          Overpass API からデータ取得中…（1回のリクエストで完了します）
        </div>
      )}

      {scores.length > 0 && (
        <>
          <p className="text-xs text-gray-400 mb-2">
            {selectedArea?.label} — 合計 {scores.reduce((s, c) => s + c.construction_count + c.related_facility_count, 0)} 件の施設を取得
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-100 text-left">
                  <th className="px-3 py-2 font-medium text-gray-600">順位</th>
                  <th className="px-3 py-2 font-medium text-gray-600">エリア</th>
                  <th className="px-3 py-2 font-medium text-gray-600 text-right">🏗️ 工務店</th>
                  <th className="px-3 py-2 font-medium text-gray-600 text-right">関連施設</th>
                  <th className="px-3 py-2 font-medium text-gray-600 text-right">スコア</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {scores.map((s, i) => (
                  <tr key={s.area_name} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                    <td className="px-3 py-2 font-medium">{s.area_name}</td>
                    <td className="px-3 py-2 text-right text-red-600">
                      {s.construction_count}
                    </td>
                    <td className="px-3 py-2 text-right text-blue-600">
                      {s.related_facility_count}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-bold ${
                        s.score >= 0 ? "text-green-600" : "text-gray-400"
                      }`}
                    >
                      {s.score}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => jumpToMap(s)}
                        className="text-xs text-blue-600 hover:underline whitespace-nowrap"
                      >
                        地図で見る →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

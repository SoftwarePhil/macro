"use client";

import { useEffect, useRef } from "react";
import type { ChartPoint, ChartRange } from "@/lib/types";

const UP = "#34d399";
const DOWN = "#f87171";
const RANGE_MS: Record<Exclude<ChartRange, "ALL">, number> = {
  "1D": 24 * 60 * 60 * 1000,
  "1W": 7 * 24 * 60 * 60 * 1000,
  "1M": 30 * 24 * 60 * 60 * 1000,
};

function fmtMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function filterChartPoints(points: ChartPoint[], range: ChartRange): ChartPoint[] {
  if (!points.length) return [];
  const normalized = points.length === 1 ? [points[0], { ...points[0] }] : points;
  if (range === "ALL" || !RANGE_MS[range as Exclude<ChartRange, "ALL">]) return normalized;

  const cutoff = Date.now() - RANGE_MS[range as Exclude<ChartRange, "ALL">];
  const filtered = normalized.filter((point) => point.ts >= cutoff);
  if (filtered.length >= 2) return filtered;

  const last = normalized[normalized.length - 1];
  const anchor = normalized.find((point) => point.ts < cutoff) ?? normalized[0];
  return [anchor, last];
}

function smoothPath(points: ChartPoint[], width: number, height: number, pad: number, minY: number, maxY: number): string {
  if (points.length < 2) return "";
  const range = maxY - minY || 1;
  const coords = points.map((point, index) => ({
    x: pad + (index / (points.length - 1)) * (width - pad * 2),
    y: pad + (1 - (point.value - minY) / range) * (height - pad * 2),
  }));

  let path = `M ${coords[0].x} ${coords[0].y}`;
  for (let index = 0; index < coords.length - 1; index += 1) {
    const p0 = coords[Math.max(index - 1, 0)];
    const p1 = coords[index];
    const p2 = coords[index + 1];
    const p3 = coords[Math.min(index + 2, coords.length - 1)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return path;
}

function pointLabel(point: ChartPoint): string {
  if (point.session === "Start") return "Start";
  if (point.session === "Live") return "Now";
  if (point.session === "Intraday" && point.time) return point.time;
  return `${point.date || ""} ${point.session || ""}`.trim();
}

export interface PortfolioChartResult {
  last: ChartPoint;
  delta: number;
  deltaPct: number;
  isUp: boolean;
}

interface PortfolioChartProps {
  points: ChartPoint[];
  startingCapital: number;
  range: ChartRange;
  onResult: (result: PortfolioChartResult | null) => void;
}

export default function PortfolioChart({ points, startingCapital, range, onResult }: PortfolioChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = "";

    const series = filterChartPoints(points, range);
    if (!series.length) {
      container.innerHTML = '<p class="chart-empty">Portfolio chart will appear after the first open/close job.</p>';
      onResult(null);
      return;
    }

    const width = container.clientWidth || 800;
    const height = 200;
    const pad = 8;
    const values = series.map((point) => point.value);
    const minY = Math.min(...values, startingCapital) * 0.998;
    const maxY = Math.max(...values, startingCapital) * 1.002;
    const last = series[series.length - 1];
    const delta = last.value - (startingCapital || series[0].value);
    const deltaPct = startingCapital ? (last.value / startingCapital - 1) * 100 : 0;
    const isUp = delta >= 0;
    const color = isUp ? UP : DOWN;
    const linePath = smoothPath(series, width, height, pad, minY, maxY);
    const areaPath = `${linePath} L ${width - pad} ${height - pad} L ${pad} ${height - pad} Z`;
    const baselineY = pad + (1 - (startingCapital - minY) / (maxY - minY || 1)) * (height - pad * 2);
    const coords = series.map((point, index) => ({
      ...point,
      x: pad + (index / (series.length - 1)) * (width - pad * 2),
      y: pad + (1 - (point.value - minY) / (maxY - minY || 1)) * (height - pad * 2),
    }));

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("class", "portfolio-chart-svg");
    const gradientId = `chart-grad-${Date.now()}`;
    svg.innerHTML = `
      <defs>
        <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line class="chart-baseline" x1="${pad}" y1="${baselineY}" x2="${width - pad}" y2="${baselineY}" />
      <path class="chart-area" d="${areaPath}" fill="url(#${gradientId})"/>
      <path class="chart-line" d="${linePath}" stroke="${color}" fill="none"/>
      <g class="chart-crosshair" style="display:none">
        <line class="chart-vline" y1="${pad}" y2="${height - pad}"/>
        <circle class="chart-dot" r="5"/>
      </g>
      <circle class="chart-live-dot" r="4" />
    `;
    container.appendChild(svg);

    const liveDot = svg.querySelector<SVGCircleElement>(".chart-live-dot");
    const end = coords[coords.length - 1];
    if (liveDot && end) {
      liveDot.setAttribute("cx", String(end.x));
      liveDot.setAttribute("cy", String(end.y));
      liveDot.setAttribute("fill", color);
    }

    const crosshair = svg.querySelector<SVGGElement>(".chart-crosshair");
    const vline = svg.querySelector<SVGLineElement>(".chart-vline");
    const dot = svg.querySelector<SVGCircleElement>(".chart-dot");
    const tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    tooltip.style.display = "none";
    container.appendChild(tooltip);

    const overlay = document.createElement("div");
    overlay.className = "chart-overlay";
    container.appendChild(overlay);
    overlay.addEventListener("mousemove", (event) => {
      const rect = container.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      let nearest = coords[0];
      let minimumDistance = Infinity;
      for (const coordinate of coords) {
        const distance = Math.abs(coordinate.x - mouseX);
        if (distance < minimumDistance) {
          minimumDistance = distance;
          nearest = coordinate;
        }
      }
      if (!crosshair || !vline || !dot) return;
      crosshair.style.display = "block";
      vline.setAttribute("x1", String(nearest.x));
      vline.setAttribute("x2", String(nearest.x));
      dot.setAttribute("cx", String(nearest.x));
      dot.setAttribute("cy", String(nearest.y));
      dot.setAttribute("fill", color);
      tooltip.style.display = "block";
      tooltip.style.left = `${Math.min(Math.max(nearest.x - 60, 0), width - 120)}px`;
      tooltip.style.top = "8px";
      tooltip.innerHTML = `<div class="chart-tooltip-label">${pointLabel(nearest)}</div><div class="chart-tooltip-value mono">${fmtMoney(nearest.value)}</div>`;
    });
    overlay.addEventListener("mouseleave", () => {
      if (crosshair) crosshair.style.display = "none";
      tooltip.style.display = "none";
    });

    onResult({ last, delta, deltaPct, isUp });
    return () => {
      overlay.replaceWith();
      container.innerHTML = "";
    };
  }, [onResult, points, range, startingCapital]);

  return <div className="chart-container" ref={containerRef} />;
}

export function fmtChartMoney(value: number): string {
  return fmtMoney(value);
}

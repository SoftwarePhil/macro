const UP = "#34d399";
const DOWN = "#f87171";

const RANGE_MS = {
  "1D": 24 * 60 * 60 * 1000,
  "1W": 7 * 24 * 60 * 60 * 1000,
  "1M": 30 * 24 * 60 * 60 * 1000,
};

function fmtMoney(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function normalizePoints(points) {
  if (!points?.length) return [];
  if (points.length === 1) return [points[0], { ...points[0] }];
  return points;
}

export function filterChartPoints(points, range) {
  const normalized = normalizePoints(points);
  if (!range || range === "ALL" || !RANGE_MS[range]) return normalized;
  const cutoff = Date.now() - RANGE_MS[range];
  const filtered = normalized.filter((p) => (p.ts ?? 0) >= cutoff);
  if (filtered.length < 2) {
    const last = normalized[normalized.length - 1];
    const anchor = normalized.find((p) => (p.ts ?? 0) < cutoff) ?? normalized[0];
    return [anchor, last];
  }
  return filtered;
}

function smoothPath(points, width, height, pad, minY, maxY) {
  if (points.length < 2) return "";
  const range = maxY - minY || 1;
  const coords = points.map((p, i) => ({
    x: pad + (i / (points.length - 1)) * (width - pad * 2),
    y: pad + (1 - (p.value - minY) / range) * (height - pad * 2),
  }));

  let d = `M ${coords[0].x} ${coords[0].y}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[Math.max(i - 1, 0)];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[Math.min(i + 2, coords.length - 1)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function pointLabel(p) {
  if (p.session === "Start") return "Start";
  if (p.session === "Live") return "Now";
  if (p.session === "Intraday" && p.time) return p.time;
  return `${p.date || ""} ${p.session || ""}`.trim();
}

export function mountPortfolioChart(container, { points, startingCapital, range = "ALL" }) {
  if (!container) return null;
  container.innerHTML = "";

  const series = filterChartPoints(points, range);
  if (!series.length) {
    container.innerHTML = `<p class="chart-empty">Portfolio chart will appear after the first open/close job.</p>`;
    return null;
  }

  const width = container.clientWidth || 800;
  const height = 200;
  const pad = 8;
  const values = series.map((p) => p.value);
  const minY = Math.min(...values, startingCapital) * 0.998;
  const maxY = Math.max(...values, startingCapital) * 1.002;
  const last = series[series.length - 1];
  const delta = last.value - (startingCapital || series[0].value);
  const deltaPct = startingCapital ? ((last.value / startingCapital - 1) * 100) : 0;
  const isUp = delta >= 0;
  const color = isUp ? UP : DOWN;

  const linePath = smoothPath(series, width, height, pad, minY, maxY);
  const areaPath = `${linePath} L ${width - pad} ${height - pad} L ${pad} ${height - pad} Z`;
  const gradId = `chart-grad-${Date.now()}`;
  const baselineY =
    pad + (1 - (startingCapital - minY) / (maxY - minY || 1)) * (height - pad * 2);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "portfolio-chart-svg");
  svg.innerHTML = `
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line class="chart-baseline" x1="${pad}" y1="${baselineY}" x2="${width - pad}" y2="${baselineY}" />
    <path class="chart-area" d="${areaPath}" fill="url(#${gradId})"/>
    <path class="chart-line" d="${linePath}" stroke="${color}" fill="none"/>
    <g class="chart-crosshair" style="display:none">
      <line class="chart-vline" y1="${pad}" y2="${height - pad}"/>
      <circle class="chart-dot" r="5"/>
    </g>
    <circle class="chart-live-dot" r="4" style="display:none"/>
  `;
  container.appendChild(svg);

  const coords = series.map((p, i) => {
    const x = pad + (i / (series.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (p.value - minY) / (maxY - minY || 1)) * (height - pad * 2);
    return { ...p, x, y };
  });

  const liveDot = svg.querySelector(".chart-live-dot");
  const end = coords[coords.length - 1];
  if (liveDot && end) {
    liveDot.setAttribute("cx", end.x);
    liveDot.setAttribute("cy", end.y);
    liveDot.setAttribute("fill", color);
    liveDot.style.display = "block";
  }

  const crosshair = svg.querySelector(".chart-crosshair");
  const vline = svg.querySelector(".chart-vline");
  const dot = svg.querySelector(".chart-dot");
  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.style.display = "none";
  container.appendChild(tooltip);

  const overlay = document.createElement("div");
  overlay.className = "chart-overlay";
  container.appendChild(overlay);

  overlay.addEventListener("mousemove", (e) => {
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let nearest = coords[0];
    let minDist = Infinity;
    for (const c of coords) {
      const d = Math.abs(c.x - mx);
      if (d < minDist) {
        minDist = d;
        nearest = c;
      }
    }
    crosshair.style.display = "block";
    vline.setAttribute("x1", nearest.x);
    vline.setAttribute("x2", nearest.x);
    dot.setAttribute("cx", nearest.x);
    dot.setAttribute("cy", nearest.y);
    dot.setAttribute("fill", color);
    tooltip.style.display = "block";
    tooltip.style.left = `${Math.min(Math.max(nearest.x - 60, 0), width - 120)}px`;
    tooltip.style.top = "8px";
    tooltip.innerHTML = `<div class="chart-tooltip-label">${pointLabel(nearest)}</div><div class="chart-tooltip-value mono">${fmtMoney(nearest.value)}</div>`;
  });

  overlay.addEventListener("mouseleave", () => {
    crosshair.style.display = "none";
    tooltip.style.display = "none";
  });

  return { last, delta, deltaPct, isUp, color };
}

export function fmtChartMoney(n) {
  return fmtMoney(n);
}
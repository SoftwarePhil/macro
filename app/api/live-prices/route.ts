import { upsertQuotesBatch } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const prices = (await request.json()) as unknown;
  if (!prices || typeof prices !== "object" || Array.isArray(prices)) {
    return Response.json(
      { error: 'prices object required, e.g. { "QQQ": { "price": 512.34, "changePct": 0.8 } }' },
      { status: 400 },
    );
  }

  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [symbol, rawValue] of Object.entries(prices)) {
    const value = typeof rawValue === "number" ? { price: rawValue } : rawValue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const quote = value as Record<string, unknown>;
    normalized[symbol] = {
      price: Number(quote.price ?? quote),
      changePct: Number(quote.changePct ?? quote.change_pct ?? 0),
      marketState: "LIVE_ROBINHOOD_MCP",
    };
  }

  if (!Object.keys(normalized).length) {
    return Response.json({ error: "at least one valid price is required" }, { status: 400 });
  }
  upsertQuotesBatch(normalized);
  return Response.json({
    ok: true,
    updated: Object.keys(normalized),
    source: "mcp",
    storedIn: "sqlite:quotes",
  });
}

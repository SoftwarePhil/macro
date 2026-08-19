import { loadPortfolio, loadTabConfig } from "@/lib/db";
import { saveManualPortfolio } from "@/lib/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const tabId = new URL(request.url).searchParams.get("tab") || "paper";
  return Response.json(loadPortfolio(tabId));
}

export async function POST(request: Request) {
  const tabs = loadTabConfig();
  const paperTab = tabs.find((tab) => tab.tab_id === "paper");
  if (paperTab?.enabled) {
    return Response.json(
      { error: "Paper mode active — holdings are managed automatically" },
      { status: 403 },
    );
  }

  const body = (await request.json()) as {
    cash?: unknown;
    holdings?: unknown;
  };
  if (!Array.isArray(body.holdings)) {
    return Response.json({ error: "holdings array required" }, { status: 400 });
  }

  const holdings = body.holdings.map((holding) => {
    const item = holding as Record<string, unknown>;
    return {
      symbol: String(item.symbol || ""),
      shares: Number(item.shares || 0),
      avg_cost: Number(item.avg_cost || 0),
    };
  });
  return Response.json(saveManualPortfolio(Number(body.cash || 0), holdings));
}

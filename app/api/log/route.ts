import { loadStrategyLog } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const tabId = new URL(request.url).searchParams.get("tab") || "paper";
  return Response.json(loadStrategyLog(tabId).slice().reverse());
}

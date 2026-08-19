import { loadJobRuns } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const requested = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Math.min(requested || 100, 500);
  return Response.json(loadJobRuns(limit));
}

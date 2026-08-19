import { getDb } from "@/lib/db";
import { getSchedulerStatus } from "@/lib/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const db = getDb();
  const tabCount = (db.prepare("SELECT COUNT(*) AS n FROM tab_config").get() as { n: number }).n;
  return Response.json({
    ok: true,
    db: "sqlite",
    tabs: tabCount,
    scheduler: getSchedulerStatus(),
  });
}

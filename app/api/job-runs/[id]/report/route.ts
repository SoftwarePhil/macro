import { loadJobRunById, loadLlmReportById } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const jobId = Number(params.id);
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return Response.json({ error: "invalid job id" }, { status: 400 });
  }
  const job = loadJobRunById(jobId);
  if (!job) return Response.json({ error: "job run not found" }, { status: 404 });
  if (!job.llm_report_id) {
    return Response.json({ error: "no LLM report linked to this job run" }, { status: 404 });
  }
  const report = loadLlmReportById(job.llm_report_id);
  if (!report) return Response.json({ error: "linked LLM report not found" }, { status: 404 });
  return Response.json({ jobRun: job, report });
}

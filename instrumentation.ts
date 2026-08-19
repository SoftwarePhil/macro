export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startScheduler } = await import("./lib/dashboard");
  startScheduler();
}

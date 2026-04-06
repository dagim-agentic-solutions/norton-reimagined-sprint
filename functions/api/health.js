/**
 * GET/POST /api/health
 * Scope: norton-reimagined-sprint only
 */
export async function onRequest() {
  return new Response(
    JSON.stringify({ status: "ok", project: "norton-reimagined-sprint" }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/** Proxy to sync-estimate so Overview/Monthly tabs are not overwritten. */

Deno.serve(async () => {
  try {
    const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-estimate`;
    const key = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});

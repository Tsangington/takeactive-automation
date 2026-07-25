import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getToken, resetTokenCache } from "../_shared/takeactiveAuth.ts";
import {
  TAKEACTIVE_GROUPS,
  TAKEACTIVE_DELAY_MS,
  berlinToday,
  historyUrl,
  parseDateRange,
  sleep,
} from "../_shared/takeactiveGroups.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  try {
    resetTokenCache();
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const { from, to } = parseDateRange(body, {
      from: "2026-01-01",
      to: berlinToday(),
    });

    const results = [];

    for (const group of TAKEACTIVE_GROUPS) {
      let page = 1;
      let upserted = 0;
      let pages = 0;
      let stoppedReason = "empty_page";

      while (true) {
        if (page > 1 || results.length > 0) {
          await sleep(TAKEACTIVE_DELAY_MS);
        }

        const token = await getToken();
        const url = historyUrl(group, page);
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`History API ${res.status} for ${url}: ${text.slice(0, 300)}`);
        }

        const items: any[] = await res.json();
        pages++;

        if (!Array.isArray(items) || items.length === 0) {
          stoppedReason = "empty_page";
          break;
        }

        const inRange = items.filter((a) => {
          const day = String(a.appointment ?? "").split("T")[0];
          return day >= from && day <= to;
        });

        if (inRange.length > 0) {
          const rows = inRange.map((a) => ({
            id: String(a.id),
            name: a.name,
            start_date: a.appointment.split("T")[0],
            start_time: a.appointment.split("T")[1],
            max_participants: a.max_participant,
            master_company_id: a.master_company_id,
          }));

          const { error } = await supabase
            .from("appointment")
            .upsert(rows, { onConflict: "id", ignoreDuplicates: false });

          if (error) {
            throw new Error(`DB upsert failed for ${group.master} page ${page}: ${error.message}`);
          }
          upserted += rows.length;
        }

        // Newest-first: stop when every item on the page is before `from`.
        const allBeforeFrom = items.every((a) => {
          const day = String(a.appointment ?? "").split("T")[0];
          return day < from;
        });
        if (allBeforeFrom) {
          stoppedReason = "before_from";
          break;
        }

        page++;
      }

      results.push({
        master: group.master,
        pages,
        upserted,
        stopped_reason: stoppedReason,
      });
    }

    return new Response(
      JSON.stringify({ from, to, companies: results }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});

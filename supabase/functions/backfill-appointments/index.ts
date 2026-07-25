import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getToken, resetTokenCache } from "../_shared/takeactiveAuth.ts";
import {
  TAKEACTIVE_GROUPS,
  TAKEACTIVE_DELAY_MS,
  TakeActiveGroup,
  berlinToday,
  historyUrl,
  parseDateRange,
  sleep,
} from "../_shared/takeactiveGroups.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

type Body = {
  from?: string;
  to?: string;
  /** Explicit page numbers, e.g. [40, 41, 42] */
  pages?: number[];
  /** Inclusive page range alternative to `pages` */
  page_from?: number;
  page_to?: number;
  /** Optional: only one company (master id or slug) */
  master?: string;
};

function resolveGroups(body: Body): TakeActiveGroup[] {
  if (!body.master) return TAKEACTIVE_GROUPS;
  const key = body.master.toLowerCase();
  const match = TAKEACTIVE_GROUPS.filter(
    (g) => g.master.toLowerCase() === key || g.slug === key
  );
  if (match.length === 0) {
    throw new Error(`Unknown master/company: ${body.master}`);
  }
  return match;
}

function resolvePages(body: Body): number[] | null {
  if (Array.isArray(body.pages) && body.pages.length > 0) {
    return [...new Set(body.pages.map(Number))].filter((n) => n >= 1).sort((a, b) => a - b);
  }
  if (body.page_from != null || body.page_to != null) {
    const start = Number(body.page_from ?? body.page_to);
    const end = Number(body.page_to ?? body.page_from);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < 1) {
      throw new Error("page_from / page_to must be positive integers");
    }
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }
  return null;
}

function toRows(items: any[], from?: string, to?: string) {
  return items
    .filter((a) => {
      if (!from && !to) return true;
      const day = String(a.appointment ?? "").split("T")[0];
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    })
    .map((a) => ({
      id: String(a.id),
      name: a.name,
      start_date: a.appointment.split("T")[0],
      start_time: a.appointment.split("T")[1],
      max_participants: a.max_participant,
      master_company_id: a.master_company_id,
    }));
}

async function upsertPage(
  group: TakeActiveGroup,
  page: number,
  from?: string,
  to?: string
): Promise<{ page: number; fetched: number; upserted: number; empty: boolean }> {
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
  if (!Array.isArray(items) || items.length === 0) {
    return { page, fetched: 0, upserted: 0, empty: true };
  }

  const rows = toRows(items, from, to);
  if (rows.length > 0) {
    const { error } = await supabase
      .from("appointment")
      .upsert(rows, { onConflict: "id", ignoreDuplicates: false });
    if (error) {
      throw new Error(`DB upsert failed for ${group.master} page ${page}: ${error.message}`);
    }
  }

  return { page, fetched: items.length, upserted: rows.length, empty: false };
}

Deno.serve(async (req) => {
  try {
    resetTokenCache();
    const body: Body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const groups = resolveGroups(body);
    const explicitPages = resolvePages(body);
    const mode = explicitPages ? "pages" : "date";

    const { from, to } = mode === "date"
      ? parseDateRange(body, { from: "2026-01-01", to: berlinToday() })
      : {
          from: body.from, // optional filter inside page mode
          to: body.to,
        };

    const results = [];
    let callIndex = 0;

    for (const group of groups) {
      if (mode === "pages") {
        const pageResults = [];
        let upserted = 0;

        for (const page of explicitPages!) {
          if (callIndex++ > 0) await sleep(TAKEACTIVE_DELAY_MS);
          const r = await upsertPage(group, page, from, to);
          upserted += r.upserted;
          pageResults.push(r);
        }

        results.push({
          master: group.master,
          mode,
          pages_requested: explicitPages,
          upserted,
          page_results: pageResults,
        });
        continue;
      }

      // Date mode: walk pages newest → oldest until past `from`.
      let page = 1;
      let upserted = 0;
      let pagesFetched = 0;
      let stoppedReason = "empty_page";

      while (true) {
        if (callIndex++ > 0) await sleep(TAKEACTIVE_DELAY_MS);

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
        pagesFetched++;

        if (!Array.isArray(items) || items.length === 0) {
          stoppedReason = "empty_page";
          break;
        }

        const rows = toRows(items, from, to);
        if (rows.length > 0) {
          const { error } = await supabase
            .from("appointment")
            .upsert(rows, { onConflict: "id", ignoreDuplicates: false });
          if (error) {
            throw new Error(`DB upsert failed for ${group.master} page ${page}: ${error.message}`);
          }
          upserted += rows.length;
        }

        const allBeforeFrom = items.every((a) => {
          const day = String(a.appointment ?? "").split("T")[0];
          return day < from!;
        });
        if (allBeforeFrom) {
          stoppedReason = "before_from";
          break;
        }

        page++;
      }

      results.push({
        master: group.master,
        mode,
        from,
        to,
        pages: pagesFetched,
        upserted,
        stopped_reason: stoppedReason,
      });
    }

    return new Response(
      JSON.stringify({ mode, from: from ?? null, to: to ?? null, companies: results }),
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

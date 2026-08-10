/**
 * Check upcoming appointments + validate Europe/Berlin conversion used by
 * get_upcoming_unchecked_appointments.
 *
 * Usage:
 *   node scripts/check-upcoming-appointments.mjs
 *   node scripts/check-upcoming-appointments.mjs --minutes=120
 *   node scripts/check-upcoming-appointments.mjs --limit=20
 *
 * Required env (.env supported):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function argInt(name, fallback) {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const n = Number(raw.slice(name.length + 3));
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid --${name}`);
  return n;
}

function formatDuration(ms) {
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const totalSec = Math.floor(abs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${sign}${h}h ${m}m`;
  if (m > 0) return `${sign}${m}m ${s}s`;
  return `${sign}${s}s`;
}

/** First HH:MM in the appointment name (Berlin wall-clock in titles). */
function nameStartTime(name) {
  const m = String(name).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}:00`;
}

function berlinParts(isoOrDate) {
  const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}:${get("second")}`,
    label: `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} Europe/Berlin`,
  };
}

async function main() {
  const minutes = argInt("minutes", 20);
  const limit = argInt("limit", 15);

  const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  const now = new Date();
  const to = new Date(now.getTime() + minutes * 60 * 1000);
  const berlinNow = berlinParts(now);

  console.log("=== clocks ===");
  console.log(`local script now : ${now.toISOString()} (UTC)`);
  console.log(`Berlin now       : ${berlinNow.label}`);
  console.log(`RPC window       : now → +${minutes}m`);
  console.log(`  from_time      : ${now.toISOString()}`);
  console.log(`  to_time        : ${to.toISOString()}`);
  console.log();

  const { data: rpcRows, error: rpcErr } = await supabase.rpc(
    "get_upcoming_unchecked_appointments",
    {
      from_time: now.toISOString(),
      to_time: to.toISOString(),
    }
  );

  if (rpcErr) {
    throw new Error(`RPC failed: ${rpcErr.message}`);
  }

  console.log(`=== RPC get_upcoming_unchecked_appointments (${rpcRows?.length ?? 0} hits) ===`);
  if (!rpcRows?.length) {
    console.log("(none in window — expected unless an unchecked event starts within the window)");
  } else {
    for (const r of rpcRows) {
      console.log(`  id=${r.id} max=${r.max_participants} master=${r.master_company_id}`);
    }
  }
  console.log();

  // Next upcoming (any checked state), with Berlin conversion matching the SQL function.
  const { data: upcoming, error: upErr } = await supabase
    .from("appointment")
    .select("id, name, start_date, start_time, checked, max_participants, master_company_id")
    .gte("start_date", berlinNow.date)
    .order("start_date", { ascending: true })
    .order("start_time", { ascending: true })
    .limit(200);

  if (upErr) {
    throw new Error(`appointment select failed: ${upErr.message}`);
  }

  const enriched = (upcoming ?? [])
    .map((a) => {
      // Same semantics as SQL:
      // (start_date + start_time)::timestamp AT TIME ZONE 'Europe/Berlin'
      const localNaive = `${a.start_date}T${String(a.start_time).slice(0, 8)}`;
      const startsAtUtc = berlinLocalToUtc(localNaive);
      const nameTime = nameStartTime(a.name);
      const storedTime = `${String(a.start_time).slice(0, 8)}`;
      const nameMatch =
        nameTime == null ? "no-time-in-name" : nameTime === storedTime ? "OK" : "MISMATCH";

      return {
        ...a,
        startsAtUtc,
        msUntil: startsAtUtc.getTime() - now.getTime(),
        nameTime,
        storedTime,
        nameMatch,
        berlinLabel: berlinParts(startsAtUtc).label,
      };
    })
    .filter((a) => a.msUntil >= -5 * 60 * 1000) // include just-started for sanity
    .sort((a, b) => a.msUntil - b.msUntil)
    .slice(0, limit);

  console.log(`=== next ${enriched.length} appointments (Berlin conversion check) ===`);
  let mismatches = 0;
  let inWindow = 0;

  for (const a of enriched) {
    const inRpcWindow = a.msUntil >= 0 && a.msUntil <= minutes * 60 * 1000;
    if (inRpcWindow) inWindow++;
    if (a.nameMatch === "MISMATCH") mismatches++;

    const flag = [
      a.checked ? "checked" : "unchecked",
      inRpcWindow ? `IN +${minutes}m WINDOW` : null,
      a.nameMatch === "MISMATCH" ? "NAME≠TIME" : null,
    ]
      .filter(Boolean)
      .join(" | ");

    console.log(
      [
        `id=${a.id}`,
        `in ${formatDuration(a.msUntil).padStart(8)}`,
        `stored=${a.start_date} ${a.storedTime}`,
        `→ ${a.berlinLabel}`,
        `utc=${a.startsAtUtc.toISOString()}`,
        `nameTime=${a.nameTime ?? "-"} (${a.nameMatch})`,
        flag,
      ].join("  ")
    );
    console.log(`    ${a.name}`);
  }

  console.log();
  console.log("=== summary ===");
  console.log(`RPC hits in +${minutes}m window     : ${rpcRows?.length ?? 0}`);
  console.log(`Upcoming listed in +${minutes}m     : ${inWindow}`);
  console.log(`Name vs start_time mismatches     : ${mismatches}`);

  // Cross-check: unchecked rows in window should match RPC ids.
  const expectedIds = new Set(
    enriched
      .filter((a) => !a.checked && a.msUntil >= 0 && a.msUntil <= minutes * 60 * 1000)
      .map((a) => String(a.id))
  );
  const rpcIds = new Set((rpcRows ?? []).map((r) => String(r.id)));
  const missingFromRpc = [...expectedIds].filter((id) => !rpcIds.has(id));
  const extraInRpc = [...rpcIds].filter((id) => !expectedIds.has(id));

  if (missingFromRpc.length || extraInRpc.length) {
    console.log("RPC vs local window mismatch:");
    if (missingFromRpc.length) console.log(`  missing from RPC: ${missingFromRpc.join(", ")}`);
    if (extraInRpc.length) console.log(`  extra in RPC    : ${extraInRpc.join(", ")}`);
    // Note: DST edge cases in the JS helper can cause this; SQL is source of truth.
    process.exitCode = 2;
  } else {
    console.log("RPC vs local +window unchecked set: OK");
  }
}

/**
 * Convert a Berlin civil datetime (YYYY-MM-DDTHH:mm:ss, no offset) to a UTC Date.
 * Handles CET/CEST by probing the offset that Intl reports for that instant.
 */
function berlinLocalToUtc(localNaive) {
  // First assume UTC, then correct by the Berlin offset at that UTC guess, iterate once.
  let utcGuess = new Date(`${localNaive}Z`);
  for (let i = 0; i < 2; i++) {
    const berlin = berlinParts(utcGuess);
    const [by, bm, bd] = berlin.date.split("-").map(Number);
    const [bh, bmin, bs] = berlin.time.split(":").map(Number);
    const [ly, lm, ld] = localNaive.slice(0, 10).split("-").map(Number);
    const [lh, lmin, ls] = localNaive.slice(11).split(":").map(Number);
    const asBerlinMs = Date.UTC(by, bm - 1, bd, bh, bmin, bs);
    const asLocalMs = Date.UTC(ly, lm - 1, ld, lh, lmin, ls);
    const delta = asLocalMs - asBerlinMs;
    utcGuess = new Date(utcGuess.getTime() + delta);
  }
  return utcGuess;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

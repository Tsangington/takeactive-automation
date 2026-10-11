/**
 * List upcoming TakeActive appointments and manage booking plans.
 *
 * Usage:
 *   node scripts/bookings.mjs list
 *   node scripts/bookings.mjs add --id=110911
 *   node scripts/bookings.mjs add --id=110911 --weekly
 *   node scripts/bookings.mjs plans
 *   node scripts/bookings.mjs remove --plan=<uuid>
 *   node scripts/bookings.mjs cancel --id=110911
 *
 * Required env (.env supported):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   TAKEACTIVE_FIREBASE_KEY, TAKEACTIVE_EMAIL, TAKEACTIVE_PASSWORD
 *   cancel also needs the book-appointments function deployed
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const TAKEACTIVE_GROUPS = [
  { master: "BADMINTON-TREPTOW", slug: "badminton-treptow" },
  { master: "VFB-KIEFHOLZ-LEAGUE-TEAM", slug: "vfb-kiefholz-league-team" },
];

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function flag(argv, name) {
  const raw = argv.find((a) => a.startsWith(`--${name}=`));
  return raw ? raw.slice(name.length + 3) : null;
}

function listUrl(group) {
  return `https://api.takeactive.com/api/${group.master}/appointment/${group.slug}`;
}

function clock(value) {
  const time = String(value).includes("T") ? String(value).split("T")[1] : String(value);
  const [hh = "00", mm = "00", ss = "00"] = time.split(":");
  return `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:${String(ss).slice(0, 2).padStart(2, "0")}`;
}

function weekdayOf(appointment) {
  const [y, m, d] = String(appointment).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Naive YYYY-MM-DDTHH:mm:ss Europe/Berlin wall time → UTC epoch ms. */
function berlinNaiveToMs(naive) {
  const trimmed = String(naive).trim().replace(" ", "T").slice(0, 19);
  const utcGuess = Date.parse(`${trimmed}Z`);
  if (!Number.isFinite(utcGuess)) throw new Error(`Invalid Berlin timestamp: ${naive}`);
  const wall = new Date(utcGuess)
    .toLocaleString("sv-SE", { timeZone: "Europe/Berlin" })
    .replace(" ", "T")
    .slice(0, 19);
  const offset = Date.parse(`${wall}Z`) - utcGuess;
  return utcGuess - offset;
}

function sessionLabel(naive) {
  if (!naive) return "unknown";
  const [date, time] = String(naive).trim().replace(" ", "T").split("T");
  const [hh = "00", mm = "00"] = (time ?? "").split(":");
  return `${date} ${hh}:${mm}`;
}

function describe(appointment) {
  const declined = appointment.is_decline ? " declined" : "";
  return `${appointment.name} | ${sessionLabel(appointment.appointment)} | bookable from ${sessionLabel(appointment.bookable_from_date)} | id ${appointment.id}${declined}`;
}

function matchesWeekly(appointment, plan) {
  if (appointment.status !== "ACTIVE" || appointment.is_decline) return false;
  return weekdayOf(appointment.appointment) === Number(plan.weekday) &&
    clock(appointment.appointment) === clock(plan.start_time) &&
    Number(appointment.duration) === Number(plan.duration);
}

async function login() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env("TAKEACTIVE_FIREBASE_KEY")}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: env("TAKEACTIVE_EMAIL"),
        password: env("TAKEACTIVE_PASSWORD"),
        returnSecureToken: true,
      }),
    }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error(`Firebase login failed: ${res.status}`);
  return data.idToken;
}

async function fetchUpcoming(token) {
  const all = [];
  for (const group of TAKEACTIVE_GROUPS) {
    const res = await fetch(listUrl(group), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error(`List failed for ${group.master}: ${res.status}`);
      continue;
    }
    const data = await res.json();
    if (Array.isArray(data)) all.push(...data);
  }
  const now = Date.now();
  return all
    .filter((a) => a.status === "ACTIVE" && a.appointment && berlinNaiveToMs(a.appointment) >= now)
    .sort((a, b) => String(a.appointment).localeCompare(String(b.appointment)) || String(a.id).localeCompare(String(b.id)));
}

function supabase() {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
}

async function findAppointment(token, id) {
  const upcoming = await fetchUpcoming(token);
  const found = upcoming.find((a) => String(a.id) === id);
  if (!found) throw new Error(`Appointment ${id} is not in the upcoming list`);
  return { upcoming, found };
}

async function list() {
  const upcoming = await fetchUpcoming(await login());
  for (const appointment of upcoming) console.log(describe(appointment));
  if (upcoming.length === 0) console.log("No upcoming appointments.");
}

async function add(argv) {
  const id = flag(argv, "id");
  if (!id) throw new Error("add requires --id=<appointment id>");
  const weekly = argv.includes("--weekly");
  const { upcoming, found } = await findAppointment(await login(), id);
  if (found.is_decline) throw new Error(`Appointment ${id} is declined`);
  if (weekly && (found.duration == null || found.appointment == null)) {
    throw new Error(`Appointment ${id} has no duration or start time`);
  }

  const row = weekly
    ? {
      kind: "weekly",
      weekday: weekdayOf(found.appointment),
      start_time: clock(found.appointment),
      duration: Number(found.duration),
    }
    : { kind: "once", appointment_id: id };

  const { data, error } = await supabase().from("booking_plan").insert(row).select("id").single();
  if (error) throw new Error(error.message);

  if (weekly) {
    const matches = upcoming.filter((a) => matchesWeekly(a, row));
    console.log(
      `weekly ${DAYS[row.weekday]} ${row.start_time.slice(0, 5)} ${row.duration}min | plan ${data.id}`
    );
    for (const appointment of matches) console.log(describe(appointment));
    return;
  }

  console.log(`once | plan ${data.id}`);
  console.log(describe(found));
}

async function plans() {
  const db = supabase();
  const { data: planRows, error } = await db
    .from("booking_plan")
    .select("id, kind, appointment_id, weekday, start_time, duration")
    .eq("enabled", true)
    .order("created_at");
  if (error) throw new Error(error.message);
  const enabled = planRows ?? [];
  if (enabled.length === 0) {
    console.log("No booking plans.");
    return;
  }

  const { data: attemptRows, error: attemptError } = await db
    .from("booking_attempt")
    .select("plan_id, appointment_id, status")
    .in("plan_id", enabled.map((p) => p.id));
  if (attemptError) throw new Error(attemptError.message);
  const attempts = new Map(
    (attemptRows ?? []).map((a) => [`${a.plan_id}:${a.appointment_id}`, a.status])
  );

  const upcoming = await fetchUpcoming(await login());
  for (const plan of enabled) {
    if (plan.kind === "weekly") {
      console.log(
        `weekly ${DAYS[plan.weekday]} ${String(plan.start_time).slice(0, 5)} ${plan.duration}min | plan ${plan.id}`
      );
      const matches = upcoming.filter((a) => matchesWeekly(a, plan));
      if (matches.length === 0) console.log("  no upcoming match");
      for (const appointment of matches) {
        const status = attempts.get(`${plan.id}:${appointment.id}`) ?? "scheduled";
        console.log(`  ${describe(appointment)} | ${status}`);
      }
      continue;
    }

    console.log(`once | plan ${plan.id}`);
    const found = upcoming.find((a) => String(a.id) === String(plan.appointment_id));
    if (!found) {
      console.log(`  id ${plan.appointment_id} | not in the upcoming list`);
      continue;
    }
    const status = attempts.get(`${plan.id}:${found.id}`) ?? "scheduled";
    console.log(`  ${describe(found)} | ${status}`);
  }
}

async function remove(argv) {
  const planId = flag(argv, "plan");
  if (!planId) throw new Error("remove requires --plan=<uuid>");
  const { data, error } = await supabase()
    .from("booking_plan")
    .update({ enabled: false })
    .eq("id", planId)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(`No booking plan ${planId}`);
  console.log(`disabled plan ${planId}`);
}

async function cancel(argv) {
  const id = flag(argv, "id");
  if (!id) throw new Error("cancel requires --id=<appointment id>");
  const res = await fetch(`${env("SUPABASE_URL")}/functions/v1/book-appointments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "cancel", appointment_id: id }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  console.log(text);
}

function usage() {
  console.log(`Usage:
  node scripts/bookings.mjs list
  node scripts/bookings.mjs add --id=<appointment id>
  node scripts/bookings.mjs add --id=<appointment id> --weekly
  node scripts/bookings.mjs plans
  node scripts/bookings.mjs remove --plan=<uuid>
  node scripts/bookings.mjs cancel --id=<appointment id>`);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "list") await list();
  else if (command === "add") await add(argv);
  else if (command === "plans") await plans();
  else if (command === "remove") await remove(argv);
  else if (command === "cancel") await cancel(argv);
  else {
    usage();
    process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getToken, resetTokenCache } from "../_shared/takeactiveAuth.ts";
import {
  TAKEACTIVE_GROUPS,
  acceptUrl,
  appointmentListUrl,
  berlinNaiveToMs,
  cancelUrl,
  sleep,
} from "../_shared/takeactiveGroups.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const WARM_MS = 60_000;
const PENDING_STALE_MS = 3 * 60_000;
const jsonHeaders = { "Content-Type": "application/json" };

type LiveAppointment = {
  id: number | string;
  name?: string;
  appointment: string;
  status?: string;
  duration?: number;
  master_company_id: string;
  is_decline?: boolean;
  bookable_from_date?: string | null;
  participants?: Array<{
    user_id?: string | null;
    user?: { id?: string | null } | null;
    canceled_at?: string | null;
  }>;
};

type Plan = {
  id: string;
  kind: "once" | "weekly";
  appointment_id: string | null;
  weekday: number | null;
  start_time: string | null;
  duration: number | null;
};

type Attempt = {
  plan_id: string;
  appointment_id: string;
  status: string;
  attempted_at: string;
};

type Target = {
  planId: string;
  appointment: LiveAppointment;
  openMs: number;
};

function clock(value: string): string {
  const time = value.includes("T") ? value.split("T")[1] : value;
  const [hh = "00", mm = "00", ss = "00"] = time.split(":");
  return `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:${String(ss).slice(0, 2).padStart(2, "0")}`;
}

function weekdayOf(appointment: string): number {
  const [y, m, d] = appointment.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function firebaseUserId(idToken: string): string {
  const payload = idToken.split(".")[1];
  if (!payload) throw new Error("Invalid Firebase idToken");
  const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const json = JSON.parse(atob(padded));
  const id = json.user_id ?? json.sub;
  if (!id) throw new Error("Firebase token has no user id");
  return String(id);
}

function alreadyBooked(appointment: LiveAppointment, userId: string): boolean {
  return (appointment.participants ?? []).some((p) => {
    const id = p.user_id ?? p.user?.id;
    if (id == null || String(id) !== userId) return false;
    return !p.canceled_at;
  });
}

function matchesWeekly(appointment: LiveAppointment, plan: Plan): boolean {
  if (appointment.status !== "ACTIVE" || appointment.is_decline) return false;
  if (plan.weekday == null || plan.start_time == null || plan.duration == null) return false;
  return weekdayOf(appointment.appointment) === Number(plan.weekday) &&
    clock(appointment.appointment) === clock(String(plan.start_time)) &&
    Number(appointment.duration) === Number(plan.duration);
}

function targetsFor(plan: Plan, live: LiveAppointment[]): LiveAppointment[] {
  if (plan.kind === "once") {
    const found = live.find((a) => String(a.id) === String(plan.appointment_id));
    if (!found || found.is_decline || found.status !== "ACTIVE") return [];
    return [found];
  }
  return live.filter((a) => matchesWeekly(a, plan));
}

function attemptBlocked(attempt: Attempt | undefined): boolean {
  if (!attempt) return false;
  if (attempt.status === "booked" || attempt.status === "cancelled") return true;
  if (attempt.status === "pending") {
    return Date.now() - new Date(attempt.attempted_at).getTime() < PENDING_STALE_MS;
  }
  return false;
}

async function fetchLive(token: string): Promise<LiveAppointment[]> {
  const all: LiveAppointment[] = [];
  for (const group of TAKEACTIVE_GROUPS) {
    const res = await fetch(appointmentListUrl(group), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error(`List failed for ${group.master}: ${res.status}`);
      continue;
    }
    const data = await res.json();
    if (Array.isArray(data)) all.push(...data);
  }
  return all;
}

async function claim(planId: string, appointmentId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("booking_attempt")
    .select("status, attempted_at")
    .eq("plan_id", planId)
    .eq("appointment_id", appointmentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data?.status === "booked" || data?.status === "cancelled") return false;
  if (data?.status === "pending") {
    const age = Date.now() - new Date(data.attempted_at).getTime();
    if (age < PENDING_STALE_MS) return false;
  }

  const { error: upsertError } = await supabase.from("booking_attempt").upsert({
    plan_id: planId,
    appointment_id: appointmentId,
    status: "pending",
    error: null,
    attempted_at: new Date().toISOString(),
  }, { onConflict: "plan_id,appointment_id" });
  if (upsertError) throw new Error(upsertError.message);
  return true;
}

async function postAccept(
  token: string,
  appointment: LiveAppointment
): Promise<{ ok: boolean; error: string | null }> {
  const res = await fetch(acceptUrl(appointment.master_company_id, String(appointment.id)), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) return { ok: true, error: null };
  const text = await res.text();
  return { ok: false, error: `${res.status} ${text.slice(0, 300)}` };
}

async function recordResult(
  target: Target,
  result: { ok: boolean; error: string | null }
): Promise<{ plan_id: string; appointment_id: string; status: string; error: string | null }> {
  const status = result.ok ? "booked" : "failed";
  const { error } = await supabase
    .from("booking_attempt")
    .update({
      status,
      error: result.error,
      attempted_at: new Date().toISOString(),
    })
    .eq("plan_id", target.planId)
    .eq("appointment_id", String(target.appointment.id))
    .eq("status", "pending");
  if (error) throw new Error(error.message);
  return {
    plan_id: target.planId,
    appointment_id: String(target.appointment.id),
    status,
    error: result.error,
  };
}

async function acceptTargets(token: string, targets: Target[]) {
  return await Promise.all(targets.map(async (target) => {
    const result = await postAccept(token, target.appointment);
    return await recordResult(target, result);
  }));
}

async function cancelAppointment(token: string, appointmentId: string, live: LiveAppointment[]) {
  const fromList = live.find((a) => String(a.id) === appointmentId);
  let master = fromList?.master_company_id ?? null;
  if (!master) {
    const { data, error } = await supabase
      .from("appointment")
      .select("master_company_id")
      .eq("id", appointmentId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    master = data?.master_company_id ?? null;
  }
  if (!master) {
    return new Response(JSON.stringify({ error: "appointment not found" }), {
      status: 404,
      headers: jsonHeaders,
    });
  }

  const res = await fetch(cancelUrl(master, appointmentId), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    return new Response(JSON.stringify({ error: `${res.status} ${text.slice(0, 300)}` }), {
      status: 502,
      headers: jsonHeaders,
    });
  }

  const { error } = await supabase
    .from("booking_attempt")
    .update({
      status: "cancelled",
      error: null,
      attempted_at: new Date().toISOString(),
    })
    .eq("appointment_id", appointmentId);
  if (error) throw new Error(error.message);

  return new Response(JSON.stringify({ cancelled: appointmentId, body: text.slice(0, 300) }), {
    headers: jsonHeaders,
  });
}

async function bookDuePlans(token: string, userId: string, live: LiveAppointment[]) {
  const { data: plans, error: planError } = await supabase
    .from("booking_plan")
    .select("id, kind, appointment_id, weekday, start_time, duration")
    .eq("enabled", true);
  if (planError) throw new Error(planError.message);
  const enabled = (plans ?? []) as Plan[];
  if (enabled.length === 0) {
    return { results: [], waiting: 0 };
  }

  const planIds = enabled.map((p) => p.id);
  const { data: attemptRows, error: attemptError } = await supabase
    .from("booking_attempt")
    .select("plan_id, appointment_id, status, attempted_at")
    .in("plan_id", planIds);
  if (attemptError) throw new Error(attemptError.message);
  const attempts = new Map<string, Attempt>();
  for (const row of (attemptRows ?? []) as Attempt[]) {
    attempts.set(`${row.plan_id}:${row.appointment_id}`, row);
  }

  const due: Target[] = [];
  const warm: Target[] = [];
  let waiting = 0;

  for (const plan of enabled) {
    for (const appointment of targetsFor(plan, live)) {
      const appointmentId = String(appointment.id);
      if (alreadyBooked(appointment, userId)) continue;
      if (attemptBlocked(attempts.get(`${plan.id}:${appointmentId}`))) continue;
      if (!appointment.bookable_from_date) continue;

      const openMs = berlinNaiveToMs(String(appointment.bookable_from_date));
      const wait = openMs - Date.now();
      if (wait > WARM_MS) {
        waiting += 1;
        continue;
      }
      const target = { planId: plan.id, appointment, openMs };
      if (wait > 0) warm.push(target);
      else due.push(target);
    }
  }

  const claimedDue: Target[] = [];
  for (const target of due) {
    if (await claim(target.planId, String(target.appointment.id))) claimedDue.push(target);
  }
  const claimedWarm: Target[] = [];
  for (const target of warm) {
    if (await claim(target.planId, String(target.appointment.id))) claimedWarm.push(target);
  }

  let readyToken = token;
  if (claimedWarm.length > 0) {
    // Login now, while the window is still closed, so accept does not wait on Firebase.
    resetTokenCache();
    readyToken = await getToken();
  }

  const results = [];
  const earliestWarm = claimedWarm.reduce((min, target) => Math.min(min, target.openMs), Infinity);
  if (claimedDue.length > 0 && earliestWarm - Date.now() > 2000) {
    results.push(...await acceptTargets(readyToken, claimedDue));
    claimedDue.length = 0;
  }

  if (claimedWarm.length > 0) {
    const byOpen = new Map<number, Target[]>();
    for (const target of claimedWarm) {
      const group = byOpen.get(target.openMs) ?? [];
      group.push(target);
      byOpen.set(target.openMs, group);
    }
    for (const openMs of [...byOpen.keys()].sort((a, b) => a - b)) {
      const wait = openMs - Date.now();
      if (wait > 0) {
        console.log(`Waiting ${wait}ms for booking window`);
        await sleep(wait);
      }
      while (Date.now() < openMs) {
        await sleep(Math.min(openMs - Date.now(), 250));
      }
      results.push(...await acceptTargets(readyToken, byOpen.get(openMs)!));
    }
  }

  if (claimedDue.length > 0) {
    results.push(...await acceptTargets(readyToken, claimedDue));
  }

  return { results, waiting };
}

Deno.serve(async (req) => {
  try {
    let body: { action?: string; appointment_id?: string } = {};
    if (req.method !== "GET") {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    }

    const token = await getToken();
    const live = await fetchLive(token);

    if (body.action === "cancel") {
      const appointmentId = String(body.appointment_id ?? "").trim();
      if (!appointmentId) {
        return new Response(JSON.stringify({ error: "appointment_id is required" }), {
          status: 400,
          headers: jsonHeaders,
        });
      }
      return await cancelAppointment(token, appointmentId, live);
    }

    const userId = firebaseUserId(token);
    const { results, waiting } = await bookDuePlans(token, userId, live);
    return new Response(JSON.stringify({ results, waiting }), { headers: jsonHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});

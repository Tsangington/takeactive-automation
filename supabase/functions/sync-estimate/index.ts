import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const SHEET_ID = Deno.env.get("GOOGLE_SHEET_ID")!;
const GOOGLE_SERVICE_ACCOUNT = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")!);

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
}

async function getGoogleToken(): Promise<string> {
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claim = btoa(JSON.stringify({
    iss: GOOGLE_SERVICE_ACCOUNT.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  }));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(GOOGLE_SERVICE_ACCOUNT.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claim}`)
  );

  const jwt = `${header}.${claim}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const { access_token } = await tokenRes.json();
  return access_token;
}

function getLastWeekRange(): { from: string; to: string } {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();

  const thisMonday = new Date(now);
  thisMonday.setUTCDate(now.getUTCDate() - ((dayOfWeek + 6) % 7));
  thisMonday.setUTCHours(0, 0, 0, 0);

  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);

  const lastSunday = new Date(thisMonday);
  lastSunday.setUTCMilliseconds(-1);

  return {
    from: lastMonday.toISOString().split("T")[0],
    to: lastSunday.toISOString().split("T")[0],
  };
}

function weeksRemainingInYear(): number {
  const now = new Date();
  const endOfYear = new Date(Date.UTC(now.getUTCFullYear(), 11, 31));
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  return Math.ceil((endOfYear.getTime() - now.getTime()) / msPerWeek);
}

Deno.serve(async () => {
  const { from, to } = getLastWeekRange();
  const weeksLeft = weeksRemainingInYear();

  const { data: members, error: membersErr } = await supabase
    .from("member")
    .select("id, name, event_count")
    .order("event_count", { ascending: false });

  if (membersErr || !members) {
    return new Response("Failed to fetch members", { status: 500 });
  }

  const { data: lastWeek, error: lwErr } = await supabase
    .from("appointment_participant")
    .select("member_id, appointment!inner(start_date)")
    .eq("status", "attended")
    .gte("appointment.start_date", from)
    .lte("appointment.start_date", to);

  if (lwErr) {
    return new Response("Failed to fetch last week data", { status: 500 });
  }

  const sessionsLastWeek = new Map<string, number>();
  for (const row of lastWeek ?? []) {
    const count = sessionsLastWeek.get(row.member_id) ?? 0;
    sessionsLastWeek.set(row.member_id, count + 1);
  }

  const values = [
    ["Name", "Events Attended", "Sessions Last Week", "Est. Sessions / Year"],
    ...members.map((m) => {
      const lastWeekCount = sessionsLastWeek.get(m.id) ?? 0;
      const estimated = weeksLeft * lastWeekCount + m.event_count;
      return [m.name, m.event_count, lastWeekCount, estimated];
    }),
  ];

  const token = await getGoogleToken();
  const range = "Sheet1!A1:D";

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:clear`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } }
  );

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values }),
    }
  );

  return new Response(
    JSON.stringify({ written: members.length, weeksLeft, from, to }),
    { headers: { "Content-Type": "application/json" } }
  );
});
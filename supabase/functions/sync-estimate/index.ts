import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const SHEET_ID = Deno.env.get("GOOGLE_SHEET_ID")!;
const GOOGLE_SERVICE_ACCOUNT = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")!);

const OVERVIEW_TITLE = "Overview";
const MONTHLY_TITLE = "Monthly";
const MONTHLY_FROM = "2026-01-01";
const FREE_SESSIONS = 80;
const EXTRA_SESSION_COST = 3;

type Status = "attended" | "waiting" | "cancelled";

type MonthCounts = { attended: number; waiting: number; cancelled: number };

type MemberAgg = {
  attendedThisWeek: number;
  attendedYear: number;
  waitingYear: number;
  cancelledYear: number;
  byMonth: Map<string, MonthCounts>;
};

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
}

function base64url(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getGoogleToken(): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claim = base64url(JSON.stringify({
    iss: GOOGLE_SERVICE_ACCOUNT.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  }));

  const privateKey = GOOGLE_SERVICE_ACCOUNT.private_key.replace(/\\n/g, "\n");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claim}`)
  );

  const jwt = `${header}.${claim}.${base64url(sig)}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(`Google token failed: ${JSON.stringify(tokenData)}`);
  }
  return tokenData.access_token as string;
}

type SheetMeta = { sheetId: number; title: string };

async function getSpreadsheetSheets(token: string): Promise<SheetMeta[]> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties(sheetId,title)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Failed to read spreadsheet: ${JSON.stringify(data)}`);
  }
  const sheets = (data.sheets ?? [])
    .map((s: { properties?: { sheetId?: number; title?: string } }) => ({
      sheetId: s.properties?.sheetId,
      title: s.properties?.title,
    }))
    .filter((s: SheetMeta) => s.sheetId != null && s.title);
  if (!sheets.length) {
    throw new Error("Spreadsheet has no sheets");
  }
  return sheets as SheetMeta[];
}

async function batchUpdate(token: string, requests: unknown[]): Promise<void> {
  if (!requests.length) return;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    }
  );
  if (!res.ok) {
    throw new Error(`Spreadsheet batchUpdate failed: ${await res.text()}`);
  }
}

/** Ensure tabs named Overview and Monthly exist; rename Sheet1 → Overview when helpful. */
async function ensureTabs(
  token: string
): Promise<{ overview: string; monthly: string; overviewId: number; monthlyId: number }> {
  let sheets = await getSpreadsheetSheets(token);
  const requests: unknown[] = [];

  const find = (title: string) => sheets.find((s) => s.title === title);
  let overview = find(OVERVIEW_TITLE);
  let monthly = find(MONTHLY_TITLE);

  if (!overview) {
    const sheet1 = find("Sheet1") ?? sheets[0];
    if (sheet1 && sheet1.title !== MONTHLY_TITLE) {
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: sheet1.sheetId, title: OVERVIEW_TITLE },
          fields: "title",
        },
      });
    } else {
      requests.push({ addSheet: { properties: { title: OVERVIEW_TITLE } } });
    }
  }

  if (!monthly) {
    requests.push({ addSheet: { properties: { title: MONTHLY_TITLE } } });
  }

  if (requests.length) {
    await batchUpdate(token, requests);
    sheets = await getSpreadsheetSheets(token);
    overview = find(OVERVIEW_TITLE);
    monthly = find(MONTHLY_TITLE);
  }

  if (!overview || !monthly) {
    throw new Error(
      `Missing required tabs after ensure: overview=${!!overview} monthly=${!!monthly}`
    );
  }

  // Keep Overview first, freeze headers (and Name on Monthly).
  await batchUpdate(token, [
    {
      updateSheetProperties: {
        properties: {
          sheetId: overview.sheetId,
          index: 0,
          gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 },
        },
        fields: "index,gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
      },
    },
    {
      updateSheetProperties: {
        properties: {
          sheetId: monthly.sheetId,
          index: 1,
          gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 },
        },
        fields: "index,gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
      },
    },
  ]);

  return {
    overview: OVERVIEW_TITLE,
    monthly: MONTHLY_TITLE,
    overviewId: overview.sheetId,
    monthlyId: monthly.sheetId,
  };
}

async function writeSheet(token: string, range: string, values: unknown[][]): Promise<void> {
  const clearRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:clear`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } }
  );
  if (!clearRes.ok) {
    throw new Error(`Sheet clear failed: ${await clearRes.text()}`);
  }

  const writeRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values }),
    }
  );
  if (!writeRes.ok) {
    throw new Error(`Sheet write failed: ${await writeRes.text()}`);
  }
}

const COLOR_GREEN = { red: 0.72, green: 0.88, blue: 0.76 };
const COLOR_YELLOW = { red: 1.0, green: 0.95, blue: 0.6 };
const COLOR_RED = { red: 0.96, green: 0.78, blue: 0.79 };

/** Green ≤ free sessions, yellow above — for Sessions this year + Estimated sessions. */
async function colorOverviewSessionColumns(
  token: string,
  sheetId: number,
  rowCount: number
): Promise<void> {
  const endRow = Math.max(rowCount, 2); // include header..data; rules apply to data rows
  const columns = [1, 4]; // B = sessions this year, E = estimated sessions
  const requests: unknown[] = [];

  for (const col of columns) {
    const range = {
      sheetId,
      startRowIndex: 1, // skip header
      endRowIndex: endRow,
      startColumnIndex: col,
      endColumnIndex: col + 1,
    };
    requests.push({
      addConditionalFormatRule: {
        rule: {
          ranges: [range],
          booleanRule: {
            condition: {
              type: "NUMBER_LESS_THAN_EQ",
              values: [{ userEnteredValue: String(FREE_SESSIONS) }],
            },
            format: { backgroundColor: COLOR_GREEN },
          },
        },
        index: 0,
      },
    });
    requests.push({
      addConditionalFormatRule: {
        rule: {
          ranges: [range],
          booleanRule: {
            condition: {
              type: "NUMBER_GREATER",
              values: [{ userEnteredValue: String(FREE_SESSIONS) }],
            },
            format: { backgroundColor: COLOR_YELLOW },
          },
        },
        index: 0,
      },
    });
  }

  // Clear prior conditional rules on this sheet so re-syncs don't stack forever.
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets(properties(sheetId),conditionalFormats)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const meta = await metaRes.json();
  if (!metaRes.ok) {
    throw new Error(`Failed to read conditional formats: ${JSON.stringify(meta)}`);
  }
  const sheet = (meta.sheets ?? []).find(
    (s: { properties?: { sheetId?: number } }) => s.properties?.sheetId === sheetId
  );
  const existingCount = sheet?.conditionalFormats?.length ?? 0;
  const clearRequests = [];
  for (let i = existingCount - 1; i >= 0; i--) {
    clearRequests.push({
      deleteConditionalFormatRule: { sheetId, index: i },
    });
  }

  await batchUpdate(token, [...clearRequests, ...requests]);
}

/** Color Monthly status columns: attended=green, waitlisted=yellow, cancelled=red. */
async function colorMonthlyStatusColumns(
  token: string,
  sheetId: number,
  monthCount: number,
  rowCount: number
): Promise<void> {
  const endRow = Math.max(rowCount, 1);

  const requests: unknown[] = [];
  for (let i = 0; i < monthCount; i++) {
    const attendedCol = 1 + i * 3;
    const waitlistedCol = attendedCol + 1;
    const cancelledCol = attendedCol + 2;
    const specs: Array<{ col: number; color: typeof COLOR_GREEN }> = [
      { col: attendedCol, color: COLOR_GREEN },
      { col: waitlistedCol, color: COLOR_YELLOW },
      { col: cancelledCol, color: COLOR_RED },
    ];
    for (const { col, color } of specs) {
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: endRow,
            startColumnIndex: col,
            endColumnIndex: col + 1,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: color,
            },
          },
          fields: "userEnteredFormat.backgroundColor",
        },
      });
    }
  }

  await batchUpdate(token, requests);
}

function utcToday(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function mondayOnOrBefore(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(ymd, -((dow + 6) % 7));
}

function getBounds(now = new Date()) {
  const today = utcToday(now);
  const thisMonday = mondayOnOrBefore(today);
  const nextMonday = addDays(thisMonday, 7);
  const year = Number(today.slice(0, 4));
  const yearStart = `${year}-01-01`;
  const nextYearStart = `${year + 1}-01-01`;
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  // Include the current week (from this Monday) so early-week estimates aren't short one week.
  const weeksRemaining = Math.max(
    0,
    Math.ceil((Date.parse(nextYearStart) - Date.parse(thisMonday)) / msPerWeek)
  );
  // Completed weeks only (exclude this Monday's week) — cron runs early Monday.
  const yearStartMonday = mondayOnOrBefore(yearStart);
  const weeksElapsed = Math.max(
    1,
    Math.round((Date.parse(thisMonday) - Date.parse(yearStartMonday)) / msPerWeek)
  );

  return {
    today,
    thisMonday,
    nextMonday,
    yearFrom: yearStart,
    yearTo: nextYearStart,
    weeksRemaining,
    weeksElapsed,
  };
}

/** YYYY-MM keys from 2026-01 through the current UTC month (inclusive). */
function monthKeysThroughToday(today: string): string[] {
  const end = today.slice(0, 7); // YYYY-MM
  const keys: string[] = [];
  let y = 2026;
  let m = 1;
  while (true) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > end) break;
    keys.push(key);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return keys;
}

function emptyAgg(): MemberAgg {
  return {
    attendedThisWeek: 0,
    attendedYear: 0,
    waitingYear: 0,
    cancelledYear: 0,
    byMonth: new Map(),
  };
}

function emptyMonth(): MonthCounts {
  return { attended: 0, waiting: 0, cancelled: 0 };
}

async function fetchYearParticipants(yearFrom: string, yearTo: string) {
  const pageSize = 1000;
  const all: Array<{ member_id: string; status: string; appointment: { start_date: string } }> = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("appointment_participant")
      .select("member_id, status, appointment!inner(start_date)")
      .eq("participant_type", "member")
      .not("member_id", "is", null)
      .gte("appointment.start_date", yearFrom)
      .lt("appointment.start_date", yearTo)
      .order("member_id", { ascending: true })
      .order("appointment_id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Failed to fetch participants: ${error.message}`);
    }
    if (!data?.length) break;
    all.push(...(data as typeof all));
    if (data.length < pageSize) break;
  }

  return all;
}

Deno.serve(async () => {
  try {
    const bounds = getBounds();
    const months = monthKeysThroughToday(bounds.today);
    // Monthly sheet is fixed from Jan 2026; overview year follows current calendar year.
    const dataFrom = MONTHLY_FROM < bounds.yearFrom ? MONTHLY_FROM : bounds.yearFrom;
    const dataTo = bounds.yearTo;

    const { data: members, error: membersErr } = await supabase
      .from("member")
      .select("id, name")
      .order("name", { ascending: true });

    if (membersErr || !members) {
      return new Response(
        JSON.stringify({ error: "Failed to fetch members", details: membersErr?.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const rows = await fetchYearParticipants(dataFrom, dataTo);
    const byMember = new Map<string, MemberAgg>();

    for (const row of rows) {
      const startDate = row.appointment?.start_date;
      if (!row.member_id || !startDate) continue;
      if (row.status !== "attended" && row.status !== "waiting" && row.status !== "cancelled") {
        continue;
      }

      let agg = byMember.get(row.member_id);
      if (!agg) {
        agg = emptyAgg();
        byMember.set(row.member_id, agg);
      }

      const status = row.status as Status;
      const monthKey = startDate.slice(0, 7);

      if (startDate >= bounds.yearFrom && startDate < bounds.yearTo) {
        if (status === "attended") agg.attendedYear++;
        else if (status === "waiting") agg.waitingYear++;
        else agg.cancelledYear++;

        if (
          status === "attended" &&
          startDate >= bounds.thisMonday &&
          startDate < bounds.nextMonday
        ) {
          agg.attendedThisWeek++;
        }
      }

      if (monthKey >= "2026-01" && months.includes(monthKey)) {
        let mc = agg.byMonth.get(monthKey);
        if (!mc) {
          mc = emptyMonth();
          agg.byMonth.set(monthKey, mc);
        }
        mc[status]++;
      }
    }

    const ranked = members
      .map((m) => {
        const a = byMember.get(m.id) ?? emptyAgg();
        const avgPerWeek = a.attendedYear / bounds.weeksElapsed;
        const estimated = Math.round(a.attendedYear + avgPerWeek * bounds.weeksRemaining);
        return { m, a, avgPerWeek, estimated };
      })
      .filter(({ a }) => a.attendedYear + a.waitingYear + a.cancelledYear > 0)
      .sort((x, y) => y.a.attendedYear - x.a.attendedYear || x.m.name.localeCompare(y.m.name));

    const overviewValues: unknown[][] = [
      [
        "Name",
        "Sessions this year",
        "Sessions this week",
        "Average sessions per week this year",
        "Estimated sessions",
        "Estimated extra cost",
      ],
      ...ranked.map(({ m, a, avgPerWeek, estimated }) => [
        m.name,
        a.attendedYear,
        a.attendedThisWeek,
        Math.round(avgPerWeek * 10) / 10,
        estimated,
        Math.max(0, estimated - FREE_SESSIONS) * EXTRA_SESSION_COST,
      ]),
    ];

    const monthlyHeader = [
      "Name",
      ...months.flatMap((key) => [
        `${key} Attended`,
        `${key} Waitlisted`,
        `${key} Cancelled`,
      ]),
    ];
    const monthlyValues: unknown[][] = [
      monthlyHeader,
      ...ranked.map(({ m, a }) => [
        m.name,
        ...months.flatMap((key) => {
          const mc = a.byMonth.get(key) ?? emptyMonth();
          return [mc.attended, mc.waiting, mc.cancelled];
        }),
      ]),
    ];

    const token = await getGoogleToken();
    const tabs = await ensureTabs(token);
    await writeSheet(token, `${tabs.overview}!A1:F`, overviewValues);
    await writeSheet(token, `${tabs.monthly}!A1:ZZ`, monthlyValues);
    await colorOverviewSessionColumns(token, tabs.overviewId, overviewValues.length);
    await colorMonthlyStatusColumns(
      token,
      tabs.monthlyId,
      months.length,
      monthlyValues.length
    );

    return new Response(
      JSON.stringify({
        overviewWritten: overviewValues.length - 1,
        monthlyWritten: monthlyValues.length - 1,
        weeksRemaining: bounds.weeksRemaining,
        weeksElapsed: bounds.weeksElapsed,
        thisMonday: bounds.thisMonday,
        nextMonday: bounds.nextMonday,
        yearFrom: bounds.yearFrom,
        yearTo: bounds.yearTo,
        months,
        participantRows: rows.length,
        sheets: tabs,
      }),
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

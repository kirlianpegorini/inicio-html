import { createAdminClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

function safeDecode(input: string) {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type ScheduleSettings = {
  timezone?: string;
  work_days?: string[];
  morning_start?: string;
  morning_end?: string;
  afternoon_start?: string;
  afternoon_end?: string;
  slot_minutes?: number;
};

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new NextResponse(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Surrogate-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    },
  });
}

export async function OPTIONS() {
  return jsonResponse({ ok: true });
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function normalizeText(s: string) {
  return s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function parseDateFlexible(dateStr: string): { y: number; mo: number; d: number } | null {
  if (!dateStr) return null;

  const withoutTime = dateStr.split("T")[0].split(" ")[0].trim();
  let s = withoutTime.replace(/[{}]/g, "").trim();
  s = normalizeText(s).replace(/\s/g, "").replace(/["']/g, "");

  if (s === "hoje" || s === "hoj") {
    const today = new Date();
    return { y: today.getFullYear(), mo: today.getMonth() + 1, d: today.getDate() };
  }
  if (s === "amanha" || s === "amanhã" || s === "amanh") {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return { y: tomorrow.getFullYear(), mo: tomorrow.getMonth() + 1, d: tomorrow.getDate() };
  }

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };

  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return { y: Number(m[3]), mo: Number(m[2]), d: Number(m[1]) };

  m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (m) return { y: Number(m[3]), mo: Number(m[2]), d: Number(m[1]) };

  return null;
}

function ymdToString(ymd: { y: number; mo: number; d: number }) {
  return `${ymd.y}-${pad2(ymd.mo)}-${pad2(ymd.d)}`;
}

function addDaysToYMD(ymd: { y: number; mo: number; d: number }, add: number) {
  const dt = new Date(Date.UTC(ymd.y, ymd.mo - 1, ymd.d));
  dt.setUTCDate(dt.getUTCDate() + add);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function formatDDMM(ymdStr: string) {
  const [, m, d] = ymdStr.split("-");
  return `${d}/${m}`;
}

function isValidHHMM(s: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function getOffsetMinutes(timeZone: string, dateUTC: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = fmt.formatToParts(dateUTC);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;

  const asIfUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );

  return (asIfUTC - dateUTC.getTime()) / 60000;
}

function ymdToUTCRange(timeZone: string, ymd: { y: number; mo: number; d: number }) {
  const utcMidnight = new Date(Date.UTC(ymd.y, ymd.mo - 1, ymd.d, 0, 0, 0));
  const offset = getOffsetMinutes(timeZone, utcMidnight);
  const startUTC = new Date(utcMidnight.getTime() - offset * 60000);
  const endUTC = new Date(startUTC.getTime() + 86400000);
  return { startUTC, endUTC };
}

function buildSlotsForDay(settings: Required<ScheduleSettings>) {
  const slots: string[] = [];

  const addRange = (start: string, end: string) => {
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);

    let cur = sh * 60 + sm;
    const endMin = eh * 60 + em;

    while (cur + settings.slot_minutes <= endMin) {
      const hh = Math.floor(cur / 60);
      const mm = cur % 60;
      slots.push(`${pad2(hh)}:${pad2(mm)}`);
      cur += settings.slot_minutes;
    }
  };

  addRange(settings.morning_start, settings.morning_end);
  addRange(settings.afternoon_start, settings.afternoon_end);

  return slots;
}

function getTodayYMDInTZ(timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

function getLocalHHMM(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.hour}:${map.minute}`;
}

function getWeekdayKeyInTZ(ymdStr: string, timeZone: string): string {
  const [y, mo, d] = ymdStr.split("-").map(Number);
  const utcMid = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" });
  const wd = fmt.format(utcMid).toLowerCase();
  return wd.slice(0, 3);
}

function isYmdBefore(a: string, b: string) {
  return a < b;
}

export async function GET(req: NextRequest) {
  try {
    const adminSupabase = createAdminClient();
    const url = new URL(req.url);

    const simple = (url.searchParams.get("simple") || "").trim() === "1";

    const keyFromQuery = safeDecode(url.searchParams.get("key") || "").trim();
    const authHeader = req.headers.get("Authorization") || req.headers.get("x-api-key") || "";
    const rawKey = keyFromQuery ? keyFromQuery : authHeader.replace("Bearer ", "").trim();

    if (!rawKey) return jsonResponse({ success: false, error: "No API Key" }, 401);

    const hash = crypto.createHash("sha256").update(rawKey).digest("hex");

    const { data: apiKeyData } = await adminSupabase
      .from("api_keys")
      .select("project_id")
      .eq("key_hash", hash)
      .single();

    if (!apiKeyData) return jsonResponse({ success: false, error: "Invalid Key" }, 401);

    const defaults: Required<ScheduleSettings> = {
      timezone: "America/Sao_Paulo",
      work_days: ["mon", "tue", "wed", "thu", "fri"],
      morning_start: "08:00",
      morning_end: "12:00",
      afternoon_start: "13:00",
      afternoon_end: "18:00",
      slot_minutes: 30,
    };

    const { data: dbSettings } = await adminSupabase
      .from("schedule_settings")
      .select("*")
      .eq("project_id", apiKeyData.project_id)
      .maybeSingle();

    const settings: Required<ScheduleSettings> = { ...defaults, ...(dbSettings ?? {}) };
    const allSlots = buildSlotsForDay(settings);

    const startParam = safeDecode(
      url.searchParams.get("start") ||
        url.searchParams.get("data") ||
        url.searchParams.get("data_agendamento") ||
        url.searchParams.get("data_atendimento") ||
        ""
    ).trim();

    const days = Math.min(Number(url.searchParams.get("days") || "30"), 60);
    const limitPerDay = Math.min(Number(url.searchParams.get("limit_per_day") || "3"), 10);

    const fromParamRaw = safeDecode(url.searchParams.get("from") || "").trim();
    const fromHHMM = isValidHHMM(fromParamRaw) ? fromParamRaw : null;

    const todayStr = getTodayYMDInTZ(settings.timezone);
    const nowHHMM = getLocalHHMM(new Date(), settings.timezone);

    const startRaw = startParam || todayStr || "hoje";
    const parsed = parseDateFlexible(startRaw);
    if (!parsed) return jsonResponse({ success: false, error: `Data inválida: ${startRaw}` }, 400);

    let startYMD = parsed;
    let startYMDStr = ymdToString(startYMD);
    if (isYmdBefore(startYMDStr, todayStr)) {
      const [y, mo, d] = todayStr.split("-").map(Number);
      startYMD = { y, mo, d };
      startYMDStr = todayStr;
    }

    const results: Array<{ date: string; available_times: string[]; available_times_text: string }> = [];
    let firstAvailableDate: string | null = null;

    const endOfDayCutoff = settings.afternoon_end;

    for (let i = 0; i < days; i++) {
      const ymd = addDaysToYMD(startYMD, i);
      const dateStr = ymdToString(ymd);

      const wd = getWeekdayKeyInTZ(dateStr, settings.timezone);
      if (!settings.work_days.includes(wd)) continue;

      if (dateStr === todayStr && nowHHMM >= endOfDayCutoff) continue;

      const minHHMM = dateStr === todayStr ? (fromHHMM ? fromHHMM : nowHHMM) : null;
      const midUTC = ymdToUTCRange(settings.timezone, ymd);

      const { data: events, error: evErr } = await adminSupabase
        .from("appointments")
        .select("start_datetime")
        .eq("project_id", apiKeyData.project_id)
        .gte("start_datetime", midUTC.startUTC.toISOString())
        .lt("start_datetime", midUTC.endUTC.toISOString());

      if (evErr) throw new Error(evErr.message);

      const occupied = new Set<string>();

      for (const ev of events || []) {
        const dt = new Date((ev as { start_datetime: string }).start_datetime);

        const fmt = new Intl.DateTimeFormat("en-US", {
          timeZone: settings.timezone,
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        });

        const parts = fmt.formatToParts(dt);
        const map: Record<string, string> = {};
        for (const p of parts) map[p.type] = p.value;

        occupied.add(`${map.hour}:${map.minute}`);
      }

      const candidateSlots = minHHMM ? allSlots.filter((t) => t > minHHMM) : allSlots;
      const available = candidateSlots.filter((t) => !occupied.has(t));

      if (available.length === 0) continue;

      const preferAfternoon = i % 2 === 1;
      const morning = available.filter((t) => t >= settings.morning_start && t < settings.morning_end);
      const afternoon = available.filter(
        (t) => t >= settings.afternoon_start && t < settings.afternoon_end
      );

      const pickBase = preferAfternoon
        ? afternoon.length
          ? afternoon
          : morning
        : morning.length
          ? morning
          : afternoon;

      const finalSlots = pickBase.slice(0, limitPerDay);
      if (finalSlots.length === 0) continue;

      if (!firstAvailableDate) firstAvailableDate = dateStr;

      results.push({
        date: dateStr,
        available_times: finalSlots,
        available_times_text: finalSlots.join(", "),
      });

      if (results.length >= 10) break;
    }

    const availableDaysInline = results
      .map((d) => `${formatDDMM(d.date)}: ${d.available_times_text}`)
      .join(" | ");

    if (simple) {
      return jsonResponse({
        success: true,
        horarios_disponiveis_inline: availableDaysInline,
        horarios_disponiveis: availableDaysInline,
        available_days_text: availableDaysInline,
        tentativa_data: firstAvailableDate || "",
        first_available_date: firstAvailableDate || "",
        has_availability: results.length > 0,
      });
    }

    return jsonResponse({
      timezone: settings.timezone,
      start: ymdToString(startYMD),
      days,
      results,
      available_days_inline: availableDaysInline,
      available_days_text: availableDaysInline,
      first_available_date: firstAvailableDate || "",
      horarios_disponiveis: availableDaysInline,
      horarios_disponiveis_inline: availableDaysInline,
      tentativa_data: firstAvailableDate || "",
      success: true,
      has_availability: results.length > 0,
    });
  } catch (err: any) {
    return jsonResponse({ success: false, error: err?.message || "Internal error" }, 500);
  }
}

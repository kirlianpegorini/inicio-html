import { createAdminClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  getCalendarWithOAuthTokens,
  getGoogleCalendarClient,
  getGoogleOAuthClient,
} from "@/lib/google-calendar";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new NextResponse(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    },
  });
}

function normalizeText(s: string) {
  return s?.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") || "";
}

function parseTimeFlexible(timeStr: string) {
  const s = normalizeText(timeStr);

  const hhmm = /(?:^|\D)([01]?\d|2[0-3])[:h]([0-5]\d)(?:\D|$)/.exec(s);
  if (hhmm) return { hh: Number(hhmm[1]), mm: Number(hhmm[2]) };

  const onlyHour = /(?:^|\D)([01]?\d|2[0-3])(?:\D|$)/.exec(s);
  if (onlyHour) return { hh: Number(onlyHour[1]), mm: 0 };

  return null;
}

function getTodayPartsInTZ(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);

  return {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
  };
}

function parseDateFlexibleToYMD(dateStr: string, timeZone: string) {
  const s = normalizeText(String(dateStr)).replace(/["']/g, "");

  const today = getTodayPartsInTZ(timeZone);

  if (s.includes("hoje")) return today;

  if (s.includes("amanha")) {
    const dt = new Date(Date.UTC(today.y, today.mo - 1, today.d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  const weekdayMap: Record<string, number> = {
    domingo: 0,
    "dom": 0,
    "segunda": 1,
    "segunda-feira": 1,
    "seg": 1,
    "terca": 2,
    "terça": 2,
    "terca-feira": 2,
    "terça-feira": 2,
    "ter": 2,
    "quarta": 3,
    "quarta-feira": 3,
    "qua": 3,
    "quinta": 4,
    "quinta-feira": 4,
    "qui": 4,
    "sexta": 5,
    "sexta-feira": 5,
    "sex": 5,
    sabado: 6,
    "sábado": 6,
    "sab": 6,
  };

  const weekdayHit = Object.keys(weekdayMap).find((k) => s.includes(k));
  if (weekdayHit) {
    const target = weekdayMap[weekdayHit];
    const todayDate = new Date(Date.UTC(today.y, today.mo - 1, today.d));
    const short = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" })
      .format(todayDate)
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    const shortMap: Record<string, number> = {
      sun: 0,
      mon: 1,
      tue: 2,
      wed: 3,
      thu: 4,
      fri: 5,
      sat: 6,
    };
    const currentWeekday = shortMap[short] ?? todayDate.getUTCDay();

    const delta = (target - currentWeekday + 7) % 7 || 7;
    todayDate.setUTCDate(todayDate.getUTCDate() + delta);
    return {
      y: todayDate.getUTCFullYear(),
      mo: todayDate.getUTCMonth() + 1,
      d: todayDate.getUTCDate(),
    };
  }

  const compact = s.replace(/\s/g, "");

  let m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return { y: Number(m[3]), mo: Number(m[2]), d: Number(m[1]) };
  m = /(\d{1,2})-(\d{1,2})-(\d{4})/.exec(s);
  if (m) return { y: Number(m[3]), mo: Number(m[2]), d: Number(m[1]) };
  m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };

  // dd/mm (sem ano): assume o próximo dia válido no calendário
  m = /(\d{1,2})\/(\d{1,2})/.exec(compact);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const base = new Date(Date.UTC(today.y, mo - 1, d));
    const candidate = { y: today.y, mo, d };

    const candidateStr = `${candidate.y}-${String(candidate.mo).padStart(2, "0")}-${String(candidate.d).padStart(2, "0")}`;
    const todayStr = `${today.y}-${String(today.mo).padStart(2, "0")}-${String(today.d).padStart(2, "0")}`;
    if (!Number.isNaN(base.getTime()) && candidateStr >= todayStr) return candidate;
    if (!Number.isNaN(base.getTime())) return { y: today.y + 1, mo, d };
  }

  return null;
}

function getOffsetMinutes(timeZone: string, utcDate: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(utcDate);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return Math.round((asUTC - utcDate.getTime()) / 60000);
}

function localDateTimeToUTCISOString(
  ymd: { y: number; mo: number; d: number },
  hh: number,
  mm: number,
  timeZone: string
) {
  const naiveUTC = new Date(Date.UTC(ymd.y, ymd.mo - 1, ymd.d, hh, mm, 0));
  const offset = getOffsetMinutes(timeZone, naiveUTC);
  return new Date(naiveUTC.getTime() - offset * 60000).toISOString();
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
      "Access-Control-Max-Age": "86400",
    },
  });
}

async function getCalendarClientForUser(adminSupabase: any, userId: string) {
  const { data: tokenRow } = await adminSupabase
    .from("google_oauth_tokens")
    .select("access_token, refresh_token, scope, token_type, expiry_date")
    .eq("user_id", userId)
    .maybeSingle();

  if (tokenRow?.refresh_token || tokenRow?.access_token) {
    const oauth = getGoogleOAuthClient();
    oauth.setCredentials({
      access_token: tokenRow.access_token || undefined,
      refresh_token: tokenRow.refresh_token || undefined,
      scope: tokenRow.scope || undefined,
      token_type: tokenRow.token_type || undefined,
      expiry_date: tokenRow.expiry_date || undefined,
    });

    if (tokenRow.refresh_token) {
      try {
        const refreshed = await oauth.refreshAccessToken();
        const newTokens = refreshed.credentials;
        await adminSupabase.from("google_oauth_tokens").upsert(
          {
            user_id: userId,
            access_token: newTokens.access_token || tokenRow.access_token || null,
            refresh_token: newTokens.refresh_token || tokenRow.refresh_token || null,
            scope: newTokens.scope || tokenRow.scope || null,
            token_type: newTokens.token_type || tokenRow.token_type || null,
            expiry_date: newTokens.expiry_date || tokenRow.expiry_date || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        );
      } catch {
        // keep existing tokens
      }
    }

    return {
      calendar: getCalendarWithOAuthTokens(tokenRow),
      authMode: "oauth" as const,
    };
  }

  return {
    calendar: getGoogleCalendarClient(),
    authMode: "service_account" as const,
  };
}

export async function POST(req: NextRequest) {
  const adminSupabase = createAdminClient();

  try {
    const body = await req.json().catch(() => ({}));
    const payload = body?.root || body;

    const nomeCliente = payload?.name || payload?.nome || payload?.n || payload?.Nome || "Cliente";
    const dataAgendamento = payload?.date || payload?.data || payload?.d;
    const horaAgendamento = payload?.time || payload?.hora || payload?.h;
    const telefone = payload?.phone || payload?.telefone || payload?.p || "";
    const email = payload?.email || payload?.e || "";

    const url = new URL(req.url);
    const authHeader =
      req.headers.get("Authorization") || req.headers.get("x-api-key") || url.searchParams.get("key");
    const rawKey = authHeader?.replace("Bearer ", "").trim();
    const hash = crypto.createHash("sha256").update(rawKey || "").digest("hex");

    const { data: apiKeyData } = await adminSupabase
      .from("api_keys")
      .select("project_id")
      .eq("key_hash", hash)
      .single();

    if (!apiKeyData) return jsonResponse({ error: "Chave API inválida" }, 401);

    // tolerância para payload humano: pode vir "12/02 às 09:00" no campo data
    const mergedForDate = `${String(dataAgendamento || "")} ${String(horaAgendamento || "")}`;
    const mergedForTime = `${String(horaAgendamento || "")} ${String(dataAgendamento || "")}`;

    const { data: dbSettings } = await adminSupabase
      .from("schedule_settings")
      .select("timezone, slot_minutes")
      .eq("project_id", apiKeyData.project_id)
      .maybeSingle();

    const timeZone = dbSettings?.timezone || "America/Sao_Paulo";

    const ymd = parseDateFlexibleToYMD(String(dataAgendamento || mergedForDate), timeZone);
    const t = parseTimeFlexible(String(horaAgendamento || mergedForTime)) || parseTimeFlexible(mergedForTime);

    if (!ymd || !t) {
      return jsonResponse(
        {
          error: "Data ou hora inválida",
          recebido: { data: dataAgendamento, hora: horaAgendamento },
        },
        400
      );
    }

    const startISO = localDateTimeToUTCISOString(ymd, t.hh, t.mm, timeZone);
    const endISO = new Date(
      new Date(startISO).getTime() + (Number(dbSettings?.slot_minutes) || 60) * 60000
    ).toISOString();

    const { data: project } = await adminSupabase
      .from("projects")
      .select("owner_id")
      .eq("id", apiKeyData.project_id)
      .single();

    if (!project?.owner_id) {
      return jsonResponse({ success: false, error: "Projeto sem owner_id válido" }, 400);
    }

    // Idempotência: BotConversa pode reenviar o mesmo POST.
    // Se já existir appointment para o mesmo cliente+horário, retornamos sucesso sem duplicar.
    const { data: existingAppointment, error: existingErr } = await adminSupabase
      .from("appointments")
      .select("id, meet_link, calendar_event_id, status")
      .eq("client_id", project.owner_id)
      .eq("start_datetime", startISO)
      .maybeSingle();

    if (existingErr) throw new Error(`Erro Supabase (check duplicate): ${existingErr.message}`);

    const shouldOnlyReturnDuplicate =
      !!existingAppointment && (!!existingAppointment.calendar_event_id || !!existingAppointment.meet_link);

    if (shouldOnlyReturnDuplicate) {
      return jsonResponse({
        success: true,
        duplicate: true,
        id: existingAppointment!.id,
        calendar_status: "Já existia agendamento para este horário.",
        meet_link: existingAppointment!.meet_link || null,
        event_html_link: null,
        calendar_auth_mode: null,
        calendar_id_used: null,
        google_event_status: existingAppointment!.status || null,
        google_creator_email: null,
        google_organizer_email: null,
        msg: "Horário já reservado anteriormente.",
      });
    }

    let calendar_event_id: string | null = null;
    let meet_link: string | null = null;
    let gcal_status = "Não conectado";
    let event_html_link: string | null = null;
    let calendar_auth_mode: "oauth" | "service_account" | null = null;
    let calendar_id_used: string | null = null;
    let google_event_status: string | null = null;
    let google_creator_email: string | null = null;
    let google_organizer_email: string | null = null;

    try {
      const { data: conn } = await adminSupabase
        .from("calendar_connections")
        .select("calendar_id")
        .eq("user_id", project?.owner_id)
        .maybeSingle();

      if (conn?.calendar_id && project?.owner_id) {
        const { calendar, authMode } = await getCalendarClientForUser(adminSupabase, project.owner_id);
        calendar_auth_mode = authMode;
        calendar_id_used = conn.calendar_id;

        // Com service account, "primary" aponta para o calendário da conta de serviço,
        // então o evento não aparece no Google Calendar do usuário.
        if (authMode === "service_account" && conn.calendar_id === "primary") {
          gcal_status =
            "Google Calendar não sincronizado: conecte OAuth do usuário para usar calendar_id=primary.";
          throw new Error(gcal_status);
        }

        const baseRequestBody = {
          summary: `Agendamento: ${nomeCliente}`,
          description: `Cliente: ${nomeCliente}\nTelefone: ${telefone}\nEmail: ${email}`,
          start: { dateTime: startISO, timeZone },
          end: { dateTime: endISO, timeZone },
        };

        try {
          const withMeet = await calendar.events.insert({
            calendarId: conn.calendar_id,
            conferenceDataVersion: 1,
            requestBody: {
              ...baseRequestBody,
              conferenceData: {
                createRequest: {
                  requestId: `meet-${Date.now()}`,
                },
              },
            },
          });

          calendar_event_id = withMeet.data.id || null;
          meet_link = withMeet.data.hangoutLink || withMeet.data.conferenceData?.entryPoints?.[0]?.uri || null;
          event_html_link = withMeet.data.htmlLink || null;
          google_event_status = withMeet.data.status || null;
          google_creator_email = withMeet.data.creator?.email || null;
          google_organizer_email = withMeet.data.organizer?.email || null;
          gcal_status = meet_link ? "Evento + Meet criados" : "Evento criado (sem Meet)";
        } catch (meetErr: any) {
          console.error("Meet indisponível, criando evento sem meet:", meetErr?.message || meetErr);

          const withoutMeet = await calendar.events.insert({
            calendarId: conn.calendar_id,
            requestBody: baseRequestBody,
          });

          calendar_event_id = withoutMeet.data.id || null;
          meet_link = null;
          event_html_link = withoutMeet.data.htmlLink || null;
          google_event_status = withoutMeet.data.status || null;
          google_creator_email = withoutMeet.data.creator?.email || null;
          google_organizer_email = withoutMeet.data.organizer?.email || null;
          gcal_status = "Evento criado sem Meet (fallback).";
        }

        if (calendar_event_id) {
          try {
            const check = await calendar.events.get({
              calendarId: conn.calendar_id,
              eventId: calendar_event_id,
            });
            google_event_status = check.data.status || google_event_status;
            google_creator_email = check.data.creator?.email || google_creator_email;
            google_organizer_email = check.data.organizer?.email || google_organizer_email;
            event_html_link = check.data.htmlLink || event_html_link;
          } catch (verifyErr: any) {
            console.error("Evento criado, mas falhou verificação de leitura:", verifyErr?.message || verifyErr);
          }
        }
      }
    } catch (err: any) {
      console.error("Erro Google Calendar:", err);
      gcal_status = `Erro Google: ${err?.message || "desconhecido"}`;
    }

    const persistPayload = {
      project_id: apiKeyData.project_id,
      client_id: project.owner_id,
      start_datetime: startISO,
      end_datetime: endISO,
      customer_name: nomeCliente,
      customer_phone: telefone,
      customer_email: email || null,
      status: "agendado",
      calendar_event_id,
      meet_link: meet_link || "",
    };

    const { data: appointment, error: dbErr } = existingAppointment
      ? await adminSupabase
          .from("appointments")
          .update(persistPayload)
          .eq("id", existingAppointment.id)
          .select()
          .single()
      : await adminSupabase.from("appointments").insert(persistPayload).select().single();

    if (dbErr) {
      const isDuplicate = dbErr.code === "23505" || /unique_client_appointment/i.test(dbErr.message || "");

      if (isDuplicate) {
        const { data: existingAfterRace } = await adminSupabase
          .from("appointments")
          .select("id, meet_link, calendar_event_id, status")
          .eq("client_id", project.owner_id)
          .eq("start_datetime", startISO)
          .maybeSingle();

        return jsonResponse({
          success: true,
          duplicate: true,
          id: existingAfterRace?.id || null,
          calendar_status: "Já existia agendamento para este horário.",
          meet_link: existingAfterRace?.meet_link || null,
          event_html_link,
          calendar_auth_mode,
          calendar_id_used,
          google_event_status: existingAfterRace?.status || google_event_status,
          google_creator_email,
          google_organizer_email,
          msg: "Horário já reservado anteriormente.",
        });
      }

      throw new Error(`Erro Supabase: ${dbErr.message}`);
    }

    return jsonResponse({
      success: true,
      recovered_existing: !!existingAppointment,
      id: appointment.id,
      calendar_status: gcal_status,
      meet_link,
      event_html_link,
      calendar_auth_mode,
      calendar_id_used,
      google_event_status,
      google_creator_email,
      google_organizer_email,
      msg: meet_link ? "Agendamento realizado com Meet!" : "Agendamento realizado!",
    });
  } catch (err: any) {
    console.error("Erro geral:", err);
    return jsonResponse({ success: false, error: err?.message || "Erro interno" }, 500);
  }
}

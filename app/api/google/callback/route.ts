import { NextRequest, NextResponse } from "next/server";
import { getGoogleOAuthClient } from "@/lib/google-calendar";
import { createAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      return NextResponse.json({ error: "Parâmetros OAuth inválidos." }, { status: 400 });
    }

    const parsedState = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    const userId = parsedState?.userId;

    if (!userId) {
      return NextResponse.json({ error: "state inválido." }, { status: 400 });
    }

    const oauth = getGoogleOAuthClient();
    const { tokens } = await oauth.getToken(code);

    const admin = createAdminClient();

    const { error } = await admin.from("google_oauth_tokens").upsert(
      {
        user_id: userId,
        access_token: tokens.access_token || null,
        refresh_token: tokens.refresh_token || null,
        scope: tokens.scope || null,
        token_type: tokens.token_type || null,
        expiry_date: tokens.expiry_date || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
    return NextResponse.redirect(`${siteUrl}/dashboard?google=connected`);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Falha no callback OAuth" }, { status: 500 });
  }
}

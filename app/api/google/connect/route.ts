import { NextRequest, NextResponse } from "next/server";
import { getGoogleOAuthClient } from "@/lib/google-calendar";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const oauth = getGoogleOAuthClient();
  const state = Buffer.from(JSON.stringify({ userId: user.id })).toString("base64url");

  const url = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
    ],
    state,
  });

  return NextResponse.redirect(url);
}

import { google } from "googleapis";

export function getGoogleCalendarClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}");

  if (!credentials.private_key || !credentials.client_email) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON não configurado corretamente.");
  }

  const formattedKey = credentials.private_key.replace(/\\n/g, "\n");

  const auth = new google.auth.JWT(
    credentials.client_email,
    undefined,
    formattedKey,
    [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
    ]
  );

  return google.calendar({ version: "v3", auth });
}

export function getGoogleOAuthClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Variáveis GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI não configuradas.");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getCalendarWithOAuthTokens(tokens: {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string | null;
  token_type?: string | null;
  expiry_date?: number | null;
}) {
  const auth = getGoogleOAuthClient();
  auth.setCredentials({
    access_token: tokens.access_token || undefined,
    refresh_token: tokens.refresh_token || undefined,
    scope: tokens.scope || undefined,
    token_type: tokens.token_type || undefined,
    expiry_date: tokens.expiry_date || undefined,
  });

  return google.calendar({ version: "v3", auth });
}

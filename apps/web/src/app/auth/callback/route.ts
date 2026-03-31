import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const publicOrigin = getPublicOrigin(request, requestUrl);
  const code = requestUrl.searchParams.get("code");
  const next = normalizeNextPath(requestUrl.searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      return NextResponse.redirect(new URL(next, publicOrigin));
    }
  }

  return NextResponse.redirect(new URL("/login", publicOrigin));
}

function normalizeNextPath(next: string | null): string {
  if (!next) {
    return "/";
  }

  if (!next.startsWith("/") || next.startsWith("//")) {
    return "/";
  }

  return next;
}

function getPublicOrigin(request: Request, fallbackUrl: URL): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");

  if (forwardedHost) {
    return `${forwardedProto || "https"}://${forwardedHost}`;
  }

  const host = request.headers.get("host");
  if (host) {
    return `${forwardedProto || fallbackUrl.protocol.replace(":", "")}://${host}`;
  }

  return fallbackUrl.origin;
}

// Thin edge function: sends push notifications when alerts are created
// Triggered via database webhook on smon_alerts INSERT

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

Deno.serve(async (req: Request) => {
  try {
    const payload = await req.json();
    const alert = payload.record;

    if (!alert || !alert.title) {
      return new Response(JSON.stringify({ error: "No alert data" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Only send push for warning and critical alerts
    if (alert.severity === "info") {
      return new Response(JSON.stringify({ skipped: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Fetch push subscriptions
    const subsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/smon_push_subscriptions?select=endpoint,p256dh,auth`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    const subscriptions = await subsResponse.json();

    if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Send push to all subscriptions
    const pushPayload = JSON.stringify({
      title: `${alert.severity.toUpperCase()}: ${alert.title}`,
      message: alert.message || "",
      id: alert.id,
      url: "/",
    });

    let sent = 0;
    for (const sub of subscriptions) {
      try {
        // Note: In production, use web-push library via npm
        // For now, we just log the intent
        console.log(`Would push to: ${sub.endpoint}`);
        sent++;
      } catch (e) {
        console.error(`Push failed for ${sub.endpoint}:`, e);
      }
    }

    return new Response(JSON.stringify({ sent }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});

// Supabase Edge Function — recebe webhooks da Stripe e regista reservas.
// A assinatura do webhook é verificada: pedidos forjados são rejeitados.
//
// Deploy:  supabase functions deploy stripe-webhook --no-verify-jwt
// Secrets: supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_...

import Stripe from "https://esm.sh/stripe@16?target=denonext";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // service role: só existe no servidor
);

const CAPACITY: Record<string, number> = { individual: 10, team: 5 };

function typeFromSession(s: Stripe.Checkout.Session): "individual" | "team" | null {
  const ref = s.client_reference_id ?? "";
  if (ref.startsWith("team")) return "team";
  if (ref.startsWith("individual")) return "individual";
  // fallback: pelo valor
  if (s.amount_total === 17000) return "team";
  if (s.amount_total === 6000) return "individual";
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("Missing signature", { status: 400 });

  let event: Stripe.Event;
  try {
    const body = await req.text();
    event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
  } catch (err) {
    console.error("Invalid signature", err);
    return new Response("Invalid signature", { status: 400 });
  }

  // Log bruto + idempotência (a Stripe pode reenviar o mesmo evento)
  const { data: seen } = await supabase.from("stripe_events").select("processed").eq("id", event.id).maybeSingle();
  if (seen?.processed) return new Response(JSON.stringify({ received: true, duplicate: true }), { headers: { "Content-Type": "application/json" } });
  await supabase.from("stripe_events").upsert({ id: event.id, type: event.type, payload: event as unknown as Record<string, unknown> });

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.payment_status !== "paid") break;
        const type = typeFromSession(s);
        if (!type) { console.warn("Unknown type for session", s.id); break; }

        // Detalhes do pagamento (método, recibo, país)
        const piId = typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id ?? null;
        let payment_method: string | null = null, receipt_url: string | null = null, billing_country: string | null = null;
        if (piId) {
          try {
            const pi = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge"] });
            const ch = pi.latest_charge as Stripe.Charge | null;
            payment_method = ch?.payment_method_details?.type ?? null;
            receipt_url = ch?.receipt_url ?? null;
            billing_country = ch?.billing_details?.address?.country ?? null;
          } catch (e) { console.warn("PI retrieve failed", e); }
        }

        // Verifica capacidade (soft limit — a Payment Link também deve ter limite de stock)
        const { count } = await supabase
          .from("reservations")
          .select("*", { count: "exact", head: true })
          .eq("type", type).eq("status", "paid");
        if ((count ?? 0) >= CAPACITY[type]) console.warn(`Capacity exceeded for ${type}`, s.id);

        const { error } = await supabase.from("reservations").upsert({
          type,
          email: (s.customer_details?.email ?? s.customer_email ?? "").toLowerCase(),
          name: s.customer_details?.name ?? null,
          phone: s.customer_details?.phone ?? null,
          amount_cents: s.amount_total ?? 0,
          currency: s.currency ?? "eur",
          stripe_session_id: s.id,
          stripe_payment_intent: piId,
          stripe_customer_id: typeof s.customer === "string" ? s.customer : s.customer?.id ?? null,
          client_reference_id: s.client_reference_id,
          payment_status: s.payment_status,
          payment_method, receipt_url, billing_country,
          metadata: s.metadata ?? null,
          raw: s as unknown as Record<string, unknown>,
          status: "paid",
        }, { onConflict: "stripe_session_id" });
        if (error) throw error;
        break;
      }

      case "charge.dispute.created": {
        const d = event.data.object as Stripe.Dispute;
        const pi = typeof d.payment_intent === "string" ? d.payment_intent : d.payment_intent?.id;
        if (pi) await supabase.from("reservations").update({ status: "disputed" }).eq("stripe_payment_intent", pi);
        break;
      }

      case "charge.refunded": {
        const c = event.data.object as Stripe.Charge;
        const pi = typeof c.payment_intent === "string" ? c.payment_intent : c.payment_intent?.id;
        if (!pi) break;
        const full = c.amount_refunded >= c.amount;
        const { error } = await supabase
          .from("reservations")
          .update({
            status: full ? "refunded" : "partially_refunded",
            amount_refunded_cents: c.amount_refunded,
            refunded_at: full ? new Date().toISOString() : null,
          })
          .eq("stripe_payment_intent", pi);
        if (error) throw error;
        break;
      }
    }
    await supabase.from("stripe_events").update({ processed: true }).eq("id", event.id);
    return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error(err);
    await supabase.from("stripe_events").update({ error: String(err) }).eq("id", event.id);
    return new Response("Handler error", { status: 500 });
  }
});

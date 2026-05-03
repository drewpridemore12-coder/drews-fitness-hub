import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const STRIPE_SECRET_KEY      = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
const STRIPE_WEBHOOK_SECRET  = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''
const SUPABASE_URL            = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Price ID → plan name mapping — update these with your actual Stripe price IDs
const PRICE_TO_PLAN: Record<string, string> = {
  'price_1TSnf5A1uPzh0uBq8cZ9ZHFz':   'pro',
  'price_1TSnfGA1uPzh0uBq6HbvDr1W': 'elite',
}

const cors = { 'Access-Control-Allow-Origin': '*' }

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const body = await req.text()
  const sig  = req.headers.get('stripe-signature') ?? ''

  // Verify Stripe signature
  if (STRIPE_WEBHOOK_SECRET) {
    try {
      const encoder   = new TextEncoder()
      const parts     = sig.split(',')
      const timestamp = parts.find(p => p.startsWith('t='))?.split('=')[1] ?? ''
      const v1sig     = parts.find(p => p.startsWith('v1='))?.split('=')[1] ?? ''
      const payload   = `${timestamp}.${body}`
      const key       = await crypto.subtle.importKey('raw', encoder.encode(STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const mac       = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
      const computed  = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('')
      if (computed !== v1sig) return new Response('Invalid signature', { status: 400 })
    } catch {
      return new Response('Signature error', { status: 400 })
    }
  }

  const event = JSON.parse(body)
  const sb    = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })

  if (event.type === 'checkout.session.completed') {
    const session  = event.data.object
    const uid      = session.metadata?.supabase_uid
    const lineItems = await fetchLineItems(session.id)
    const priceId  = lineItems?.[0]?.price?.id ?? ''
    const plan     = PRICE_TO_PLAN[priceId] ?? 'pro'

    if (uid) {
      await sb.from('profiles').update({ plan, stripe_customer_id: session.customer }).eq('id', uid)
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub        = event.data.object
    const customerId = sub.customer
    const { data }   = await sb.from('profiles').select('id').eq('stripe_customer_id', customerId).maybeSingle()
    if (data?.id) await sb.from('profiles').update({ plan: 'free' }).eq('id', data.id)
  }

  if (event.type === 'invoice.payment_failed') {
    const invoice    = event.data.object
    const customerId = invoice.customer
    const { data }   = await sb.from('profiles').select('id').eq('stripe_customer_id', customerId).maybeSingle()
    if (data?.id) await sb.from('profiles').update({ plan: 'free' }).eq('id', data.id)
  }

  return new Response(JSON.stringify({ received: true }), { headers: { ...cors, 'Content-Type': 'application/json' } })
})

async function fetchLineItems(sessionId: string) {
  try {
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items`, {
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
    })
    const d = await r.json()
    return d.data ?? []
  } catch { return [] }
}

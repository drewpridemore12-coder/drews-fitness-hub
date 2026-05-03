import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const STRIPE_SECRET_KEY    = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { priceId, successUrl, cancelUrl } = await req.json()
    if (!priceId) return new Response(JSON.stringify({ error: 'priceId required' }), { status: 400, headers: cors })

    // Get user from JWT
    const authHeader = req.headers.get('Authorization') ?? ''
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
    const { data: { user } } = await sb.auth.getUser(authHeader.replace('Bearer ', ''))
    if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors })

    // Get or create Stripe customer
    const { data: profile } = await sb.from('profiles').select('stripe_customer_id, email').eq('id', user.id).maybeSingle()
    let customerId = profile?.stripe_customer_id

    if (!customerId) {
      const custRes = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ email: user.email ?? '', metadata: JSON.stringify({ supabase_uid: user.id }) }),
      })
      const cust = await custRes.json()
      customerId = cust.id
      await sb.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id)
    }

    // Create checkout session
    const params = new URLSearchParams({
      customer: customerId,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      mode: 'subscription',
      success_url: successUrl || 'https://levelupfitness-app.netlify.app?upgraded=1',
      cancel_url:  cancelUrl  || 'https://levelupfitness-app.netlify.app?cancelled=1',
      'metadata[supabase_uid]': user.id,
    })

    const sessionRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    })
    const session = await sessionRes.json()
    if (!session.url) return new Response(JSON.stringify({ error: session.error?.message ?? 'Stripe error' }), { status: 500, headers: cors })

    return new Response(JSON.stringify({ url: session.url }), { headers: { ...cors, 'Content-Type': 'application/json' } })

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors })
  }
})

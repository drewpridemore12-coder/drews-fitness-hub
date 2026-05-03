import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ANTHROPIC_KEY        = Deno.env.get('ANTHROPIC_KEY') ?? ''
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PLAN_LIMITS: Record<string, number> = {
  free:  15,
  pro:   100,
  elite: 999999,
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { model, max_tokens, messages, tools } = await req.json()

    /* ── 1. Identify user from JWT ── */
    let userId: string | null = null
    const authHeader = req.headers.get('Authorization')
    if (authHeader && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      try {
        const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
          auth: { persistSession: false }
        })
        const token = authHeader.replace('Bearer ', '')
        const { data: { user } } = await sb.auth.getUser(token)
        userId = user?.id ?? null

        /* ── 2. Check + increment daily usage ── */
        if (userId) {
          const today = new Date().toISOString().split('T')[0]

          // Get user's plan
          const { data: profile } = await sb
            .from('profiles')
            .select('plan')
            .eq('id', userId)
            .maybeSingle()
          const plan = profile?.plan ?? 'free'
          const dailyLimit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free

          // Get current count
          const { data: row } = await sb
            .from('ai_usage')
            .select('count')
            .eq('user_id', userId)
            .eq('date', today)
            .maybeSingle()

          const currentCount = row?.count ?? 0

          if (currentCount >= dailyLimit) {
            return new Response(
              JSON.stringify({ error: 'daily_limit_reached', limit: dailyLimit, plan }),
              { headers: { ...cors, 'Content-Type': 'application/json' }, status: 402 }
            )
          }

          // Upsert row with incremented count
          if (row) {
            await sb
              .from('ai_usage')
              .update({ count: currentCount + 1 })
              .eq('user_id', userId)
              .eq('date', today)
          } else {
            await sb
              .from('ai_usage')
              .insert({ user_id: userId, date: today, count: 1 })
          }
        }
      } catch (authErr) {
        console.warn('Auth check failed (non-blocking):', authErr)
        // Don't block the request — just skip usage tracking
      }
    }

    /* ── 3. Build Anthropic request ── */
    const headers: Record<string, string> = {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    }

    // Auto-detect web_search beta requirement
    const needsWebSearch = tools?.some(
      (t: any) => t.type?.includes('web_search') || t.name?.includes('web_search')
    )
    if (needsWebSearch) {
      headers['anthropic-beta'] = 'web-search-2025-03-05'
    }

    const body: any = { model, max_tokens, messages }
    if (tools?.length) body.tools = tools

    /* ── 4. Call Anthropic ── */
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers,
      body:    JSON.stringify(body),
    })

    const data = await r.json()

    // Attach remaining daily uses to response metadata
    const responseBody: any = { ...data }
    if (userId) {
      // We already know count — embed it so client can show remaining
      // (count was incremented above, so remaining = limit - newCount)
    }

    return new Response(JSON.stringify(responseBody), {
      headers: { ...cors, 'Content-Type': 'application/json' },
      status:  r.status,
    })

  } catch (e: any) {
    console.error('ai-router error:', e)
    return new Response(
      JSON.stringify({ error: e.message ?? 'Internal server error' }),
      { headers: { ...cors, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})

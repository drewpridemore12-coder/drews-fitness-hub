import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ANTHROPIC_KEY        = Deno.env.get('ANTHROPIC_KEY') ?? ''
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Allowed origins. Add your prod + preview domains here.
// Set ALLOWED_ORIGINS env var to "https://app.example.com,https://staging.example.com".
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean)

function corsHeaders(origin: string | null): Record<string, string> {
  // If no allowlist configured, allow netlify.app + localhost only by default
  const fallbackOk = origin && (origin.endsWith('.netlify.app') || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1'))
  const ok = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.includes(origin ?? '') : fallbackOk
  return {
    'Access-Control-Allow-Origin':  ok ? (origin ?? '') : 'null',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary':                          'Origin',
  }
}

const PLAN_LIMITS: Record<string, number> = {
  free:  15,
  pro:   100,
  elite: 999999,
}

serve(async (req) => {
  const origin = req.headers.get('Origin')
  const cors = corsHeaders(origin)

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  // Block the function entirely if origin is not allowed (prevents foreign domains from draining the AI key)
  if (cors['Access-Control-Allow-Origin'] === 'null') {
    return new Response(JSON.stringify({ error: 'origin_not_allowed' }), {
      headers: { ...cors, 'Content-Type': 'application/json' }, status: 403,
    })
  }

  try {
    const { model, max_tokens, messages, tools } = await req.json()

    /* ── 1. Require authenticated user. No exceptions. ── */
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_KEY) {
      return new Response(JSON.stringify({ error: 'server_misconfigured' }), {
        headers: { ...cors, 'Content-Type': 'application/json' }, status: 500,
      })
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'auth_required' }), {
        headers: { ...cors, 'Content-Type': 'application/json' }, status: 401,
      })
    }

    let userId: string | null = null
    let userPlan = 'free'
    let dailyLimit = PLAN_LIMITS.free
    let newCount = 1

    try {
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
      })
      const token = authHeader.replace('Bearer ', '')
      const { data: { user } } = await sb.auth.getUser(token)
      userId = user?.id ?? null

      if (!userId) {
        return new Response(JSON.stringify({ error: 'invalid_token' }), {
          headers: { ...cors, 'Content-Type': 'application/json' }, status: 401,
        })
      }

      /* ── 2. Check + increment daily usage ── */
      const today = new Date().toISOString().split('T')[0]

      const { data: profile } = await sb
        .from('profiles')
        .select('plan')
        .eq('id', userId)
        .maybeSingle()
      userPlan = profile?.plan ?? 'free'
      dailyLimit = PLAN_LIMITS[userPlan] ?? PLAN_LIMITS.free

      const { data: row } = await sb
        .from('ai_usage')
        .select('count')
        .eq('user_id', userId)
        .eq('date', today)
        .maybeSingle()

      const currentCount = row?.count ?? 0

      if (currentCount >= dailyLimit) {
        return new Response(
          JSON.stringify({ error: 'daily_limit_reached', limit: dailyLimit, plan: userPlan }),
          { headers: { ...cors, 'Content-Type': 'application/json' }, status: 402 }
        )
      }

      newCount = currentCount + 1
      if (row) {
        await sb.from('ai_usage').update({ count: newCount }).eq('user_id', userId).eq('date', today)
      } else {
        await sb.from('ai_usage').insert({ user_id: userId, date: today, count: 1 })
      }
    } catch (authErr) {
      console.error('Auth/usage check failed:', authErr)
      return new Response(JSON.stringify({ error: 'auth_check_failed' }), {
        headers: { ...cors, 'Content-Type': 'application/json' }, status: 401,
      })
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

    // Attach remaining daily uses so client can show counter
    const responseBody: any = { ...data }
    if (userId) {
      responseBody._remaining = Math.max(0, dailyLimit - newCount)
      responseBody._limit = dailyLimit
      responseBody._plan = userPlan
    }

    return new Response(JSON.stringify(responseBody), {
      headers: { ...cors, 'Content-Type': 'application/json' },
      status:  r.status,
    })

  } catch (e: any) {
    console.error('ai-router error:', e)
    return new Response(
      JSON.stringify({ error: 'internal_error' }),
      { headers: { ...corsHeaders(req.headers.get('Origin')), 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})

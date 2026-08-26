/** POST /v1/businesses/{id}/publish */

import { guard } from '@/app/api/v1/_shared'
import { publishBusiness } from '@/server/businessService'
import { apiError, apiOk } from '@/lib/http'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { clientIp } from '@/server/auth'
import { track } from '@/server/analytics'

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const g = await guard('business:publish')
  if (!g.ok) return g.response
  const { auth, requestId } = g

  const { id } = await ctx.params
  const result = await publishBusiness({
    db: supabaseAdmin(),
    providerUserId: auth.userId,
    businessId: id,
    now: new Date(),
    ip: clientIp(req),
  })

  if (!result.ok) {
    if (result.code === 'BUSINESS_NOT_FOUND') {
      return apiError('NOT_FOUND', 'That business was not found.', 404, { requestId })
    }
    if (result.code === 'NO_PROVIDER_PROFILE') {
      return apiError(result.code, 'Complete provider onboarding first.', 409, { requestId })
    }
    if (result.code === 'BLOCKED') {
      // Every blocker at once, so the UI can render a checklist rather than
      // revealing one problem per attempt.
      return Response.json(
        {
          error: {
            code: 'PUBLISH_BLOCKED',
            message: 'A few things need finishing before this can go live.',
            requestId,
            fieldErrors: {},
            blockers: result.blockers ?? [],
          },
        },
        { status: 409 },
      )
    }
    return apiError('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500, { requestId })
  }

  track({
    event: 'business_published',
    userId: auth.userId,
    properties: { business_id: id },
  })

  return apiOk({ slug: result.slug, publishedAt: result.publishedAt, state: 'published' })
}

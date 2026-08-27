/**
 * PUT /v1/provider-services/{id}/service-area
 *
 * The private geometry stored here is what address eligibility is computed
 * against and is never returned to an unauthenticated caller. The response
 * deliberately echoes nothing back but an id.
 *
 * ## Two ways in
 *
 * A raw GeoJSON polygon, or a centre address plus a radius which the server
 * geocodes and turns into a circle. UX_UI_SPEC section 5 requires that
 * "maps cannot be the only way to define/read a service area", and the
 * second form is what makes that true -- it works on a phone, from a
 * keyboard, and read aloud.
 *
 * The geocoding happens here rather than in the browser because the result
 * decides which houses are inside a teenager's route. A client-supplied
 * coordinate would let a caller place their area anywhere.
 *
 * No public generalized geometry is derived from a circle. A generalized
 * circle still has a centre, and publishing one centred near a minor's home
 * narrows their location to a few streets however coarse the edge is. The
 * storefront shows a coarse area LABEL instead.
 */

import { z } from 'zod'
import { guard, parseJson, fieldErrorsFrom } from '@/app/api/v1/_shared'
import { setServiceArea, serviceAreaSchema } from '@/server/businessService'
import { addressSchema } from '@/server/eligibility'
import { getGeocoder } from '@/server/geocoder'
import {
  circlePolygon,
  MAX_RADIUS_METRES,
  MIN_RADIUS_METRES,
  type GeoJsonPolygon,
} from '@/domain/serviceArea'
import { apiError, apiOk } from '@/lib/http'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { clientIp } from '@/server/auth'

const radiusSchema = z.object({
  centre: addressSchema,
  radiusMetres: z.number().int().min(MIN_RADIUS_METRES).max(MAX_RADIUS_METRES),
  label: z.string().trim().max(80).optional(),
})

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const g = await guard('service:configure')
  if (!g.ok) return g.response
  const { auth, requestId } = g

  const parsedBody = await parseJson(req)
  if (!parsedBody.ok) {
    return apiError('INVALID_JSON', 'Request body must be JSON.', 400, { requestId })
  }

  // The radius form first: it is the one a browser sends. A body carrying
  // an explicit polygon falls through to the original schema.
  const asRadius = radiusSchema.safeParse(parsedBody.body)
  let input: z.infer<typeof serviceAreaSchema>

  if (asRadius.success) {
    const geocoded = await getGeocoder().geocode({
      line1: asRadius.data.centre.line1,
      ...(asRadius.data.centre.line2 ? { line2: asRadius.data.centre.line2 } : {}),
      city: asRadius.data.centre.city,
      region: asRadius.data.centre.region,
      postalCode: asRadius.data.centre.postalCode,
    })

    if (!geocoded.ok) {
      const message =
        geocoded.code === 'NO_MATCH'
          ? 'We could not find that place. Check the spelling and ZIP.'
          : geocoded.code === 'AMBIGUOUS'
            ? 'That matched more than one place. Add more detail.'
            : 'We could not look that up right now. Please try again.'
      return apiError(
        geocoded.code,
        message,
        geocoded.code === 'PROVIDER_UNAVAILABLE' ? 503 : 422,
        { requestId },
      )
    }

    let polygon: GeoJsonPolygon
    try {
      polygon = circlePolygon({
        latitude: geocoded.latitude,
        longitude: geocoded.longitude,
        radiusMetres: asRadius.data.radiusMetres,
      })
    } catch {
      return apiError('VALIDATION_FAILED', 'That area size is not allowed.', 400, { requestId })
    }

    input = {
      privateGeometry: polygon as unknown as Record<string, unknown>,
      ...(asRadius.data.label ? { label: asRadius.data.label } : {}),
    }
  } else {
    const parsed = serviceAreaSchema.safeParse(parsedBody.body)
    if (!parsed.success) {
      return apiError('VALIDATION_FAILED', 'Check the highlighted fields.', 400, {
        requestId,
        fieldErrors: fieldErrorsFrom(parsed.error.issues),
      })
    }
    input = parsed.data
  }

  const { id } = await ctx.params
  const result = await setServiceArea({
    db: supabaseAdmin(),
    providerUserId: auth.userId,
    providerServiceId: id,
    input,
    now: new Date(),
    ip: clientIp(req),
  })

  if (!result.ok) {
    if (result.code === 'SERVICE_NOT_FOUND') {
      return apiError('NOT_FOUND', 'That service was not found.', 404, { requestId })
    }
    return apiError('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500, { requestId })
  }

  return apiOk({ serviceAreaId: result.serviceAreaId })
}

/**
 * Storing and serving completion photos.
 *
 * ## Who may see one
 *
 * Decided here, in one place, and applied on every fetch. Four parties,
 * and no others:
 *
 *   - the provider who did the work;
 *   - the customer on that subscription;
 *   - the guardian of a minor provider, where the relationship lets them
 *     see operations at all;
 *   - staff handling an incident.
 *
 * Not "anybody with the URL". There are no signed links, because a signed
 * link is authorized once and then works for whoever it is forwarded to,
 * and these are photographs taken outside somebody's house by a child.
 *
 * ## The bytes are sanitised before they are stored, not before they are shown
 *
 * Safety section 13 says EXIF goes before persistent storage. If it were
 * stripped on the way out, the original would still be sitting in a bucket
 * with the coordinates in it, and every backup would have them too.
 */

import { sanitisePhoto } from '@/domain/photo'
import { hasPermission } from '@/domain/roles'
import { isGuardianCleared, type GuardianState } from '@/domain/guardian'
import { writeAudit } from '@/server/audit'
import type { Role } from '@/domain/roles'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type Db = SupabaseClient<Database>

const BUCKET = 'completion-photos'

export type UploadResult =
  | { ok: true; photoId: string; strippedSegments: number }
  | {
      ok: false
      code: 'NOT_FOUND' | 'NOT_YOURS' | 'ALREADY_EXISTS' | 'REJECTED' | 'WRITE_FAILED'
      message: string
    }

export async function uploadCompletionPhoto(args: {
  db: Db
  occurrenceId: string
  providerUserId: string
  bytes: Uint8Array
}): Promise<UploadResult> {
  // Ownership first, before spending any effort on the bytes.
  const { data: occurrence } = await args.db
    .from('service_occurrences')
    .select(
      `id, subscription_id,
       subscriptions!inner (
         id,
         provider_services!inner ( businesses!inner ( provider_user_id ) )
       )`,
    )
    .eq('id', args.occurrenceId)
    .maybeSingle()

  if (!occurrence) return { ok: false, code: 'NOT_FOUND', message: 'No such visit.' }

  const providerUserId = providerOf(occurrence)
  if (providerUserId !== args.providerUserId) {
    return { ok: false, code: 'NOT_YOURS', message: 'That is not your visit.' }
  }

  const sanitised = sanitisePhoto(args.bytes)
  if (!sanitised.ok) return { ok: false, code: 'REJECTED', message: sanitised.message }

  // Opaque. A storage key ends up in logs and support tickets, and one
  // built from an address is a leak every time it is written down.
  const extension = sanitised.kind === 'image/jpeg' ? 'jpg' : 'png'
  const storagePath = `${crypto.randomUUID()}.${extension}`

  const { error: uploadError } = await args.db.storage
    .from(BUCKET)
    .upload(storagePath, sanitised.bytes, {
      contentType: sanitised.kind,
      upsert: false,
    })

  if (uploadError) {
    console.error('[photo] upload failed', uploadError.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'We could not save that photo.' }
  }

  const { data: row, error } = await args.db
    .from('completion_photos')
    .insert({
      occurrence_id: args.occurrenceId,
      subscription_id: occurrence.subscription_id,
      uploaded_by_user_id: args.providerUserId,
      storage_path: storagePath,
      content_type: sanitised.kind,
      byte_size: sanitised.bytes.length,
      stripped_segments: sanitised.strippedSegments,
    })
    .select('id')
    .single()

  if (error || !row) {
    // The object is stored and the row is not. Remove it rather than leave
    // an orphan nobody can reach or account for.
    await args.db.storage.from(BUCKET).remove([storagePath])
    if (error?.code === '23505') {
      return { ok: false, code: 'ALREADY_EXISTS', message: 'There is already a photo for this visit.' }
    }
    console.error('[photo] row write failed', error?.message)
    return { ok: false, code: 'WRITE_FAILED', message: 'We could not save that photo.' }
  }

  return { ok: true, photoId: row.id, strippedSegments: sanitised.strippedSegments }
}

export type FetchResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_ALLOWED'; message: string }

/**
 * Serves a photo, to somebody entitled to it.
 *
 * A caller who is not entitled gets NOT_FOUND rather than a refusal. The
 * existence of a photo for a particular visit is itself information, and
 * "you may not see this" confirms there is something there.
 */
export async function fetchCompletionPhoto(args: {
  db: Db
  photoId: string
  viewerUserId: string
  viewerRoles: readonly Role[]
}): Promise<FetchResult> {
  const { data: photo } = await args.db
    .from('completion_photos')
    .select(
      `id, storage_path, content_type, subscription_id,
       subscriptions!inner (
         customer_user_id,
         provider_services!inner ( businesses!inner ( provider_user_id ) )
       )`,
    )
    .eq('id', args.photoId)
    .maybeSingle()

  if (!photo) return { ok: false, code: 'NOT_FOUND', message: 'Not found.' }

  const subscription = one<{ customer_user_id: string; provider_services: unknown }>(
    photo.subscriptions,
  )
  const providerUserId = providerOf(photo)

  const allowed =
    subscription?.customer_user_id === args.viewerUserId ||
    providerUserId === args.viewerUserId ||
    hasPermission(args.viewerRoles, 'incident:manage') ||
    (await isGuardianOf(args.db, args.viewerUserId, providerUserId))

  if (!allowed) {
    // Same answer as a photo that does not exist.
    return { ok: false, code: 'NOT_FOUND', message: 'Not found.' }
  }

  const { data: blob, error } = await args.db.storage.from(BUCKET).download(photo.storage_path)
  if (error || !blob) {
    console.error('[photo] download failed', error?.message)
    return { ok: false, code: 'NOT_FOUND', message: 'Not found.' }
  }

  // Staff access to somebody's photo is worth a row. The parties to the
  // job are not audited for looking at their own visit.
  if (
    hasPermission(args.viewerRoles, 'incident:manage') &&
    subscription?.customer_user_id !== args.viewerUserId &&
    providerUserId !== args.viewerUserId
  ) {
    await writeAudit({
      actorUserId: args.viewerUserId,
      actorRole: 'trust_safety_agent',
      action: 'photo.viewed_by_staff',
      targetType: 'completion_photo',
      targetId: args.photoId,
      after: { subscription_id: photo.subscription_id },
    })
  }

  return {
    ok: true,
    bytes: new Uint8Array(await blob.arrayBuffer()),
    contentType: photo.content_type,
  }
}

async function isGuardianOf(
  db: Db,
  viewerUserId: string,
  providerUserId: string | null,
): Promise<boolean> {
  if (!providerUserId) return false

  const { data: rel } = await db
    .from('guardian_relationships')
    .select('state')
    .eq('guardian_user_id', viewerUserId)
    .eq('provider_user_id', providerUserId)
    .maybeSingle()

  // The same clearance that governs the rest of the guardian's view. A
  // guardian who has not been verified sees that work exists, not the
  // photographs taken at somebody's front door.
  return Boolean(rel && isGuardianCleared(rel.state as GuardianState))
}

function one<T>(value: unknown): T | undefined {
  return (Array.isArray(value) ? value[0] : value) as T | undefined
}

function providerOf(row: unknown): string | null {
  const sub = one<{ provider_services: unknown }>((row as { subscriptions?: unknown }).subscriptions)
  const service = one<{ businesses: unknown }>(sub?.provider_services)
  const business = one<{ provider_user_id: string }>(service?.businesses)
  return business?.provider_user_id ?? null
}

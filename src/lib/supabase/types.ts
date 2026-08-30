/**
 * Database types for the tables created in migrations/0001.
 *
 * Hand-written so the client is type-safe before a Supabase project exists.
 * Once one does, `supabase gen types typescript` can replace this file
 * wholesale -- keep the shape identical so the swap is a delete-and-paste.
 */

export type UserRole =
  | 'provider'
  | 'guardian'
  | 'customer'
  | 'support_agent'
  | 'trust_safety_agent'
  | 'finance_admin'
  | 'platform_admin'

export type WaitlistRoleEnum = 'provider' | 'customer' | 'guardian'

export type ReviewStateEnum = 'published' | 'hidden' | 'removed'

export type ReferralStateEnum = 'pending' | 'qualified' | 'paid' | 'void'

export type AccountActionKindEnum = 'strike' | 'suspend' | 'ban' | 'reinstate'

export type ConsentKindEnum =
  | 'guardian_consent'
  | 'public_listing_consent'
  | 'customer_attestation'

export type MessageStateEnum = 'delivered' | 'blocked' | 'redacted'

export type IncidentStateEnum = 'open' | 'investigating' | 'resolved' | 'closed'
export type IncidentSeverityEnum = 'S0' | 'S1' | 'S2' | 'S3'

export type NotificationChannelEnum = 'email' | 'sms' | 'push'

export type NotificationStateEnum =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'dead'
  | 'suppressed'

export type SubscriptionStateEnum =
  | 'pending'
  | 'active'
  | 'paused'
  | 'payment_failed'
  | 'canceled'
  | 'ended'

export type OccurrenceStateEnum =
  | 'scheduled'
  | 'due_today'
  | 'started'
  | 'completed'
  | 'settled'
  | 'provider_skipped'
  | 'customer_skipped'
  | 'issue_reported'
  | 'credited'
  | 'canceled'

export type LedgerKindEnum =
  | 'customer_charge'
  | 'platform_fee'
  | 'provider_earning'
  | 'credit'
  | 'refund'
  | 'dispute'
  | 'payout'
  | 'adjustment'

export type BusinessStateEnum =
  | 'draft'
  | 'pending'
  | 'published'
  | 'paused_guardian'
  | 'paused_admin'
  | 'suspended'
  | 'closed'

export type GuardianStateEnum =
  | 'not_required'
  | 'required_uninvited'
  | 'invited'
  | 'guardian_started'
  | 'verified'
  | 'revoked'
  | 'expired'
  | 'manual_review'

type Timestamps = { created_at: string; updated_at: string }

export type Database = {
  public: {
    Tables: {
      /** Migration 0040. Server-owned state and per-service restrictions. */
      jurisdiction_rules: {
        Row: {
          id: string
          region: string
          status: string
          catalog_code: string | null
          reason: string
          created_by_user_id: string | null
          created_at: string
          lifted_at: string | null
          lifted_by_user_id: string | null
          lift_reason: string | null
        }
        Insert: {
          id?: string
          region: string
          status: string
          catalog_code?: string | null
          reason: string
          created_by_user_id?: string | null
          created_at?: string
          lifted_at?: string | null
          lifted_by_user_id?: string | null
          lift_reason?: string | null
        }
        Update: Partial<Database['public']['Tables']['jurisdiction_rules']['Insert']>
        Relationships: []
      }
      /** Migration 0040. Configuration changeable without a deploy. */
      platform_settings: {
        Row: {
          key: string
          value: string
          description: string
          updated_at: string
          updated_by_user_id: string | null
        }
        Insert: {
          key: string
          value: string
          description: string
          updated_at?: string
          updated_by_user_id?: string | null
        }
        Update: Partial<Database['public']['Tables']['platform_settings']['Insert']>
        Relationships: []
      }
      users: {
        Row: {
          id: string
          email: string | null
          phone_e164: string | null
          email_verified_at: string | null
          phone_verified_at: string | null
          status: string
          // Added in migration 0002. Links the domain user to the auth
          // provider's user without making auth the owner of our id space.
          auth_user_id: string | null
          // Added in migration 0004. The connected account belongs to the
          // adult who legally holds it, not to the provider.
          stripe_connected_account_id: string | null
          stripe_transfers_active: boolean
          stripe_payouts_active: boolean
          stripe_requirements_due: string[]
          stripe_synced_at: string | null
          // Added in migration 0035. Closure is the request,
          // de-identification is the work, and they are separate columns so
          // a half-finished closure is visible to the next sweep.
          closed_at: string | null
          deletion_requested_at: string | null
          de_identified_at: string | null
        } & Timestamps
        Insert: {
          id?: string
          email?: string | null
          phone_e164?: string | null
          email_verified_at?: string | null
          phone_verified_at?: string | null
          status?: string
          auth_user_id?: string | null
          stripe_connected_account_id?: string | null
          stripe_transfers_active?: boolean
          stripe_payouts_active?: boolean
          stripe_requirements_due?: string[]
          stripe_synced_at?: string | null
          closed_at?: string | null
          deletion_requested_at?: string | null
          de_identified_at?: string | null
        }
        Update: Partial<Database['public']['Tables']['users']['Insert']>
        Relationships: []
      }
      user_roles: {
        Row: { user_id: string; role: UserRole; granted_at: string; granted_by: string | null }
        Insert: { user_id: string; role: UserRole; granted_at?: string; granted_by?: string | null }
        Update: Partial<Database['public']['Tables']['user_roles']['Insert']>
        Relationships: []
      }
      provider_profiles: {
        Row: {
          user_id: string
          date_of_birth: string
          country_code: string
          display_first_name: string
          guardian_state: GuardianStateEnum
          // 0004 removed stripe_connected_account_id and payout_ready.
          // Readiness is derived from the holder's Stripe state instead of
          // stored, so there is one answer and it is the true one.
          payout_account_user_id: string | null
          private_home_address_id: string | null
        } & Timestamps
        Insert: {
          user_id: string
          date_of_birth: string
          country_code?: string
          display_first_name: string
          guardian_state: GuardianStateEnum
          payout_account_user_id?: string | null
          private_home_address_id?: string | null
        }
        Update: Partial<Database['public']['Tables']['provider_profiles']['Insert']>
        Relationships: []
      }
      guardian_profiles: {
        Row: {
          user_id: string
          stripe_person_or_rep_id: string | null
          identity_state: string
          created_at: string
        }
        Insert: {
          user_id: string
          stripe_person_or_rep_id?: string | null
          identity_state?: string
        }
        Update: Partial<Database['public']['Tables']['guardian_profiles']['Insert']>
        Relationships: []
      }
      guardian_relationships: {
        Row: {
          id: string
          provider_user_id: string
          guardian_user_id: string | null
          invitation_email: string | null
          invitation_phone: string | null
          invitation_token_hash: string | null
          invitation_expires_at: string | null
          state: GuardianStateEnum
          consented_at: string | null
          revoked_at: string | null
        } & Timestamps
        Insert: {
          id?: string
          provider_user_id: string
          guardian_user_id?: string | null
          invitation_email?: string | null
          invitation_phone?: string | null
          invitation_token_hash?: string | null
          invitation_expires_at?: string | null
          state: GuardianStateEnum
          consented_at?: string | null
          revoked_at?: string | null
        }
        Update: Partial<Database['public']['Tables']['guardian_relationships']['Insert']>
        Relationships: []
      }
      service_catalog: {
        Row: {
          id: string
          code: string
          name: string
          description: string
          risk_tier: 'A' | 'B' | 'C' | 'X'
          min_provider_age: number
          guardian_explicit_approval: boolean
          active: boolean
          configuration: Record<string, unknown>
        } & Timestamps
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      businesses: {
        Row: {
          id: string
          provider_user_id: string
          name: string
          slug: string
          tagline: string | null
          about: string | null
          avatar_asset_id: string | null
          state: BusinessStateEnum
          public_area_label: string | null
          public_trust_badge: string | null
          public_listing_consent_id: string | null
          searchable: boolean
          published_at: string | null
        } & Timestamps
        Insert: {
          id?: string
          provider_user_id: string
          name: string
          slug: string
          tagline?: string | null
          about?: string | null
          avatar_asset_id?: string | null
          state?: BusinessStateEnum
          public_area_label?: string | null
          public_trust_badge?: string | null
          public_listing_consent_id?: string | null
          searchable?: boolean
          published_at?: string | null
        }
        Update: Partial<Database['public']['Tables']['businesses']['Insert']>
        Relationships: []
      }
      provider_services: {
        Row: {
          id: string
          business_id: string
          catalog_service_id: string
          slug: string
          public_name: string
          description: string
          price_cents: number
          currency: string
          price_unit: 'week' | 'visit' | 'month'
          billing_cycle_weeks: number
          schedule_rule: Record<string, unknown>
          capacity_rule: Record<string, unknown>
          provider_limits: Record<string, unknown>
          state: 'draft' | 'active' | 'paused'
        } & Timestamps
        Insert: {
          id?: string
          business_id: string
          catalog_service_id: string
          slug: string
          public_name: string
          description: string
          price_cents: number
          currency?: string
          price_unit: 'week' | 'visit' | 'month'
          billing_cycle_weeks?: number
          schedule_rule: Record<string, unknown>
          capacity_rule: Record<string, unknown>
          provider_limits?: Record<string, unknown>
          state?: 'draft' | 'active' | 'paused'
        }
        Update: Partial<Database['public']['Tables']['provider_services']['Insert']>
        Relationships: []
      }
      service_areas: {
        Row: {
          id: string
          provider_service_id: string
          private_geometry: Record<string, unknown>
          public_generalized_geometry: Record<string, unknown> | null
          label: string | null
        } & Timestamps
        Insert: {
          id?: string
          provider_service_id: string
          private_geometry: Record<string, unknown>
          public_generalized_geometry?: Record<string, unknown> | null
          label?: string | null
        }
        Update: Partial<Database['public']['Tables']['service_areas']['Insert']>
        Relationships: []
      }
      guardian_service_approvals: {
        Row: {
          id: string
          relationship_id: string
          catalog_code: string
          approved_at: string
          revoked_at: string | null
          approved_by_user_id: string
        }
        Insert: {
          id?: string
          relationship_id: string
          catalog_code: string
          revoked_at?: string | null
          approved_by_user_id: string
        }
        Update: Partial<Database['public']['Tables']['guardian_service_approvals']['Insert']>
        Relationships: []
      }
      customer_addresses: {
        Row: {
          id: string
          customer_user_id: string
          line1: string
          line2: string | null
          city: string
          region: string
          postal_code: string
          country_code: string
          normalized_address: string | null
          geocoded_at: string | null
          geocoder: string | null
          access_notes: string | null
          /**
           * geography(Point, 4326). Readable over PostgREST as hex WKB,
           * but NOT writable through it -- setting it needs
           * set_customer_address_point (0018) and clearing it needs
           * redact_customer_addresses (0037). Absent from Insert for
           * exactly that reason.
           */
          point: string | null
        } & Timestamps
        Insert: {
          id?: string
          customer_user_id: string
          line1: string
          line2?: string | null
          city: string
          region: string
          postal_code: string
          country_code?: string
          normalized_address?: string | null
          geocoded_at?: string | null
          geocoder?: string | null
          access_notes?: string | null
          /** Accepted by Postgres; needed to backdate rows in retention tests. */
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['customer_addresses']['Insert']>
        Relationships: []
      }
      subscriptions: {
        Row: {
          id: string
          customer_user_id: string
          provider_service_id: string
          service_address_id: string
          state: SubscriptionStateEnum
          provider_price_cents: number
          price_unit: 'week' | 'visit' | 'month'
          platform_fee_bps: number
          platform_fee_min_cents: number
          billing_cycle_weeks: number
          current_cycle_start: string | null
          current_cycle_end: string | null
          next_charge_at: string | null
          stripe_customer_id: string | null
          stripe_payment_method_id: string | null
          customer_instructions: string | null
          service_details: Record<string, unknown>
          started_at: string | null
          canceled_at: string | null
        } & Timestamps
        Insert: {
          id?: string
          customer_user_id: string
          provider_service_id: string
          service_address_id: string
          state?: SubscriptionStateEnum
          provider_price_cents: number
          price_unit: 'week' | 'visit' | 'month'
          platform_fee_bps: number
          platform_fee_min_cents: number
          billing_cycle_weeks?: number
          current_cycle_start?: string | null
          current_cycle_end?: string | null
          next_charge_at?: string | null
          stripe_customer_id?: string | null
          stripe_payment_method_id?: string | null
          customer_instructions?: string | null
          service_details?: Record<string, unknown>
          started_at?: string | null
          canceled_at?: string | null
        }
        Update: Partial<Database['public']['Tables']['subscriptions']['Insert']>
        Relationships: []
      }
      service_occurrences: {
        Row: {
          id: string
          subscription_id: string
          service_date: string
          local_timezone: string
          service_window_start: string | null
          service_window_end: string | null
          state: OccurrenceStateEnum
          route_order: number | null
          service_value_cents: number
          completion_note: string | null
          completed_at: string | null
        } & Timestamps
        Insert: {
          id?: string
          subscription_id: string
          service_date: string
          local_timezone: string
          service_window_start?: string | null
          service_window_end?: string | null
          state?: OccurrenceStateEnum
          route_order?: number | null
          service_value_cents: number
          completion_note?: string | null
          completed_at?: string | null
        }
        Update: Partial<Database['public']['Tables']['service_occurrences']['Insert']>
        Relationships: []
      }
      ledger_entries: {
        Row: {
          id: string
          kind: LedgerKindEnum
          amount_cents: number
          currency: string
          customer_user_id: string | null
          provider_user_id: string | null
          subscription_id: string | null
          occurrence_id: string | null
          external_processor: string | null
          external_id: string | null
          idempotency_key: string | null
          memo: string | null
          created_at: string
        }
        Insert: {
          id?: string
          kind: LedgerKindEnum
          amount_cents: number
          currency?: string
          customer_user_id?: string | null
          provider_user_id?: string | null
          subscription_id?: string | null
          occurrence_id?: string | null
          external_processor?: string | null
          external_id?: string | null
          idempotency_key?: string | null
          memo?: string | null
        }
        Update: Partial<Database['public']['Tables']['ledger_entries']['Insert']>
        Relationships: []
      }
      stripe_events: {
        Row: {
          id: string
          type: string
          account_id: string | null
          api_version: string | null
          received_at: string
          processed_at: string | null
          payload: unknown
          error: string | null
        }
        Insert: {
          id: string
          type: string
          account_id?: string | null
          api_version?: string | null
          processed_at?: string | null
          payload: unknown
          error?: string | null
        }
        Update: Partial<Database['public']['Tables']['stripe_events']['Insert']>
        Relationships: []
      }
      audit_log: {
        Row: {
          id: number
          actor_user_id: string | null
          actor_role: string | null
          action: string
          target_type: string
          target_id: string
          before_json: unknown | null
          after_json: unknown | null
          reason_code: string | null
          ip_hash: string | null
          created_at: string
        }
        Insert: {
          actor_user_id?: string | null
          actor_role?: string | null
          action: string
          target_type: string
          target_id: string
          before_json?: unknown | null
          after_json?: unknown | null
          reason_code?: string | null
          ip_hash?: string | null
        }
        Update: Partial<Database['public']['Tables']['audit_log']['Insert']>
        Relationships: []
      }
      incidents: {
        Row: {
          id: string
          severity: IncidentSeverityEnum
          state: IncidentStateEnum
          category: string
          reporter_user_id: string | null
          business_id: string | null
          subscription_id: string | null
          occurrence_id: string | null
          provider_user_id: string | null
          narrative: string
          involves_minor: boolean
          respond_by: string
          first_viewed_at: string | null
          resolution: string | null
          resolved_at: string | null
          resolved_by_user_id: string | null
        } & Timestamps
        Insert: {
          id?: string
          severity: IncidentSeverityEnum
          state?: IncidentStateEnum
          category: string
          reporter_user_id?: string | null
          business_id?: string | null
          subscription_id?: string | null
          occurrence_id?: string | null
          provider_user_id?: string | null
          narrative: string
          involves_minor?: boolean
          respond_by: string
          first_viewed_at?: string | null
          resolution?: string | null
          resolved_at?: string | null
          resolved_by_user_id?: string | null
        }
        Update: Partial<Database['public']['Tables']['incidents']['Insert']>
        Relationships: []
      }
      payout_holds: {
        Row: {
          id: string
          provider_user_id: string
          incident_id: string | null
          reason: string
          placed_by_user_id: string
          placed_at: string
          released_at: string | null
          released_by_user_id: string | null
          release_reason: string | null
        }
        Insert: {
          id?: string
          provider_user_id: string
          incident_id?: string | null
          reason: string
          placed_by_user_id: string
          released_at?: string | null
          released_by_user_id?: string | null
          release_reason?: string | null
        }
        Update: Partial<Database['public']['Tables']['payout_holds']['Insert']>
        Relationships: []
      }
      message_threads: {
        Row: {
          id: string
          subscription_id: string
          customer_user_id: string
          provider_user_id: string
          involves_minor: boolean
          last_message_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          subscription_id: string
          customer_user_id: string
          provider_user_id: string
          involves_minor?: boolean
          last_message_at?: string | null
        }
        Update: Partial<Database['public']['Tables']['message_threads']['Insert']>
        Relationships: []
      }
      messages: {
        Row: {
          id: string
          thread_id: string
          sender_user_id: string
          body: string
          state: MessageStateEnum
          violation_code: string | null
          urgent: boolean
          reported_at: string | null
          reported_by_user_id: string | null
          report_reason: string | null
          read_at: string | null
          purge_after: string
          created_at: string
        }
        Insert: {
          id?: string
          thread_id: string
          sender_user_id: string
          body: string
          state?: MessageStateEnum
          violation_code?: string | null
          urgent?: boolean
          reported_at?: string | null
          reported_by_user_id?: string | null
          report_reason?: string | null
          read_at?: string | null
          purge_after: string
        }
        Update: Partial<Database['public']['Tables']['messages']['Insert']>
        Relationships: []
      }
      referral_codes: {
        Row: {
          code: string
          provider_user_id: string
          revoked_at: string | null
          created_at: string
        }
        Insert: {
          code: string
          provider_user_id: string
          revoked_at?: string | null
        }
        Update: Partial<Database['public']['Tables']['referral_codes']['Insert']>
        Relationships: []
      }
      account_actions: {
        Row: {
          id: string
          subject_user_id: string
          kind: AccountActionKindEnum
          reason: string
          incident_id: string | null
          actor_user_id: string
          actor_role: string | null
          created_at: string
        }
        Insert: {
          id?: string
          subject_user_id: string
          kind: AccountActionKindEnum
          reason: string
          incident_id?: string | null
          actor_user_id: string
          actor_role?: string | null
        }
        Update: Partial<Database['public']['Tables']['account_actions']['Insert']>
        Relationships: []
      }
      completion_photos: {
        Row: {
          id: string
          occurrence_id: string
          subscription_id: string
          uploaded_by_user_id: string
          storage_path: string
          content_type: string
          byte_size: number
          stripped_segments: number
          created_at: string
        }
        Insert: {
          id?: string
          occurrence_id: string
          subscription_id: string
          uploaded_by_user_id: string
          storage_path: string
          content_type: string
          byte_size: number
          stripped_segments?: number
        }
        Update: Partial<Database['public']['Tables']['completion_photos']['Insert']>
        Relationships: []
      }
      consent_records: {
        Row: {
          id: string
          kind: ConsentKindEnum
          signer_user_id: string
          subject_user_id: string | null
          subscription_id: string | null
          document_version: string
          document_hash: string
          document_text: string
          acknowledged_items: string[]
          typed_name: string
          verification_method: string
          ip_hash: string | null
          user_agent: string | null
          signed_at: string
          revokes_id: string | null
          revocation_reason: string | null
        }
        Insert: {
          id?: string
          kind: ConsentKindEnum
          signer_user_id: string
          subject_user_id?: string | null
          subscription_id?: string | null
          document_version: string
          document_hash: string
          document_text: string
          acknowledged_items: string[]
          typed_name: string
          verification_method: string
          ip_hash?: string | null
          user_agent?: string | null
          revokes_id?: string | null
          revocation_reason?: string | null
        }
        Update: Partial<Database['public']['Tables']['consent_records']['Insert']>
        Relationships: []
      }
      referrals: {
        Row: {
          id: string
          subscription_id: string
          code: string
          provider_user_id: string
          customer_user_id: string
          state: ReferralStateEnum
          customer_discount_bps: number
          provider_bonus_cents: number
          discount_applied_cents: number | null
          discount_applied_at: string | null
          qualified_at: string | null
          paid_at: string | null
          voided_at: string | null
          void_reason: string | null
          created_at: string
        }
        Insert: {
          id?: string
          subscription_id: string
          code: string
          provider_user_id: string
          customer_user_id: string
          state?: ReferralStateEnum
          customer_discount_bps: number
          provider_bonus_cents: number
          discount_applied_cents?: number | null
          discount_applied_at?: string | null
          qualified_at?: string | null
          paid_at?: string | null
          voided_at?: string | null
          void_reason?: string | null
        }
        Update: Partial<Database['public']['Tables']['referrals']['Insert']>
        Relationships: []
      }
      reviews: {
        Row: {
          id: string
          occurrence_id: string
          subscription_id: string
          provider_service_id: string
          provider_user_id: string
          customer_user_id: string
          rating: number
          body: string | null
          response_body: string | null
          responded_at: string | null
          state: ReviewStateEnum
          cycle_start: string | null
        } & Timestamps
        Insert: {
          id?: string
          occurrence_id: string
          subscription_id: string
          provider_service_id: string
          provider_user_id: string
          customer_user_id: string
          rating: number
          body?: string | null
          response_body?: string | null
          responded_at?: string | null
          state?: ReviewStateEnum
          cycle_start?: string | null
        }
        Update: Partial<Database['public']['Tables']['reviews']['Insert']>
        Relationships: []
      }
      review_reports: {
        Row: {
          id: string
          review_id: string
          reporter_user_id: string
          reason: string
          detail: string | null
          resolved_at: string | null
          resolution: string | null
          created_at: string
        }
        Insert: {
          id?: string
          review_id: string
          reporter_user_id: string
          reason: string
          detail?: string | null
          resolved_at?: string | null
          resolution?: string | null
        }
        Update: Partial<Database['public']['Tables']['review_reports']['Insert']>
        Relationships: []
      }
      notifications: {
        Row: {
          id: string
          kind: string
          channel: NotificationChannelEnum
          state: NotificationStateEnum
          recipient_user_id: string | null
          destination: string
          subject: string | null
          preview: string | null
          payload: Record<string, unknown>
          idempotency_key: string | null
          attempts: number
          last_error: string | null
          next_attempt_at: string
          sent_at: string | null
        } & Timestamps
        Insert: {
          id?: string
          kind: string
          channel: NotificationChannelEnum
          state?: NotificationStateEnum
          recipient_user_id?: string | null
          destination: string
          subject?: string | null
          preview?: string | null
          payload?: Record<string, unknown>
          idempotency_key?: string | null
          attempts?: number
          last_error?: string | null
          next_attempt_at?: string
          sent_at?: string | null
          /** Accepted by Postgres; needed to backdate rows in retention tests. */
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['notifications']['Insert']>
        Relationships: []
      }
      waitlist_signups: {
        Row: {
          id: string
          email: string
          role: WaitlistRoleEnum
          postal_code: string | null
          created_at: string
        }
        Insert: {
          email: string
          role: WaitlistRoleEnum
          postal_code?: string | null
        }
        Update: Partial<Database['public']['Tables']['waitlist_signups']['Insert']>
        Relationships: []
      }
    }
    Views: {
      /**
       * Migration 0035. When an address stopped being needed --
       * NULL while any live subscription still uses it.
       *
       * A view rather than a stored column so no write path that changes a
       * subscription's state can forget to maintain it. Forgetting once
       * would keep a home address indefinitely, silently.
       */
      /**
       * Migration 0039. Last sign of real activity per account, for the
       * dormancy sweep that gives account_identity a terminal date.
       *
       * Excludes notifications the platform sent: mail leaving is the
       * platform being active, not the person.
       */
      account_retention_clock: {
        Row: {
          user_id: string
          status: string
          closed_at: string | null
          de_identified_at: string | null
          last_active_at: string
          has_live_subscription: boolean
        }
        Relationships: []
      }
      address_retention_clock: {
        Row: {
          address_id: string
          customer_user_id: string
          clock_starts_at: string | null
        }
        Relationships: []
      }
    }
    Functions: Record<never, never>
    Enums: { user_role: UserRole; guardian_state: GuardianStateEnum }
    CompositeTypes: Record<never, never>
  }
}

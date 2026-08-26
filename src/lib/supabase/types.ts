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
    Views: Record<never, never>
    Functions: Record<never, never>
    Enums: { user_role: UserRole; guardian_state: GuardianStateEnum }
    CompositeTypes: Record<never, never>
  }
}

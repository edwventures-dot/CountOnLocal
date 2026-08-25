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
        } & Timestamps
        Insert: {
          id?: string
          email?: string | null
          phone_e164?: string | null
          email_verified_at?: string | null
          phone_verified_at?: string | null
          status?: string
          auth_user_id?: string | null
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
          stripe_connected_account_id: string | null
          payout_ready: boolean
          private_home_address_id: string | null
        } & Timestamps
        Insert: {
          user_id: string
          date_of_birth: string
          country_code?: string
          display_first_name: string
          guardian_state: GuardianStateEnum
          stripe_connected_account_id?: string | null
          payout_ready?: boolean
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
    }
    Views: Record<never, never>
    Functions: Record<never, never>
    Enums: { user_role: UserRole; guardian_state: GuardianStateEnum }
    CompositeTypes: Record<never, never>
  }
}

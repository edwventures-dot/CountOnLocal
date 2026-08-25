/**
 * The error envelope from API_CONTRACT.
 *
 * Every customer-facing error carries a request id so support can find the
 * trace without the message itself leaking anything -- TECHNICAL_SPEC
 * section 21.
 */

export type ApiErrorBody = {
  error: {
    code: string
    message: string
    requestId: string
    fieldErrors: Record<string, string>
  }
}

export function newRequestId(): string {
  return 'req_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)
}

export function apiError(
  code: string,
  message: string,
  status: number,
  opts: { requestId?: string; fieldErrors?: Record<string, string> } = {},
): Response {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      requestId: opts.requestId ?? newRequestId(),
      fieldErrors: opts.fieldErrors ?? {},
    },
  }
  return Response.json(body, { status })
}

export function apiOk(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

/**
 * Messages that may be returned to a caller. Denial codes from the domain
 * gates are mapped here so no internal detail reaches the client -- and so
 * the under-13 refusal stays neutral, per QA_ACCEPTANCE section 2.
 */
export const DENIAL_RESPONSES: Record<string, { status: number; message: string }> = {
  PROVIDER_INELIGIBLE: {
    status: 403,
    // Deliberately says nothing about age or what would have qualified.
    message: 'This account is not eligible to provide services.',
  },
  GUARDIAN_APPROVAL_REQUIRED: {
    status: 403,
    message: 'Guardian approval is required to continue.',
  },
  GUARDIAN_STATE_INCONSISTENT: {
    status: 409,
    message: 'This account needs review before continuing. Please contact support.',
  },
  NOT_A_PROVIDER: {
    status: 403,
    message: 'This account cannot perform that action.',
  },
}

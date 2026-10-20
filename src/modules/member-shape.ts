/** The Member shape the admin's rules use (admin/src/lib/members/members.ts), loaded from app.members + payments. */
import type { Member } from '@/lib/members/members';

export type MemberRow = Record<string, unknown> & { record: Record<string, unknown>; payments: Member['payments'] };
/** centerOverride: placed by hand (the masjid is in m.center) · notes: imported notes + notes written since (app.member_notes) */
export function toMember(r: MemberRow): Member {
  return {
    ...(r.record as object), id: String(r.id), first: String(r.first_name), last: String(r.last_name), email: String(r.email), phone: String(r.phone), dob: String(r.dob ?? '1900-01-01'),
    street: String(r.street), city: String(r.city), state: String(r.state ?? ''), zip: String(r.zip), zone: r.zone as Member['zone'], center: String(r.center), plan: r.plan as Member['plan'], joined: Number(r.joined_year),
    appliedOn: String(r.applied_on), approvedOn: (r.approved_on as string | null) ?? null, idCheck: r.id_check as Member['idCheck'], standing: r.standing as Member['standing'],
    spouseId: (r.spouse_id as string | null) || undefined, commitment: r.commitment as Member['commitment'], source: r.source === 'import' ? 'import' : undefined,
    archived: (r.archived as Member['archived']) ?? undefined, centerOverride: r.center_override ? { center: String(r.center), reason: String((r.center_override as { reason?: string }).reason ?? ''), lockedUntil: (r.center_override as { lockedUntil?: string }).lockedUntil } : undefined, extra: (r.extra as Member['extra']) ?? {}, prefs: (r.prefs as Member['prefs']) ?? undefined,
    paidThrough: r.paid_through == null ? null : String(r.paid_through).slice(0, 10), termStatus: r.status == null ? undefined : String(r.status),   // from the membership terms (imported members have terms, not payments)
    payments: r.payments ?? [], notes: [...((r.record as { notes?: Member['notes'] }).notes ?? []), ...((r.notes_list as Member['notes']) ?? [])], audit: ((r.record as { audit?: Member['audit'] }).audit ?? []),
  } as Member;
}
/** payments = dues that were actually received (paid / partly refunded). A check that is promised, a failed card or a
 * refund is not a payment: counting it made unpaid applicants look paid (dashboard dues, renewals, voting checks). */
export const MEMBER_SQL = `SELECT m.*, coalesce((SELECT json_agg(json_build_object('year', p.year, 'paidOn', p.paid_on, 'amountCents', p.amount_cents, 'method', p.method, 'payer', p.payer, 'ref', p.ref) ORDER BY p.paid_on) FROM app.payments p WHERE p.org_id = m.org_id AND p.member_id = m.id AND p.kind = 'dues' AND p.status IN ('paid', 'partially_refunded')), '[]'::json) AS payments,
  coalesce((SELECT json_agg(json_build_object('at', n.at, 'by', n.by, 'text', n.text) ORDER BY n.at) FROM app.member_notes n WHERE n.org_id = m.org_id AND n.member_id = m.id), '[]'::json) AS notes_list FROM app.members m`;

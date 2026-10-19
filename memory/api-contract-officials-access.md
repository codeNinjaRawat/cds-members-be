# API contract – Officials ↔ access – 2026-10-16
Shapes: web/src/lib/community/officials-access.ts and access.ts (Assignment.holderId, reviewedOn).
- Source of truth: `officials` (Elected officials). Access assignments may carry `holderId` = the seat they come from.
- `GET /admin/access/reconcile?center=` – the BE runs reconcile(): give (serving, no linked access), change (linked
  access scope ≠ seat), remove (linked access but the seat is vacant / ended / term over), review (seat roles without
  a seat; skipped for a year after `reviewedOn`). Suspended accounts are ignored.
- Jobs: daily – when a term ends or a seat becomes vacant, notify admins.manage holders (do not auto-remove without a
  person deciding; log every give / change / remove / keep in the audit log, area access).
- Giving access from a seat pre-fills name and the office email (publicEmail); invitations go to that email.
- roleForSeat mapping: officers → president / vice-president / general-secretary / treasurer; zonal-director →
  zone-director (zone); associate-director → associate-director (center); secretary membership / finance / education →
  same-named roles (center); area-rep → area-representative (center + ZIPs; at-large = all service-area ZIPs);
  administrative and youth secretaries → none.
- Menu: ORG_ONLY pages (organization rules) are hidden for center- and zone-scoped roles; the BE still allows read.

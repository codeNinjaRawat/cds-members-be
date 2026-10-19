# API contract – F9 Events extras – 2026-10-16
Shapes: web/src/lib/community/events.ts (approval, promotion, EventsSchema.approval) and event-ops.ts.
- `GET/PUT /admin/events` – events carry `approval {state none|pending|approved|changes, requestedBy, by, on, note}`
  and `promotion {featured, email {audience, sendOn, sent}, sms {enabled, sendOn}, social}`; the document has
  `approval {required, leadDays}`.
- `POST /admin/events/{id}/send-for-approval` (center-scoped events.manage, own masjid only).
- `POST /admin/events/{id}/approve` and `/changes {note}` – events.manage, not center- or zone-scoped. Approve publishes.
  BE must refuse publishing an event by a center-scoped admin while approval.required.
- Clash checks run on the BE too before approve/publish: same place overlap, Friday Jumu'ah of that masjid
  (30 min before to 75 min after the khutbah), special prayers / Eid of that masjid or all masjids.
- Promotion jobs: announcement email on sendOn to the audience (respect email preferences), SMS only to members who
  allowed texts (quiet hours), never after the event start. `GET /public/events` returns featured; never email audience.
- `GET /admin/events/stats?from&to&center&category` – registered, attended (check-in), capacity, revenue per past event;
  center-scoped admins get only their masjid.

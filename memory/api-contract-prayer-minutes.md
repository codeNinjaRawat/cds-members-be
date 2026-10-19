# API contract – F6 Prayer times and Meeting minutes (demo built 2026-10-16)

## Prayer times – `web/src/lib/community/prayer.ts`
- Document `prayer-times` – GET/PUT /admin/prayer-times. Publish: center.content. The BE must also check per field:
  method, asr, location, adjust, hijriAdjust and website need settings.manage; a center row may only be changed by
  admins whose scope includes that center.
- GET /public/prayer-times → the document (no private data) + GET /public/centers for Jumu'ah. The website computes
  the day with `dayTimes()`; the BE can precompute months for the mobile app with the same function.
- Calculation verified against ISGH's September 2025 sheet (161/180 exact, max 1 minute).

## Meetings – `web/src/lib/community/minutes.ts`
- Table `meetings` (RLS by organization). GET /admin/meetings?body=&center=&status=; POST /admin/meetings;
  PATCH /admin/meetings/{id}. Council meetings: center.content within scope; other bodies: settings.manage.
  Server runs MeetingSchema, noticeProblem, quorum and decisionResult; audits (area minutes).
- Status flow draft → approved (approvedOn) → published (audience leaders | members | public).
- GET /member/minutes → `memberMinutes(list)` (published, audience members/public; no attendance list).
- GET /public/minutes → `memberMinutes(list, true)` (public only).
- Calendar check: `calendarWarnings(list, centers, year, today)` for the dashboard and a monthly reminder email.

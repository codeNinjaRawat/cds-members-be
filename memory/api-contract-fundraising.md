# API contract – F8 Fundraising (demo built 2026-10-16)

Rules: `web/src/lib/community/fundraising.ts` (synced to the admin).
- Document `fundraising` – GET/PUT /admin/fundraising; publish needs fundraising.manage. Campaigns, personal pages
  (status pending/approved/rejected/hidden), website switch.
- Gifts: Donations (F3) gifts carry campaignId and pageId; the BE runs matching()/progress() on them.
  POST /admin/fundraising/gifts (office gift) and POST /admin/fundraising/pledges.
- Members: POST /member/campaign-pages (creates a pending page; minimum goal checked), GET /member/campaign-pages.
- Public: GET /public/campaigns → publicCampaigns(doc, gifts, pledges, today): totals only, donor wall first names of
  donors who allowed it, no amounts with names, no pending/rejected pages.
- Insights: donorInsights(gifts, year) for the admin only (LYBUNT/SYBUNT lists can feed Communication groups).

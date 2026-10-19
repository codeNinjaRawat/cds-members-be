# API contract – F7 Finance (demo built 2026-10-16)

Rules: `web/src/lib/community/finance.ts` (synced to the admin).
- Document `finance-settings` – GET/PUT /admin/finance/settings; publish needs finance.manage.
- Table `ledger` (RLS by organization; center-limited roles only their centers): GET/POST /admin/finance/transactions,
  POST /{id}/approve (server runs cannotApprove/approveTx), POST /{id}/pay, POST /{id}/reject. Donations payouts and
  Zakat payouts are written by those modules with source donations/zakat (approved there).
- The server checks art12() and transferProblem(); an Art. XII case cannot be approved without the Joint/General Body
  decision recorded (boardDecision = meeting id from /admin/meetings).
- Table `statements` – POST /admin/finance/statements (quarterly statement received from a center).
- Bank account numbers: last 4 digits only; full numbers are never stored.

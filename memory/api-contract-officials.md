# API contract – F5 Elected officials (demo built 2026-10-16)

Rules: `web/src/lib/community/officials.ts` (synced to the admin), from the Constitution Art. V and Bylaws Art. V–VII.

## Document
- `officials` – GET/PUT /admin/officials. View: members.view. Publish: officials.manage (Owner, Admin, Election
  Commission). Shape `OfficialsSchema`: holders[] (kind officer | zonal-director | associate-director | area-rep |
  secretary; office, zone, center, zips, atLarge; name, memberId, publicEmail; how elected | appointed | confirmed |
  acting; termStart, termEnd, oathOn, orientationOn; status serving | vacant | ended; vacancy {reason, on};
  boardTerms; showOnWebsite), eidDates[], website {enabled, showEmail, findByZip}.
- Refines: one serving elected office per member ID (secretaries excluded), kind-specific fields, term order,
  vacancy reason. The BE also runs `officialsWarnings` with real member facts and voter counts per center and ZIP
  and refuses publish only on schema errors (warnings are shown, not blocking).

## Derived
- `areaRepSeats(votersByZip)` per center from eligible voters (eligibility on the record date).
- `electionDay(year)`, `oathDay(year, eid)`, `termFor(year)`, `ballotParity`, `nextElection`, `vacancyRule`.

## Public
- GET /public/leadership → `publicOfficials(doc, today)` only (names, seats, office emails if allowed, term end).
  No member IDs, vacancy reasons or term counts. Ended terms hidden.
- "Who represents me?" runs `findMyRepresentatives` in the browser on that list + zones/ZIPs from /public/centers.

## Open with the owner
- Real officials list (entered by ISGH in the admin). Whether personal emails are ever shown (default: office emails).
- Prototype says "zonal counselors"; the Bylaws say Area Representatives – the system uses the Bylaws terms.

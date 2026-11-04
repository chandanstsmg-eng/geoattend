# Privacy, transparency and compliance design

GeoAttend processes employee location and photographs — sensitive personal data. The software is built to support a lawful, transparent deployment, but **it does not make a deployment lawful by itself**. Before going live, have the processing reviewed against the employment, privacy and data-protection law of every jurisdiction where employees work (for example GDPR/UK GDPR, India's DPDP Act 2023, state laws in the US), consult employee representatives where required, and complete a data-protection impact assessment. An employee clicking "I acknowledge" is **not** a substitute for that review and is not treated as consent.

## What the system does

| Principle | Implementation |
|---|---|
| Notice before tracking | Versioned notice (Settings → Privacy & tracking notice) shown in the app; tracking cannot start until the current version is acknowledged; any text change creates a new version. The notice includes what is collected, why, who sees it, when tracking runs and retention periods. |
| Visible tracking | Employee starts the shift explicitly; Android persistent foreground-service notification; in-app tracking indicator; iOS location indicator. |
| Scope limited to shifts | Sessions can only start inside the shift window (configurable early start), are closed by the server at shift end + grace, and every upload outside an open session is rejected. The app stops collecting when told `shouldTrack=false`. **Exception — overtime:** after the scheduled end the employee may tap "Start overtime" (selfie + location); the session then stays open, wherever they work, until they tap "End overtime", an administrator ends it, the next shift starts, or no location arrives for an hour. The notice (version 2) says so. |
| No covert collection | No hidden camera use, no background camera, no silent biometric identification, no location outside a session, no attempt to bypass OS permission controls. Denied permissions are reported honestly; the app offers manual review instead of collecting anyway. |
| Data minimisation | Location stored with accuracy and time only during sessions; one attendance photo per shift; raw history deleted automatically, and photos only once automatic photo deletion is switched on, after configurable retention (default 90 / 180 days). |
| Access control | Location history and photos are admin-only; employees see only their own data; every admin view of location history or a photo, every export, correction and setting change is written to the append-only audit log. |
| Honest uncertainty | GPS is treated as an estimate: accuracy margins, stabilisation, hysteresis; uncertain readings decide nothing; device silence is "tracking interrupted", never "left"; mock-location flags are "risk indicators, not proof". |
| Correction and dispute | Employees can dispute a record or report a technical issue from the app; admins correct records only with a mandatory reason, keeping before/after history. |
| Deletion | Retention job (hourly, or *Run retention now*), per-photo deletion by the company owner with reason, audited. Automatic photo deletion is on hold until the rules have legal review ([EXTERNAL-DEPENDENCIES.md](EXTERNAL-DEPENDENCIES.md)), deactivated employees' data retained only as long as retention allows. |

## Things an organisation must decide and document

* Lawful basis and purpose of tracking; whether photos are necessary at all.
* Retention periods (configure in Settings) and the legal record-keeping period for attendance records themselves (these are not auto-deleted).
* Who may be an administrator; access review cadence; how audit logs are reviewed.
* How employees exercise access/correction/erasure rights (export via Reports + audit log; deletion procedures).
* Cross-border transfer and processor agreements (cloud hosting, Google Maps, Expo/FCM/APNs push, e-mail provider).
* Whether mock-location policy is `FLAG` (default) or `BLOCK_ATTENDANCE`.

## Identity verification

The attendance photo is evidence for human review. GeoAttend also compares it with the face the employee enrolled, where the company requires enrollment: a mismatch is a prompt for a person to check, never proof, and the result is kept with the record. Face data needs its own legal review.

## GPS spoofing

A typical app cannot completely prevent location spoofing (mock-location apps, rooted devices, emulators, GPS spoofers). GeoAttend records the OS mock-location flag as a risk indicator and supports manual review; device-integrity attestation (Play Integrity / App Attest) could be added as a further *signal*, still not as proof.

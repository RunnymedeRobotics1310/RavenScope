# R8 Measurement Checklist

**Requirement R8 (from the greenfield plan):**

> "Much easier to use" than RavenBrain, with an operational target: from
> creating a Cloudflare account, a new user reaches "first session
> visible in the UI" in under 5 minutes of user-clock time (assuming
> RavenLink is already installed and a match has already been recorded).

This checklist is for an external tester — someone who has not used
RavenScope before — to run with a stopwatch. Record the elapsed time at
each milestone. Target: T5 under 5:00.

## Prerequisites for the tester

- A laptop with a working browser
- A RavenLink build that includes the `ravenbrain.api_key` bearer-auth
  patch (feat/ravenscope-bearer-auth — see the README's "Pointing
  RavenLink at RavenScope")
- A recorded `.jsonl` telemetry session on disk (any real match works)
- An email inbox they can check on the same laptop
- **No prior RavenScope account.** They start from zero.

## What the tester needs from us

- A link to the deployed RavenScope Worker URL (e.g.
  `https://ravenscope.your-team.workers.dev`)
- Nothing else — no account, no credentials, no configuration

## Stopwatch

Start the clock when the tester first loads the RavenScope URL.

| Milestone | Target | Actual |
|---|---|---|
| **T0:** page loads, tester clicks "Send me a sign-in link" after entering their email | 0:30 | ____ |
| **T1:** magic-link email arrives and the tester clicks it | 1:30 | ____ |
| **T2:** tester lands on the Sessions page (empty) and navigates to API Keys | 2:00 | ____ |
| **T3:** tester creates a key, copies the plaintext, dismisses the reveal dialog | 2:30 | ____ |
| **T4:** tester edits RavenLink's `config.yaml` to point at the deployed URL + paste the API key, and starts RavenLink with an existing recorded session | 4:00 | ____ |
| **T5:** first session appears in the RavenScope sessions list and is clickable | 5:00 | ____ |

## Friction log

Write down any step where the tester hesitated, had to ask for help, or
hit a dead end. These are the things to fix before the next tester.

- [ ] Sign-in page: did the tester understand "No password, we'll email
      you a link"? Or did they look for a password field?
- [ ] Email delivery latency: was the magic link in their inbox within
      10 seconds? (Slower indicates a Resend config issue.)
- [ ] API keys page: did they know to copy the plaintext *before*
      closing the reveal dialog? The warning copy should be unambiguous.
- [ ] RavenLink config: was the copy-paste YAML snippet in the README
      clear enough to paste without editing? Did they need to ask what
      `ravenbrain.api_key` does?
- [ ] Session appearance: did the session show up within 10s of
      RavenLink finishing the upload?

## Reporting

After the run:

1. Record T0–T5 in the table above.
2. Note any friction points or blockers in the log.
3. If T5 > 5:00, identify the single slowest step and file an issue.
4. Commit the filled-in checklist under `docs/r8-runs/YYYY-MM-DD-<tester>.md`.

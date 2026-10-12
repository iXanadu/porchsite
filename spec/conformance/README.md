# Conformance check

One script that tells you whether a Sitekeeper site is safe for an assistant
to run: it connects as an assistant and tries everything SPEC §2 says an
assistant must not be able to do.

```bash
pip install httpx
python conformance/check.py https://your-site.example --token <assistant access token>
```

Get the token the way any assistant does: connect it to the site (OAuth),
approve it with your passkey, and copy the access token from the client.

What it checks: no tool can publish or approve (S1); a draft never reaches
the public site, and a decision posted without the owner publishes nothing
(S1); a stale or zero version is refused (S3); a replayed create returns the
same item (S4); every version is kept and rollback works (S5); content that
looks like a secret is refused (S6); an image on another host is copied in
or refused, never kept as a link (S7); the review page needs the owner, and an
edit after asking voids the request (S2); refusals share one shape (S8).

It leaves a few draft items marked `conformance-…` and one approval request
behind. Deny the request; nothing it made is ever published.

Exit code = number of failed checks, so it fits in a script: every release
runs it (through `scripts/conformance-server.sh`), and checks the check
(`scripts/conformance-mutations.sh`: the server edition with one rule
deliberately broken at a time, each of which must make its check fail),
among the local gates in
`cloudflare/scripts/downloads.sh`.

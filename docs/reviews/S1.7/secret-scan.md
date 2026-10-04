# S1.7 scans (separate mechanisms)

Actual harness check_secrets:

- Construction sources + integration bundle before global installation: `<tmp>/specflow-s17-source-scan.txt`, 206407 bytes; no findings.
- Frozen candidate sources/spec/review archives: `<tmp>/specflow-s17-final-source-scan.txt`, 261375 bytes, SHA-256 `d70c23385c05d3726b66fffd314076278d5f9baeff2500b564eb19de1c30086e`; no findings.
- Exact sealed call-2 working packet: job 97815394ea04420320a84dba7ba3ea72, 283831 bytes, SHA-256 806ffdf8c59d559ad0f8095d51fdaa68248916ec2105ca90f9a0c0a229598b33; actual harness scan had no findings before spawn. Actual child input hash is identical, not a separately reconstructed dry-run prompt.
- Actual raw stdout journal and frontend result log: harness scans had no findings before sharing. Raw journal hash 1c029763e4859039d0f1d19dbae1a83abe37840a59d83690b21307c59f3a5c0c, retained unchanged privately; final assistant report archived verbatim after normal done.

The engine scanner is explicitly `high-risk-patterns/v1` (limited named patterns), rescanning/hash checking the full child input before charge. It is not the harness check_secrets and neither mechanism is a complete secret-proof guarantee. Raw child journal is private; scan before sharing raw results. Environment check flagged a masked provider key name only; no value was printed, read into the packet, or recorded here.

No push/publish/deploy/GitHub settings change. Grant metadata is finite/immutable and does not reset user consent. Actual independent implementation audit completed 6/6 PASS; it is not claimed by fake results or scans. Closure/report artifact scans are performed again before final commit.

# Working snapshot

Taken before the redesign was wired in. This is the state that was live and
behaving on quinton4mvp.com: Postgres backend, 545 picks across 14 weeks,
auto-grading scheduled, 448 assertions passing.

To roll back, copy `Google App Script Code.gs` into the Apps Script editor and
deploy a new version, and restore `Deploy Front End HTML/index.html` over the
current one. Nothing here depends on anything outside this folder.

The exact commit is in GIT-COMMIT.txt, so `git checkout <sha>` recovers the
same thing if this folder is ever lost.

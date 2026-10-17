# Review contract

The caller is an authenticated member of exactly one tenant. Invoice identifiers
are caller-controlled; database lookups must enforce the authenticated tenant.
Permissions use exact literal strings. A `*` permission is an ordinary input
literal and never authorizes a different required permission. Review against
this contract and report concrete preconditions, impact and source locations.

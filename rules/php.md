# PHP

- Prefer findings about type safety, data integrity, SQL injection, and uncaught exceptions over minor formatting.
- Flag unhandled null values and risky dynamic property access or type coercion.
- Check database mutations for appropriate transaction scoping and rollback safety.
- For Eloquent / query builder code, watch for raw SQL concatenation and unintentional N+1 query loops.
- Verify authorization checks / policies before state-changing controller actions.
- Ensure custom exceptions or error responses do not leak sensitive debug traces or credentials to clients.

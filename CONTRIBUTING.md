# Contributing

Issues and PRs are welcome, especially new collectors and pricing fixes.

## Adding a product

1. Add a collector to `COLLECTORS` in `src/collectors.ts`. Each collector is one
   GraphQL query that returns rows for one 5-minute window, plus a `parse` that
   turns rows into `{ product, resource, metric, value }` samples. Keep it to one
   dataset so a failure there can't hide other products.
2. Add the product to `Product`/`PRODUCTS` and its unit prices to
   `DEFAULT_PRICES` in `src/pricing.ts`. Link the pricing page in the PR.
3. Add a case to `test/collectors.test.ts` with a realistic response.
4. Run it against a real account with `GET /api/doctor` and include the output
   (with ids redacted) in the PR. Most collector bugs are field names the docs
   don't mention.

## Ground rules

- The guard must stay cheap to run and must fail loudly, not silently.
- The kill switch must stay reversible: anything it removes is saved first.
- `npm test` and `npm run typecheck` must pass.

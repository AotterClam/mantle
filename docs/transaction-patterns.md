# Transaction coordination patterns

The retired transaction Starter contains useful commerce examples. Preserve
the knowledge here; do not import its whole application as a new template.
Historical source is fixed at
[alpha.17 transaction](https://github.com/aotter/mantle-starters/tree/v0.1.0-alpha.17/overlays/transaction).
This is reference material, not a promise of production payment integration.

## Separate business contracts from provider coordination

Schemas describe products/orders; Views expose bounded read surfaces;
Procedures define validated operations; Triggers govern public/staff entry.
Cloudflare bindings belong in the Worker composition root. A handler can call
an application-owned Durable Object for inventory coordination, then use Mantle
operations to reflect the result; it must not write Mantle's internal tables.
See the historical `src/commerce/handlers.ts` for the separation.

## Reserve and settle inventory exactly once

The historical `src/commerce/InventoryCoordinator.ts` keeps order state and
inventory reservations in the same DO storage transaction. Payment, expiry,
cancellation and fulfillment check the current state before applying changes.
A repeated successful operation returns its prior outcome; a terminal state
cannot consume/release the reservation again. An adjustment idempotency key is
bound to product, delta and reason: reusing it with different input is a
conflict, not another stock adjustment.

This protects local coordination, not a distributed transaction between DO,
Mantle storage and an external payment provider. Each downstream operation must
be safe to retry and have a reconciliation path. Do not describe a queue as
exactly-once delivery or acknowledge work before durable completion.

## Handle delayed expiry and missed delivery

The historical `src/index.ts` validates queue messages before dispatching the
expiry Procedure against the same runtime as HTTP. Transient dispatch failures
retry; an early expiry retries with a delay; completed/terminal outcomes ack.
Malformed input is logged and discarded. A scheduled expiry sweep complements
the delayed queue path, so correctness does not depend on one delivery.
A production application should define permanent-failure/DLQ handling for its
own operations rather than retrying every error forever.

Useful checks when adopting these patterns: duplicate messages, the same key
with conflicting payload, payment/expiry races, failure after coordination but
before the application projection, early queue delivery, and sweep recovery.
Use a fake payment provider only as a test boundary; real payment/webhook
verification and commercial readiness belong to the application.

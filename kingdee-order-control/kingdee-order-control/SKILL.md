---
name: kingdee-order-control
description: Control the user's local Kingdee order page through the Kingdee userscript bridge. Use when asked to inspect current order status, load or switch queue orders, fill codes or prices/quantities, repair cells, check amounts, or operate the existing Kingdee autofill panel. Requires the local Python queue service and the Tampermonkey script running in an open Kingdee tab.
---

# Kingdee Order Control

Use the bundled `scripts/kingdee_control.py` client to send one supported action and wait for that exact command's result. The user can keep using the panel buttons directly; this skill is an additional AI control path.

## Requirements

- The local `kingdee-prepare-queue.py` service must be running on `http://127.0.0.1:8766`.
- The updated `jdy-autofill-v13.3.1.user.js` must be installed and active in an open Kingdee tab.
- Python 3 is required; the client uses only the standard library.

## Use

Run the client from this skill directory (or use its absolute path):

```bash
python3 scripts/kingdee_control.py status
python3 scripts/kingdee_control.py next-order
python3 scripts/kingdee_control.py switch-type --type sales
python3 scripts/kingdee_control.py check-amount
```

Supported actions: `status`, `load-orders`, `next-order`, `previous-order`, `switch-type`, `fill-codes`, `paste-codes`, `paste-quantity-price`, `paste-price`, `smart-fill`, `repair`, `check-amount`, `clear`, and `refresh`. Use `switch-type --type purchase|sales`. Add `--base-url` if the service uses a different local address, and `--timeout` to adjust result wait time.

The client prints the completed command's JSON result and exits nonzero on execution error or timeout. For amount checks, report `expected`, `deal`, `difference`, `lines`, and `status` from the result; `status: unread` means the page amount could not be read and must not be represented as a successful match.

## Operating rules

- Check `status` before modifying the current order when context is unclear.
- Do not call `smart-fill`, `fill-codes`, `repair`, or `clear` unless the user requested that operation or clearly authorized it.
- `check-amount` is read-only and may be run to verify a fill.
- Treat a timeout as unknown completion, not failure; inspect `status` before resubmitting a mutation to avoid duplicate actions.
- Never claim an order was saved or audited: this bridge does not expose save or audit actions.
- The bridge listens only on localhost and should not be exposed to the network.

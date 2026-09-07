# NORIA Monetization — Accounts + NORIA Pro (weekly or monthly)

This guide turns NORIA into a paid product: users create an account, subscribe
to **NORIA Pro** — **$5/week** or **$15/month** — via **Paystack** and/or
**Paddle**, and only then can use the AI. Everything ships **behind a switch**
(`PAYWALL_ENABLED`) so the live site keeps working until you flip it on.

You do not need both providers. Configure whichever you have accounts for —
Paystack is best for African cards/mobile money, Paddle is best for
international cards/wallets and handles VAT/sales tax for you automatically.
Configure both and users get a choice at checkout.

---

## 1. What's already built (backend)

| Piece | Where | What it does |
|---|---|---|
| Accounts | `auth.js` | Email + password sign-up/login, JWT sessions, bcrypt hashing |
| Billing | `billing.js` | Paystack + Paddle subscribe / webhook / status / cancel; paywall gate |
| Shared DB | `db.js` | One Postgres pool for knowledge + accounts + subscriptions |
| Premium models | `llm.js` | Pro subscribers get a top-tier model, free chain as fallback |
| Wiring | `server.js` | Routes mounted; `/v1/ask` + `/v1/ask/stream` gated by subscription |

New tables (`noria_users`, `noria_subscriptions`) are created when you run
`/v1/setup` (see step 5). Existing databases get the new `provider`,
`interval`, `paddle_subscription_id` and `paddle_customer_id` columns added
automatically the next time the server boots (or `/v1/setup` runs) — nothing
to do by hand.

---

## 2. Option A — Paystack (only you can do this)

1. Sign up at **https://dashboard.paystack.com** (choose Ghana **or** Nigeria
   as your country → this is where you get paid out). As an individual you can
   start with your **BVN / Ghana Card + a valid ID + your personal bank
   account** — no registered company required to begin. Complete KYC to go
   **Live**; build/test everything in **Test mode** first.
2. **Settings → API Keys & Webhooks**: copy your **Secret Key** (`sk_…`) and
   **Public Key** (`pk_…`).
3. **Payments → Plans → Create Plan** — make two plans for the same product
   (NORIA Pro):

   | Plan | Suggested name | Interval | Amount |
   |---|---|---|---|
   | Weekly | NORIA Pro — Weekly | Weekly | USD 5 |
   | Monthly | NORIA Pro — Monthly | Monthly | USD 15 |

   Copy each plan's **Plan Code** (looks like `PLN_xxxxxxxx`).
4. **Settings → Webhooks**: set the webhook URL to:

# NORIA Monetization — Accounts + Paystack Subscriptions

This guide turns NORIA into a paid product: users create an account, subscribe
monthly via **Paystack** (card / mobile money / bank / USSD), and only then can
use the AI. Everything ships **behind a switch** (`PAYWALL_ENABLED`) so the live
site keeps working until you flip it on.

---

## 1. What's already built (backend)

| Piece | Where | What it does |
|---|---|---|
| Accounts | `auth.js` | Email + password sign-up/login, JWT sessions, bcrypt hashing |
| Billing | `billing.js` | Paystack subscribe / webhook / status / cancel; paywall gate |
| Shared DB | `db.js` | One Postgres pool for knowledge + accounts + subscriptions |
| Premium models | `llm.js` | Premium-plan users get a top-tier model, free chain as fallback |
| Wiring | `server.js` | Routes mounted; `/v1/ask` + `/v1/ask/stream` gated by subscription |

New tables (`noria_users`, `noria_subscriptions`) are created when you run
`/v1/setup` (see step 4).

---

## 2. Create your Paystack account (only you can do this)

1. Sign up at **https://dashboard.paystack.com** (choose Ghana **or** Nigeria as
   your country → this is where you get paid out). As an individual you can start
   with your **BVN / Ghana Card + a valid ID + your personal bank account** — no
   registered company required to begin (limits lift once you register a business).
2. Complete the KYC so you can go **Live**. You can build/test everything in
   **Test mode** first with the test keys.
3. **Settings → API Keys & Webhooks**: copy your **Secret Key** (`sk_…`) and
   **Public Key** (`pk_…`).

## 3. Create the two subscription plans

In Paystack: **Payments → Plans → Create Plan** (make two):

| Plan | Suggested name | Interval | You set the amount |
|---|---|---|---|
| Pro | NORIA Pro | Monthly | e.g. GHS 60 / ₦6,000 |
| Premium | NORIA Premium | Monthly | e.g. GHS 150 / ₦15,000 |

Copy each plan's **Plan Code** (looks like `PLN_xxxxxxxx`).

## 4. Configure the server (Render → Environment)

Add these environment variables to the `noria-engine` service on Render:

```
JWT_SECRET             = <a long random string — e.g. 48+ random chars>
PAYSTACK_SECRET_KEY    = sk_live_xxx   (or sk_test_xxx while testing)
PAYSTACK_PUBLIC_KEY    = pk_live_xxx
PAYSTACK_PLAN_PRO      = PLN_xxxxxxxx
PAYSTACK_PLAN_PREMIUM  = PLN_yyyyyyyy
PAYWALL_CALLBACK_URL   = https://your-noria-site/paid   (where users land after paying)

# Premium AI model for Premium subscribers (optional but recommended).
# Easiest: one OpenRouter key unlocks GPT / Claude / Gemini Pro.
PREMIUM_API_KEY        = sk-or-xxxxxxxx
PREMIUM_BASE_URL       = https://openrouter.ai/api/v1/chat/completions
PREMIUM_MODEL          = openai/gpt-4o-mini   (or anthropic/claude-3.5-sonnet, etc.)

# Keep this OFF until the frontend login/paywall UI is live, then set to true.
PAYWALL_ENABLED        = false
```

Then, in Paystack **Settings → Webhooks**, set the webhook URL to:

```
https://noria-engine.onrender.com/v1/billing/webhook
```

## 5. Create the new database tables

Once `DATABASE_URL` and the vars above are set, open this once in your browser
(replace the secret) to create the accounts + subscription tables:

```
https://noria-engine.onrender.com/v1/setup?secret=YOUR_NORIA_SETUP_SECRET
```

## 6. Go live

Set `PAYWALL_ENABLED=true` when the frontend sign-in / subscribe screens are
ready (Phase 2). From then on, `/v1/ask` and `/v1/ask/stream` require an active
subscription.

---

## API reference (for the frontend)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/v1/auth/register` | `{email,password,name?}` | `{token,user}` |
| POST | `/v1/auth/login` | `{email,password}` | `{token,user}` |
| GET | `/v1/auth/me` | — (Bearer) | `{user,subscription}` |
| GET | `/v1/billing/config` | — | `{configured,paywallEnabled,publicKey,plans}` |
| POST | `/v1/billing/subscribe` | `{plan:'pro'\|'premium'}` (Bearer) | `{authorizationUrl,...}` → redirect user there |
| GET | `/v1/billing/status` | — (Bearer) | `{active,plan,tier}` |
| POST | `/v1/billing/cancel` | — (Bearer) | `{ok:true}` |
| POST | `/v1/billing/webhook` | Paystack event | `200` |

The frontend stores the `token` and sends `Authorization: Bearer <token>` on
every `/v1/ask` call. A `402 SUBSCRIPTION_REQUIRED` or `401 AUTH_REQUIRED`
response tells the UI to show the sign-in / subscribe screen.

## Security notes

- Webhook events are verified with Paystack's HMAC-SHA512 signature — forged
  events are rejected. **Entitlement is only ever granted via the webhook**, never
  from the browser, so a user cannot self-activate.
- Passwords are bcrypt-hashed; JWTs are signed with `JWT_SECRET` (set a strong one).
- Never commit real keys. Set them only in Render's Environment tab.

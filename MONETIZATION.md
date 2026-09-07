# NORIA Monetization — Accounts + NORIA Pro (weekly or monthly)

This guide turns NORIA into a paid product: users create an account, subscribe
to **NORIA Pro** — **$10/week** or **$25/month** — via **Paystack** and/or
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
   | Weekly | NORIA Pro — Weekly | Weekly | USD 10 |
   | Monthly | NORIA Pro — Monthly | Monthly | USD 25 |

   Copy each plan's **Plan Code** (looks like `PLN_xxxxxxxx`).
4. **Settings → Webhooks**: set the webhook URL to:
   ```
   https://noria-engine.onrender.com/v1/billing/webhook/paystack
   ```

## 3. Option B — Paddle (only you can do this)

1. Sign up at **https://www.paddle.com** and complete onboarding (Paddle is
   merchant-of-record, so there's a short verification step before you can go
   live — you can build/test everything in **Sandbox** first at
   **https://sandbox-login.paddle.com**).
2. **Paddle → Catalog → Products** — create one product, **"NORIA Pro"**, then
   add two **Prices** under it:

   | Price | Billing cycle | Amount |
   |---|---|---|
   | Weekly | Every 1 week | USD 10.00 |
   | Monthly | Every 1 month | USD 25.00 |

   Copy each price's **Price ID** (looks like `pri_xxxxxxxx`).
3. **Developer Tools → Authentication**: create an **API key** (server-side
   secret) — this is `PADDLE_API_KEY`.
4. **Developer Tools → Client-side tokens**: create a **client-side token**
   (safe to expose to the browser) — this is `PADDLE_CLIENT_TOKEN`.
5. **Developer Tools → Notifications**: create a notification destination
   (webhook), URL:
   ```
   https://noria-engine.onrender.com/v1/billing/webhook/paddle
   ```
   Subscribe it to at least: `subscription.created`, `subscription.activated`,
   `subscription.updated`, `subscription.canceled`, `subscription.paused`,
   `transaction.completed`. Copy the destination's **secret key** — this is
   `PADDLE_WEBHOOK_SECRET`.
6. When you switch from Sandbox to a live Paddle account, repeat steps 2–5
   there (product/prices/keys are separate per environment) and set
   `PADDLE_ENVIRONMENT=production`.

## 4. Configure the server (Render → Environment)

Add whichever of these you have to the `noria-engine` service on Render (see
`.env.example` for the full annotated list):

```
JWT_SECRET                = <a long random string — e.g. 48+ random chars>

# Paystack (optional — configure if you're using it)
PAYSTACK_SECRET_KEY       = sk_live_xxx   (or sk_test_xxx while testing)
PAYSTACK_PUBLIC_KEY       = pk_live_xxx
PAYSTACK_PLAN_PRO_WEEKLY  = PLN_xxxxxxxx
PAYSTACK_PLAN_PRO_MONTHLY = PLN_yyyyyyyy
PAYWALL_CALLBACK_URL      = https://your-noria-site/paid   (where users land after paying)

# Paddle (optional — configure if you're using it)
PADDLE_API_KEY            = pdl_xxxxxxxx
PADDLE_CLIENT_TOKEN       = live_xxxxxxxx  (or test_xxxxxxxx in Sandbox)
PADDLE_WEBHOOK_SECRET     = pdl_ntfset_xxxxxxxx
PADDLE_ENVIRONMENT        = sandbox   (or production once live)
PADDLE_PRICE_PRO_WEEKLY   = pri_xxxxxxxx
PADDLE_PRICE_PRO_MONTHLY  = pri_yyyyyyyy

# Premium AI model for Pro subscribers (optional but recommended).
# Easiest: one OpenRouter key unlocks GPT / Claude / Gemini Pro.
PREMIUM_API_KEY           = sk-or-xxxxxxxx
PREMIUM_BASE_URL          = https://openrouter.ai/api/v1/chat/completions
PREMIUM_MODEL             = openai/gpt-4o-mini   (or anthropic/claude-3.5-sonnet, etc.)

# Keep this OFF until the frontend sign-in/pricing UI is live, then set to true.
PAYWALL_ENABLED           = false
```

## 5. Create the new database tables

Once `DATABASE_URL` and the vars above are set, open this once in your browser
(replace the secret) to create the accounts + subscription tables:

```
https://noria-engine.onrender.com/v1/setup?secret=YOUR_NORIA_SETUP_SECRET
```

## 6. Go live

Set `PAYWALL_ENABLED=true` when the frontend sign-in / pricing screens are
ready. From then on, `/v1/ask` and `/v1/ask/stream` require an active Pro
subscription (weekly or monthly — both unlock the same access).

## 7. Changing the price later — no redeploy, no code edit

`/v1/setup` (step 5) also creates a `noria_plan_pricing` table. Once it
exists, NORIA Pro's price is live-editable from the SKYGLOBE-LIMITED CEO
portal (**Pricing → NORIA Pro Subscription** — it talks to this service
using your `NORIA_SETUP_SECRET`), or directly:

```
GET  /v1/billing/admin/pricing              (Bearer NORIA_SETUP_SECRET, or ?secret=)
PATCH /v1/billing/admin/pricing/weekly       body: { amountUSD?, paystackPlan?, paddlePriceId? }
PATCH /v1/billing/admin/pricing/monthly      body: { amountUSD?, paystackPlan?, paddlePriceId? }
```

Example:
```bash
curl -X PATCH https://noria-engine.onrender.com/v1/billing/admin/pricing/weekly \
  -H "Authorization: Bearer YOUR_NORIA_SETUP_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"amountUSD": 12}'
```

Important: changing `amountUSD` alone only changes the number customers
*see*. The amount actually *charged* is fixed by whichever Paystack Plan /
Paddle Price the subscription uses — that's a constraint of every recurring
billing provider (Paystack/Paddle/Stripe all require a pre-created Plan/Price
object for subscriptions; unlike a one-time payment, you can't just send an
arbitrary amount at checkout time). So a genuine price change is two steps:
create the new Plan (Paystack) / Price (Paddle) in that provider's dashboard
first, then PATCH the new `paystackPlan` / `paddlePriceId` here alongside the
matching `amountUSD` — still zero code changes, zero redeploys.

---

## API reference (for the frontend)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/v1/auth/register` | `{email,password,name?}` | `{token,user}` |
| POST | `/v1/auth/login` | `{email,password}` | `{token,user}` |
| GET | `/v1/auth/me` | — (Bearer) | `{user,subscription}` |
| GET | `/v1/billing/config` | — | `{configured,paywallEnabled,plan,paystack,paddle}` |
| POST | `/v1/billing/subscribe` | `{interval:'weekly'\|'monthly'}` (Bearer) | `{authorizationUrl,...}` → redirect user there (**Paystack only** — see below for Paddle) |
| GET | `/v1/billing/status` | — (Bearer) | `{active,plan,tier,interval,provider}` |
| POST | `/v1/billing/cancel` | — (Bearer) | `{ok:true}` |
| POST | `/v1/billing/webhook/paystack` | Paystack event | `200` |
| POST | `/v1/billing/webhook/paddle` | Paddle event | `200` |
| GET | `/v1/billing/admin/pricing` | — (Bearer `NORIA_SETUP_SECRET`) | live `PLAN_PRICES` — see §7 |
| PATCH | `/v1/billing/admin/pricing/:interval` | `{amountUSD?,paystackPlan?,paddlePriceId?}` (Bearer) | updated plan — see §7 |

The frontend stores the `token` and sends `Authorization: Bearer <token>` on
every `/v1/ask` call. A `402 SUBSCRIPTION_REQUIRED` or `401 AUTH_REQUIRED`
response tells the UI to show the sign-in / pricing screen.

**Starting a Paddle checkout** happens entirely client-side with Paddle.js —
no `/v1/billing/subscribe` call needed:

```html
<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
<script>
  const cfg = await fetch('https://noria-engine.onrender.com/v1/billing/config').then(r => r.json());
  Paddle.Environment.set(cfg.paddle.environment); // 'sandbox' or 'production'
  Paddle.Initialize({ token: cfg.paddle.clientToken });

  Paddle.Checkout.open({
    items: [{ priceId: cfg.paddle.prices.weekly, quantity: 1 }], // or .monthly
    customer: { email: currentUser.email },
    customData: { user_id: String(currentUser.id) }, // ← lets our webhook match the user
  });
</script>
```

## Security notes

- Webhook events are verified against each provider's signature — Paystack's
  HMAC-SHA512 header, Paddle's `Paddle-Signature` header — so forged events
  are rejected. **Entitlement is only ever granted via a webhook**, never from
  the browser, so a user cannot self-activate.
- Passwords are bcrypt-hashed; JWTs are signed with `JWT_SECRET` (set a strong one).
- Never commit real keys. Set them only in Render's Environment tab.

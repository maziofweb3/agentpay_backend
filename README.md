# AgentPay AI — Backend API

> Express.js API gateway for the [AgentPay AI](https://agentpayfrontend.vercel.app) platform — AI inference gated by on-chain USDT payments on BotChain.

**Live API:** https://agentpay-backend-c7c5.onrender.com/health  
**Frontend:** https://agentpayfrontend.vercel.app  
**GitHub Org:** https://github.com/agentpay-ai

---

## What it does

The backend is an Express.js server deployed on Vercel that:

- Accepts AI requests (chat, image, code) and gates them behind on-chain USDT payment verification
- Supports three payment methods:
  - **Per-request** — user submits a `X-AgentPay-Payment-Tx` header with a real on-chain USDT transfer tx hash
  - **Prepaid session** — user deposits USDT once, receives a signed session token, uses it for multiple requests
  - **x402** — standard HTTP 402 payment-required challenge/response flow
- Proxies Claude (Anthropic) AI completions
- Manages agent reputation via ERC-8004 on BotChain
- Relays BotChain transactions

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Status, model info, payment config |
| `POST` | `/api/chat` | Claude chat completion (payment-gated) |
| `POST` | `/api/image` | Image generation (payment-gated) |
| `POST` | `/api/code` | Code generation (payment-gated) |
| `GET` | `/api/reputation/:address` | Agent reputation lookup |
| `POST` | `/api/attribution` | Attribute a request to an agent |
| `POST` | `/api/credits/deposit` | Verify on-chain USDT deposit → issue session token |
| `POST` | `/api/botchain/relay` | Relay a signed BotChain transaction |

---

## Tech Stack

- **Runtime**: Node.js + Express.js
- **AI**: Anthropic Claude (`claude-opus-5`) via `@anthropic-ai/sdk`
- **Payments**: `@x402/express` middleware + direct USDT transfer verification
- **Chain**: BotChain (EVM-compatible, chain IDs 968 / 677)
- **Deployment**: Vercel (serverless)

---

## Local Development

```bash
git clone https://github.com/agentpay-ai/agentpay_backend
cd agentpay_backend
npm install
cp .env.example .env   # fill in your keys
npm run dev            # starts on http://localhost:3001
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ANTHROPIC_MODEL` | Model override (default: `claude-opus-5`) |
| `ANTHROPIC_BASE_URL` | Override AI base URL (default: `https://api.anthropic.com`) |
| `X402_NETWORK` | `testnet` or `mainnet` |
| `X402_API_KEY` | x402 facilitator API key |
| `PAYMENT_RECIPIENT_ADDRESS` | Vault address that receives USDT |
| `BOTCHAIN_RPC_URL` | BotChain RPC endpoint |
| `SESSION_SECRET` | HMAC secret for prepaid session tokens |

---

## Related

- **Frontend repo**: [agentpay-ai/agentpay_frontend](https://github.com/agentpay-ai/agentpay_frontend)
- **Live site**: https://agentpayfrontend.vercel.app

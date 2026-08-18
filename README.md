# AgentPay AI — Backend Gateway API

> Express.js API gateway for the [AgentPay AI](https://www.agentpayai.online) platform — AI inference aggregation, dynamic token-exact billing, and gasless micropayments on BotChain.

**Live API:** [https://agentpay-backend-c7c5.onrender.com](https://agentpay-backend-c7c5.onrender.com)  
**Frontend:** [https://www.agentpayai.online](https://www.agentpayai.online)  
**BOF Facilitator:** [https://bof-facilitator.onrender.com](https://bof-facilitator.onrender.com)  
**GitHub Org:** [https://github.com/agentpay-ai](https://github.com/agentpay-ai)

---

## What it does

The backend gateway is an Express.js engine hosted on Render that:

1. **Dynamic Token-Exact Billing**: Calculates prompt pricing dynamically based on raw character/token counts, vendor rate cards (Gemini 3.6 Flash / Claude 3.5 Sonnet / Imagen 3), live APAY token market pricing, and a fixed **50% protocol profit margin**.
2. **Off-Chain Verification with BOF**: Validates EIP-712 / EIP-3009 transfer authorizations instantly via the open-source Rust **[BOF (BotChain Open Facilitator)](https://github.com/agentpay-ai/BOF)** microservice before triggering AI execution.
3. **Multi-Model AI Aggregation**: Dispatches prompt workloads to upstream AI providers:
   - **Chat**: Google Gemini 3.6 Flash & Anthropic Claude 3.5 Sonnet
   - **Code**: Anthropic Claude 3.5 Sonnet AST-level vulnerability auditing
   - **Images**: Google Imagen 3 high-resolution generation
4. **Asynchronous On-Chain Settlement**: Dispatches gasless settlement to BotChain EVM via BOF `/settle` asynchronously in the background, ensuring sub-second response times for end users.
5. **Reputation & Attribution**: Manages ERC-8004 agent reputation tracking and ERC-8021 builder attribution.

---

## API Endpoints

| Method | Path | Billing Formula | Description |
|---|---|---|---|
| `GET` | `/health` | Free | Status, AI model registry, and payment configuration |
| `GET` | `/api/price` | Free | Dynamic single source of truth for live APAY and service pricing |
| `POST` | `/api/chat` | Token-exact + 50% Profit | Conversational AI text completions |
| `POST` | `/api/code` | Token-exact + 50% Profit | Smart contract security audit & vulnerability detection |
| `POST` | `/api/image` | Fixed Cost + 50% Profit | Image generation via Google Imagen 3 |
| `GET` | `/api/reputation/:address` | Free | Agent reputation score lookup |
| `POST` | `/api/reputation/rate` | Free | Submit rating for an autonomous agent |
| `POST` | `/api/botchain/relay` | Token-exact + 50% Profit | Programmatic machine-to-machine task relay |

---

## Tech Stack

- **Runtime**: Node.js + Express.js + TypeScript
- **AI SDKs**: `@google/genai` (Gemini & Imagen) + `@anthropic-ai/sdk` (Claude)
- **Facilitator**: Rust BOF Microservice (`https://bof-facilitator.onrender.com`)
- **Networks**: BotChain Mainnet (Chain ID `677`) & BotChain Testnet (Chain ID `968`)
- **Hosting**: Render Cloud

---

## Local Development

```bash
git clone https://github.com/agentpay-ai/agentpay_backend
cd agentpay_backend
npm install
cp .env.example .env.local   # populate API keys
npm run dev                  # starts on http://localhost:3001
```

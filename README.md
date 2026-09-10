# Auto Register

Multi-platform automated account registration bot using Playwright + temporary email.

## Supported Platforms

| Platform                                        | Script                | Command              |
| ----------------------------------------------- | --------------------- | -------------------- |
| [Xiaomi MiMo API](https://platform.xiaomimimo.com) | `registrars/register.js`       | `npm run register` |
| [Alibaba Cloud](https://account.alibabacloud.com)  | `registrars/register_alibaba.js` | `npm run alibaba`  |
| [Qoder](https://qoder.com) (via llm-agent-trade)   | `registrars/register_qoder.js` | `npm run qoder`    |

## Features

- **Auto register** — fill form, handle captcha, verify OTP
- **Temp email** — generate disposable email + auto-extract OTP verification code
- **Terms & agreements** — auto-check + confirm
- **Cookie consent** — auto-accept on every page
- **Human-like typing** — character-by-character with randomized delays
- **Anti-bot detection** — stealth plugin, webdriver removal, fake browser properties, WebGL/Canvas/AudioContext fingerprint spoofing
- **Captcha solving** — auto (LLM Vision: ImageToText OCR) with manual fallback
- **Slider captcha** — Baxia (Alibaba) auto-slide with human-like drag pattern
- **Multi-tab support** — dashboard stays open, OAuth in new tab per run
- **Loop mode** — register multiple accounts in one session
- **2captcha ready** — fill in API key, set `captchaMode: '2captcha'` (Xiaomi)
- **LLM Captcha ready** — set `LLM_API_KEY`, `LLM_API_URL`, and `LLM_MODEL` in `.env` for Xiaomi custom captcha (ImageToText OCR)

## Prerequisites

- Node.js >= 18
- Chromium (auto-installed via Playwright)

## Installation

```bash
npm install
npx playwright install chromium
```

## Configuration

### Environment Variables (.env)

Sensitive credentials are stored in `.env` (gitignored):

```env
PLATFORM_PASSWORD=your_platform_password
PLATFORM_URL=https://your-platform-url.com
QODER_URL=https://your-platform-url.com/dashboard/providers/qoder
QODER_ACCOUNT_PASSWORD=your_account_password
LLM_API_KEY=your_llm_api_key
LLM_API_URL=http://localhost:20128/v1/chat/completions
LLM_MODEL=cx/gpt-5.4-mini
PROXY=http://user:pass@host:port
BROWSER_EXECUTABLE_PATH=/path/to/comufox
```

### Xiaomi MiMo

Edit the `CONFIG` section in `registrars/register.js`:

```js
const CONFIG = {
  registerUrl: 'https://...',    // platform registration URL
  consoleUrl: 'https://...',     // platform console URL
  password: '...',               // account password
  region: 'Indonesia',           // region (auto-detected from URL)
  apiKeyName: 'auto-xxx',        // API key name prefix
  outputFile: 'data/xiaomi.csv',  // CSV output file
  captchaMode: 'manual',         // 'manual' | '2captcha'
  captchaApiKey: '',             // fill in if using 2captcha
};
```

### Alibaba Cloud

Edit the `CONFIG` section in `registrars/register_alibaba.js`:

```js
const CONFIG = {
  registerUrl: 'https://account.alibabacloud.com/register/intl_register.htm',
  consoleUrl: 'https://modelstudio.console.alibabacloud.com',
  password: process.env.ALIBABA_PASSWORD || 'AlibabaAuto2025!',
  outputFile: 'data/alibaba.csv',
};
```

### Qoder

Edit the `CONFIG` section in `registrars/register_qoder.js`:

```js
const CONFIG = {
  // URLs & passwords from .env
  platformUrl: process.env.9ROUTER_URL,
  qoderUrl: process.env.QODER_URL,
  platformPassword: process.env.9ROUTER_PASSWORD,
  password: process.env.QODER_ACCOUNT_PASSWORD,
  // Other settings
  outputFile: 'data/qoder.csv',
  loops: 5,                      // number of registration loops
  captchaMode: 'llm',            // 'manual' | 'llm' (LLM solver + manual fallback)
};
```

## Usage

### Xiaomi MiMo

```bash
npm run register
```

### Alibaba Cloud

```bash
npm run alibaba
```

### Qoder

```bash
npm run qoder
```

### Loop Mode (Xiaomi)

```bash
npm run loop
```

## Flow

### Xiaomi MiMo (11 steps)

| Step | Description                                            |
| ---- | ------------------------------------------------------ |
| 1    | Launch Chromium browser                                |
| 2    | Generate temporary email                               |
| 3    | Open registration page + accept cookies                |
| 4    | Region auto-detected                                   |
| 5    | Fill email, password, confirm password, agree checkbox |
| 6    | Submit form + captcha (manual/auto)                    |
| 7    | Wait for OTP email → auto-extract → auto-fill        |
| 8    | Terms & agreements (checklist + confirm)               |
| 9    | Redirect to console + accept cookies                   |
| 10   | Navigate to API Keys → Create API Key                 |
| 11   | Extract API key → save to `data/xiaomi.csv`                |

### Alibaba Cloud (9 steps)

| Step | Description                                                        |
| ---- | ------------------------------------------------------------------ |
| 1/9  | Launch Chromium (stealth + anti-fingerprint: WebGL, Canvas, Audio) |
| 2/9  | Generate temporary email via Supabase                              |
| 3/9  | Navigate to account.alibabacloud.com                               |
| 4/9  | Select "Individual Account" (inside iframe)                        |
| 5/9  | Click "Next"                                                       |
| 6/9  | Fill email, password, confirm password (char-by-char typing)       |
| 7/9  | Click "Sign Up" → solve Baxia slider captcha (auto/manual)        |
| 8/9  | Select email tab → click "Send" → wait OTP → fill `#emailCaptcha` |
| 9/9  | Check "I agree" → Sign Up → open Model Studio in new tab → create API key → save to `data/alibaba.csv` |

**Notes:**
- Registration form is inside `#alibaba-register-box` iframe
- After Sign Up Step 1, Baxia slider captcha appears (auto-slided)
- After OTP, captcha may appear again (waits for manual solve)
- Verification form is in `passport.alibabacloud.com` frame
- API key is in `.keyText__qJgAI` div

### Qoder (9 steps per loop)

| Step | Description                                                |
| ---- | ---------------------------------------------------------- |
| 1/9  | Navigate to platform → login (first time only)            |
| 2/9  | Navigate to Qoder provider page                            |
| 3/9  | Click "Add" → opens new tab                               |
| 4/9  | OAuth: Sign in with another account → Sign up             |
| 5/9  | Create temp email + generate random name                   |
| 6/9  | Fill form (First Name, Last Name, Email, Terms) + Continue |
| 7/9  | Enter password + Continue                                  |
| 8/9  | Click to verify → captcha (auto puzzle solver / manual)   |
| 9/9  | Wait OTP email → auto-fill (Ant Design OTP component)     |

After each loop, the OAuth tab stays open and the dashboard navigates back to Qoder page for the next registration.

## Output

### Xiaomi MiMo

```csv
timestamp,email,password,api_key_name,api_key
"2026-06-19T12:00:00.000Z","user_xxx@domain.com","***","auto-xxx","sk-xxxxxxxxxxxxxxxxx"
```

### Alibaba Cloud

```csv
timestamp,email,password,api_key
"2026-06-19T12:00:00.000Z","user_xxx@moymoy.me","***","sk-xxxxxxxxxxxxxxxxx"
```

### Qoder

```csv
timestamp,platform,first_name,last_name,email,password,status
"2026-06-19T12:00:00.000Z","qoder","John","Smith","user_xxx@moymoy.me","***","registered"
```

## File Structure

| Path | Description |
| ---- | ----------- |
| `registrars/` | Main account registration bots (`register_*.js`) |
| `importers/` | Key/account import flows (`import_*.js`) |
| `runners/` | Loop and parallel execution wrappers |
| `services/tempmail/` | Temp email clients and webhook service |
| `steps/` | Modular Qoder/Xiaomi flow steps |
| `utils/` | Shared browser, captcha, env, and helper utilities |
| `tools/` | One-off utilities, captcha demos, extraction/regeneration tools |
| `integrations/` | Larger side projects/extensions/crawlers kept separate from core bots |
| `data/` | Local CSV outputs and input lists (gitignored) |
| `scratch/` | Minimal tracked scratch helpers; generated experiments are archived/ignored |
| `docker/` | Docker assets shared by the project |
| `scripts/` | Install, cleanup, browser, tunnel, and maintenance scripts |

### Integrations

| Path | Context |
| ---- | ------- |
| `integrations/social-media-crawler/` | JavaScript social media crawler prototype |
| `integrations/social-media-crawler-golang/` | Go social media crawler service/tools |
| `integrations/resource-override-extension/` | Browser resource override extension |
| `integrations/bikinbot-ai/` | Separate BikinBot registration project |
| `integrations/gemini-pixel/` | Gemini/Pixel automation project |
| `integrations/qoder-autopilot/` | Qoder autopilot Python/Node helper project |
| `integrations/claude-sepa-helper-v1.0.8-protected/` | Claude SEPA helper extension/build |
| `integrations/extension-cloude/` | Related Claude extension assets |
| `integrations/rootAVD/` | Android emulator/rooting assets |

## Notes

- Import `data/keys.csv` to OmniRoute with validation and duplicate-name skipping: `npm run omniroute:import`. Defaults target `http://localhost:20128` provider `openai-compatible-chat-3ab61b5f-89e2-4749-ac20-e936b69f223f`; override with `OMNIROUTE_URL`, `OMNIROUTE_PASSWORD`, `OMNIROUTE_PROVIDER_ID`, `OMNIROUTE_PROVIDER_BASE_URL`, or CLI flags like `--csv=data/keys-test.csv --no-validate`.
- Import `data/keys.csv` to 9Router with the same flow: `npm run 9router:import`. Defaults target `http://localhost:20131` provider `openai-compatible-chat-85aa70e1-5cdc-462c-b1e0-69531b0320d1`; override with `NINE_ROUTER_URL`, `NINE_ROUTER_PASSWORD`, `NINE_ROUTER_PROVIDER_ID`, `NINE_ROUTER_PROVIDER_BASE_URL`, or CLI flags like `--csv=data/keys-test.csv --no-validate`.
- Docker tempmail: local Mailpit mode uses `TEMPMAIL_PROVIDER=mailpit`; Cloudflare Email Routing mode uses `TEMPMAIL_PROVIDER=webhook`, `TEMPMAIL_WEBHOOK_DOMAIN=your-domain.com`, and Worker POSTs email JSON to `/inbound` on the local webhook service.
- Xiaomi: captcha must be solved manually (browser opens in visible mode) unless `LLM_API_KEY` is set (LLM Vision ImageToText OCR for custom captcha)
- Alibaba: Baxia slider captcha auto-slided; second captcha after OTP waits for manual solve
- Alibaba: form is nested in `#alibaba-register-box` iframe → `passport.alibabacloud.com` frame
- Alibaba: use residential proxy — datacenter IPs are flagged by Alibaba
- Qoder: Aliyun slider captcha is not supported automatically via LLM, falls back to manual
- Qoder: OTP uses Ant Design component (`input.ant-otp-input`, `size="1"`)
- Qoder: Aliyun captcha (`#aliyunCaptcha-*`) — puzzle slider type
- If selectors don't match, update them in the respective script
- Supabase anon key in `services/tempmail/tempmail.js` is public

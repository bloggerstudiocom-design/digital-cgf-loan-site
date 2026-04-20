# DIGITAL CGF CUSTOMER GROWTH FUND

Professional fintech-style loan facilitation website for an Indian financial consulting company. This implementation includes:

- Google Gmail sign-in only for borrower access
- Auto-saved multi-step loan application with resume support
- Dynamic eligibility engine
- Camera-only selfie verification
- Reference-number-based application tracking
- Secure admin dashboard with live status updates
- Encrypted borrower data storage
- Footer legal, company, partner-lender, and privacy content

## Run locally

1. Copy `.env.example` to `.env` and fill in the values.
2. Start the server with the bundled Node runtime:

```powershell
& "C:\Users\anony\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.mjs
```

3. Open `http://localhost:3000`.

## Important setup notes

- Borrower login uses Google Identity Services. You must provide a valid `GOOGLE_CLIENT_ID`.
- Admin login uses credentials from environment variables. Change the defaults before deployment.
- `DATA_ENCRYPTION_KEY` should be a 64-character hexadecimal string for AES-256-GCM encryption.
- This project is HTTPS-ready but local development uses HTTP unless you place it behind TLS.
- The persistence layer is intentionally modular so it can later be replaced with a database and external API integrations.

## Future integrations

The backend is organized to support future additions such as:

- CIBIL API integration
- Payment gateway integration
- Bank verification APIs
- Digital KYC providers

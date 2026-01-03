# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.0.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please send an email to security@your-domain.com.

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will respond within 48 hours and work with you to resolve the issue.

## Security Best Practices

1. Never commit `.env` files with real credentials
2. Use environment variables for all sensitive configuration
3. Keep dependencies up to date
4. Review security advisories regularly
5. Use HTTPS in production
6. Implement rate limiting (already configured)
7. Validate all user inputs (already implemented with Zod)

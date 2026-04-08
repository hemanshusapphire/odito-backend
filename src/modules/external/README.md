# External Onboarding Module

This module provides a minimal external onboarding endpoint that allows external websites to onboard users using only an email address.

## Endpoint

### POST /external/onboard

Accepts email-only requests for external onboarding without requiring authentication.

**Request Body:**
```json
{
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "message": "External onboarding completed successfully",
  "data": {
    "userId": "64f8a1b2c3d4e5f6a7b8c9d0",
    "projectId": "64f8a1b2c3d4e5f6a7b8c9d1",
    "jobId": "64f8a1b2c3d4e5f6a7b8c9d2",
    "status": "onboarded",
    "message": "External onboarding completed successfully"
  }
}
```

## Flow

1. **User Processing**: Finds existing user or creates new one with:
   - Email as primary identifier
   - Auto-generated name from email domain
   - `source: "external"` flag
   - Auto-verified email status
   - Placeholder password

2. **Project Creation**: Creates project with default values:
   - Project name: "External Project - {domain}"
   - Default URL: `https://www.{domain}`
   - Business: "Unknown Business"
   - Location: "India"
   - Keywords: [domain]
   - `source: "external"` flag

3. **Job Pipeline**: Creates and dispatches `LINK_DISCOVERY` job:
   - Uses existing job creation system
   - Dispatches to Python worker via JobDispatcher
   - Triggers full pipeline automatically

## Features

- **No Authentication**: Public endpoint (ready for API key later)
- **Idempotent**: Safe to call multiple times with same email
- **Minimal Changes**: Doesn't modify existing onboarding flow
- **Production Safe**: Uses existing job system and validation
- **Source Tracking**: All created entities marked as `source: "external"`

## Files Structure

```
src/modules/external/
├── routes/
│   └── externalRoutes.js      # Route definition
├── controller/
│   └── externalController.js  # Request handling
├── service/
│   └── externalService.js     # Business logic
└── README.md                  # This documentation
```

## Integration Points

- **User Model**: Added `source` field for tracking
- **SeoProject Model**: Added `source` field for tracking
- **Main Router**: Added `/external` route prefix
- **Job System**: Uses existing `LINK_DISCOVERY` pipeline

## Usage

```bash
curl -X POST https://your-domain.com/api/external/onboard \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'
```

## Security Notes

- Currently open endpoint (add API key authentication for production)
- Input validation for email format
- Rate limiting recommended for production use
- Auto-verifies emails (consider verification flow for production)

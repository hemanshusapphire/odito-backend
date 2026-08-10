import jwt from 'jsonwebtoken';

/**
 * Signed, short-lived state token for the Google "google_visibility" OAuth
 * flow. Carries { purpose, projectId, userId } so the callback never has to
 * trust client-suppliable query params for access control - a tampered or
 * expired token fails verification outright.
 */
const STATE_TOKEN_TTL = '10m';

export function signGoogleVisibilityState(payload, secret = process.env.JWT_SECRET) {
  return jwt.sign(payload, secret, { expiresIn: STATE_TOKEN_TTL });
}

export function verifyGoogleVisibilityState(state, secret = process.env.JWT_SECRET) {
  return jwt.verify(state, secret);
}

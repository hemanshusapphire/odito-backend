<?php
/**
 * Odito_Divi_Capture
 *
 * Server-side Divi contact form submission capture — the Divi counterpart
 * to class-odito-cf7-capture.php. Structure-only detection
 * (Odito_Forms::detect_divi()) already existed; this adds real submitted
 * VALUES, mirroring the CF7 capture module's shape and safety guarantees
 * as closely as Divi's own architecture allows.
 *
 * ============================================================================
 * HOOK VERIFICATION STATUS — READ BEFORE DEPLOYING TO A REAL DIVI SITE
 * ============================================================================
 * Contact Form 7 exposes a documented, stable, purpose-built extension
 * point (`wpcf7_before_send_mail`) specifically designed for exactly this
 * kind of observer. Divi (Elegant Themes' commercial Divi Builder) does
 * not ship anywhere in this project or in any environment this code was
 * developed against — it is a licensed product with no public source
 * available here, so nothing below could be confirmed against Divi's
 * actual, current implementation.
 *
 * `wp_ajax_et_pb_submit_form` / `wp_ajax_nopriv_et_pb_submit_form` is the
 * best-documented candidate for Divi's contact-form AJAX action name
 * (consistently referenced across the WordPress developer community for
 * many years), and the `et_pb_contact_<field>_<index>` $_POST key pattern
 * is the best-documented candidate for how Divi names submitted fields.
 * Neither has been verified against a real, live Divi installation.
 *
 * This is why the design below is deliberately defensive rather than
 * assuming either guess is correct:
 *   - Registered at an EARLY priority (5, before Divi's likely default of
 *     10) specifically because if Divi's own AJAX handler ends the request
 *     (wp_die()/exit, standard for an AJAX action), any callback at a
 *     LATER priority on the same hook would simply never run — there is
 *     no way to reliably run "after" Divi from the same action. Running
 *     first, and touching nothing but $_POST (read-only) and never
 *     terminating the request ourselves, is the only way to guarantee
 *     this can't interfere with Divi's own processing regardless of what
 *     Divi does after us.
 *   - Field extraction requires at least one $_POST key to match the
 *     expected pattern before doing anything — if the hook name or field
 *     pattern guess is wrong, this fails CLOSED (logs a diagnostic notice,
 *     sends nothing) rather than fabricating a payload from unrelated POST
 *     data.
 *
 * See odito-wordpress-plugin/DIVI_HOOK_VERIFICATION.md for the exact,
 * safe, two-minute procedure to confirm or correct both guesses against
 * the real Sapphire site before this is relied on in production.
 * ============================================================================
 *
 * Same pure-observer guarantee as CF7 capture: never throws out of this
 * file, never touches $_POST, never calls wp_die()/exit()/wp_send_json()
 * — if Odito is unreachable, slow, or wrong about the hook entirely, the
 * customer's Divi form submission, email, and redirect are completely
 * unaffected either way.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Odito_Divi_Capture {

	/** Deliberately earlier than Divi's likely default (10) — see file header. */
	const HOOK_PRIORITY = 5;

	/**
	 * Divi's own submission field-key convention (best-documented
	 * candidate, unverified — see file header): et_pb_contact_<slug>_<n>.
	 */
	const FIELD_KEY_PATTERN = '/^et_pb_contact_(.+)_(\d+)$/';

	/** Short window for the duplicate-submission guard — see maybe_reject_duplicate(). */
	const DUPLICATE_GUARD_SECONDS = 60;

	public static function init() {
		add_action( 'wp_ajax_et_pb_submit_form', array( __CLASS__, 'capture' ), self::HOOK_PRIORITY );
		add_action( 'wp_ajax_nopriv_et_pb_submit_form', array( __CLASS__, 'capture' ), self::HOOK_PRIORITY );
	}

	public static function capture() {
		try {
			self::capture_internal();
		} catch ( \Throwable $e ) {
			// Defensive catch-all: whatever went wrong in OUR code must
			// never propagate into Divi's own AJAX response.
			self::log( 'error', 'unhandled exception during capture: ' . $e->getMessage() );
		}
	}

	private static function capture_internal() {
		if ( ! Odito_Connection::is_connected() ) {
			return;
		}

		self::log( 'info', 'submission detected' );

		$raw_fields = self::extract_raw_fields( $_POST ); // phpcs:ignore WordPress.Security.NonceVerification.Missing -- pure observer, never trusts this data for anything but forwarding to Odito's own authenticated API; no WordPress state is read or written from it.
		if ( empty( $raw_fields ) ) {
			self::log( 'warning', 'no et_pb_contact_* fields found in POST data — hook fired but the field-key pattern did not match; see DIVI_HOOK_VERIFICATION.md' );
			return;
		}

		$post_id = self::resolve_submitting_post_id();
		if ( ! $post_id ) {
			self::log( 'warning', 'could not resolve the submitting page from the referrer — aborting, nothing safe to match against' );
			return;
		}

		$form = self::resolve_form( $post_id, $raw_fields );
		if ( ! $form ) {
			self::log( 'warning', 'no synced Divi form found on post ' . (int) $post_id . ' to match this submission against' );
			return;
		}

		self::log( 'info', 'form resolved: ' . $form['externalId'] );

		$fields = self::filter_and_map_fields( $raw_fields, $form );
		if ( empty( $fields ) ) {
			self::log( 'warning', 'all submitted fields were filtered out (sensitive or empty) — nothing to send' );
			return;
		}

		self::log( 'info', 'fields extracted (' . count( $fields ) . ' non-sensitive field(s)): ' . implode( ', ', array_keys( $fields ) ) );

		if ( self::is_probable_duplicate( $form['externalId'], $fields ) ) {
			self::log( 'info', 'skipped — identical submission to this form seen in the last ' . self::DUPLICATE_GUARD_SECONDS . 's' );
			return;
		}

		$page_url = get_permalink( $post_id );
		if ( empty( $page_url ) ) {
			$page_url = home_url();
		}

		$payload = array(
			'eventId' => wp_generate_uuid4(),
			'form'    => array(
				'externalId' => $form['externalId'],
				'provider'   => 'divi',
				'name'       => $form['name'],
				'pageUrl'    => $page_url,
			),
			'submission' => array(
				'fields' => $fields,
			),
			'context' => array(
				'pageUrl'  => $page_url,
				'referrer' => wp_get_referer() ? wp_get_referer() : null,
			),
		);

		self::log( 'info', 'submission queued for delivery, eventId=' . $payload['eventId'] );

		$result = Odito_Submission_Dispatcher::dispatch( $payload );

		if ( $result['success'] ) {
			self::log( 'info', 'API request successful' );
		} else {
			self::log( 'warning', 'API request failed, status=' . ( null !== $result['status'] ? $result['status'] : 'network_error' ) );
		}
	}

	// ── Field extraction ─────────────────────────────────────────────────

	/**
	 * Returns [ field_slug => raw_value ] for every $_POST key matching
	 * Divi's contact-field convention (see FIELD_KEY_PATTERN), stripping
	 * WordPress/Divi's own control fields (action, nonces, unit tags — none
	 * of which match the field pattern anyway, so no separate exclude list
	 * is needed the way CF7's underscore-prefix convention requires).
	 */
	private static function extract_raw_fields( $post_data ) {
		$fields = array();
		foreach ( $post_data as $key => $value ) {
			if ( ! preg_match( self::FIELD_KEY_PATTERN, $key, $matches ) ) {
				continue;
			}
			$slug = $matches[1];
			if ( is_array( $value ) ) {
				$value = implode( ', ', array_map( 'strval', $value ) );
			}
			$value = is_scalar( $value ) ? trim( wp_unslash( (string) $value ) ) : '';
			if ( '' === $value ) {
				continue;
			}
			$fields[ $slug ] = $value;
		}
		return $fields;
	}

	/** Referrer -> post ID via WordPress core's own resolver (real, stable API — not a guess). */
	private static function resolve_submitting_post_id() {
		$referer = wp_get_referer();
		if ( ! $referer ) {
			return 0;
		}
		return (int) url_to_postid( $referer );
	}

	/**
	 * Matches the submission to one of the Divi forms Odito_Forms already
	 * knows about on this page (the exact same parsing sync uses — see
	 * class-odito-forms.php::find_divi_forms_in_post()), not a second,
	 * separately-maintained form-identity system.
	 *
	 * The common case (one Divi contact form per page, true for both
	 * "Become a Partner" and "Contact Us" per the current Sapphire sync)
	 * is unambiguous. If a page ever has more than one, this disambiguates
	 * by how many of the submitted field slugs overlap with each
	 * candidate's known fields, falling back to the first form on the page
	 * if that still doesn't distinguish them.
	 */
	private static function resolve_form( $post_id, $raw_fields ) {
		$candidates = Odito_Forms::find_divi_forms_in_post( $post_id );
		if ( empty( $candidates ) ) {
			return null;
		}
		if ( 1 === count( $candidates ) ) {
			return $candidates[0];
		}

		$submitted_slugs = array_map( array( __CLASS__, 'slugify' ), array_keys( $raw_fields ) );

		$best_index = 0;
		$best_score = -1;
		foreach ( $candidates as $index => $candidate ) {
			$score = 0;
			foreach ( $candidate['fields'] as $field ) {
				$candidate_slug = self::slugify( ! empty( $field['raw_field_id'] ) ? $field['raw_field_id'] : $field['name'] );
				if ( in_array( $candidate_slug, $submitted_slugs, true ) ) {
					++$score;
				}
			}
			if ( $score > $best_score ) {
				$best_score = $score;
				$best_index = $index;
			}
		}

		return $candidates[ $best_index ];
	}

	private static function slugify( $value ) {
		$value = strtolower( trim( (string) $value ) );
		return preg_replace( '/[^a-z0-9]+/', '_', $value );
	}

	/**
	 * Maps each raw submitted field to its known human-readable name (from
	 * the matched form's synced field list) where possible — falling back
	 * to the raw slug for anything not present in that list (a field added
	 * to the live form since the last sync), so a submission is never
	 * silently dropped just because "Sync Now" hasn't run recently.
	 *
	 * Sent keyed by the human-readable name (e.g. "Agency Name", not
	 * "agency_name") — matching the same convention CF7 capture uses
	 * (raw field name as the payload key) and what the backend's own
	 * field-candidate resolver (wordPressSubmissionNormalizer.js) expects.
	 *
	 * Sensitive-field filtering reuses Odito_Security::is_sensitive_field()
	 * — the exact same check CF7 capture and form-structure sync both use;
	 * no second, divergent sensitive-field implementation for Divi.
	 */
	private static function filter_and_map_fields( $raw_fields, $form ) {
		$known_by_slug = array();
		foreach ( $form['fields'] as $field ) {
			$candidate_slug = self::slugify( ! empty( $field['raw_field_id'] ) ? $field['raw_field_id'] : $field['name'] );
			$known_by_slug[ $candidate_slug ] = $field['name'];
		}

		$fields = array();
		foreach ( $raw_fields as $slug => $value ) {
			$label = isset( $known_by_slug[ self::slugify( $slug ) ] ) ? $known_by_slug[ self::slugify( $slug ) ] : $slug;

			if ( Odito_Security::is_sensitive_field( $label ) || Odito_Security::is_sensitive_field( $slug ) ) {
				continue;
			}

			$fields[ $label ] = $value;
		}

		return $fields;
	}

	// ── Duplicate protection ─────────────────────────────────────────────

	/**
	 * A short-TTL WordPress transient keyed by a hash of (form + the exact
	 * non-sensitive field values already filtered above) — NOT a global or
	 * static in-process flag (Phase 7 explicitly rules that out, and a
	 * static wouldn't even help here: a real double-click or client-side
	 * AJAX retry is a genuinely separate PHP request/process, not a
	 * second call within the same one).
	 *
	 * Content-keyed rather than session/user-keyed on purpose: two
	 * DIFFERENT visitors submitting the same form with different answers
	 * never collide (different hash); the SAME visitor submitting the same
	 * form again minutes later is allowed once the transient expires. Only
	 * an exact repeat of the same values to the same form within the same
	 * short window is treated as a probable duplicate (a double-click or a
	 * timed-out AJAX call retried by the browser).
	 */
	private static function is_probable_duplicate( $external_id, $fields ) {
		$key = 'odito_divi_dup_' . md5( $external_id . '|' . wp_json_encode( $fields ) );
		if ( false !== get_transient( $key ) ) {
			return true;
		}
		set_transient( $key, 1, self::DUPLICATE_GUARD_SECONDS );
		return false;
	}

	// ── Logging ───────────────────────────────────────────────────────────

	/**
	 * [DIVI_CAPTURE] structured, PII-free debug logging — gated behind
	 * WP_DEBUG (this plugin had no prior logging convention to follow; CF7
	 * capture's own failures are currently silent by design, and this adds
	 * logging only for the new Divi path, not retrofitted onto CF7).
	 * Never logs field VALUES, only field NAMES/counts/ids/status codes.
	 */
	private static function log( $level, $message ) {
		if ( ! defined( 'WP_DEBUG' ) || ! WP_DEBUG ) {
			return;
		}
		error_log( sprintf( '[DIVI_CAPTURE] [%s] %s', strtoupper( $level ), $message ) );
	}
}

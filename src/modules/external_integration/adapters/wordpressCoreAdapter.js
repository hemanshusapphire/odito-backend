import wordPressService, { WordPressConnectionError } from '../service/wordPressService.js';
import { SeoProviderAdapter } from './seoProviderAdapter.js';

/**
 * WordPressCoreAdapter — the always-available fallback. Used when no SEO
 * plugin is detected ('none'), when multiple are detected and ambiguity
 * hasn't been resolved ('multiple'), and as the source of truth for the two
 * fields (slug, image alt text) that are core WordPress concepts regardless
 * of which SEO plugin, if any, is active.
 *
 * `title` here is the post's own title (`post_title`) — when no SEO plugin
 * overrides it, this genuinely is what most themes render into the page's
 * `<title>` tag, so it's a real, correct write target for the 'none'
 * provider case. It is NOT offered as a title fix when an SEO plugin IS
 * active (see rankMathAdapter.js/yoastAdapter.js, whose own capability
 * tables report title write:false rather than silently delegating to this
 * adapter) — writing post_title while Rank Math/Yoast override the
 * rendered `<title>` would change something the user can see in wp-admin
 * without changing what a browser or crawler actually sees, which is worse
 * than doing nothing.
 */
export class WordPressCoreAdapter extends SeoProviderAdapter {
  static get providerName() {
    return 'none';
  }

  getCapabilities() {
    return {
      title: { read: true, write: true },
      metaDescription: { read: false, write: false },
      canonical: { read: false, write: false },
      robots: { read: false, write: false },
      openGraph: { read: false, write: false },
      schema: { read: false, write: false },
      // Bug fix (production-readiness audit): writeSlug()/writeAltText()
      // below are real, working, unit-tested methods — but capability must
      // mean "can currently be safely written AND subsequently verified by
      // the existing Task verification architecture" (the locked
      // architecture's own definition), not merely "an adapter method
      // exists." issueSnapshotTypes.js has no 'slug' snapshot type at all
      // (TaskVerificationService could never confirm a slug change), and
      // image_alt has no unambiguous image-target wiring yet in
      // wordPressSeoFixService.js (see its own docblock). Reporting
      // write:true here would let a future API/UI consumer reasonably
      // assume Odito's Task-based apply flow supports these fields, when it
      // does not. Flip to true only once both are wired end-to-end
      // (a separate phase, per the locked architecture).
      slug: { read: true, write: false },
      altText: { read: true, write: false },
    };
  }

  async getSeoData(pageUrl) {
    const resolved = await wordPressService.resolvePostIdFromUrl(this.connection, pageUrl);
    if (!resolved) return null;

    const { data: post } = await wordPressService.wpRequest(this.connection, {
      method: 'GET',
      // context=edit requests the unrendered `raw` variant of title/content —
      // safe here because every outbound call already authenticates as the
      // connected Application Password user, who by definition can edit
      // this content (the same account resolvePostIdFromUrl's read just used).
      path: `/wp-json/wp/v2/${resolved.postType}/${resolved.postId}?context=edit&_fields=id,link,title,slug`,
    });

    return {
      pageId: resolved.postId,
      postType: resolved.postType,
      url: post.link || pageUrl,
      seo: {
        title: post.title?.raw ?? post.title?.rendered ?? null,
        metaDescription: null,
        canonical: null,
        robots: null,
        openGraph: { title: null, description: null, image: null },
        schema: null,
      },
      provider: { name: 'none', version: null },
    };
  }

  /**
   * Writes the post's core title. Read-before-write is enforced by the
   * caller (wordPressSeoFixService.js), not here — this adapter only knows
   * how to perform the write once approved.
   */
  async writeTitle(pageUrl, newTitle) {
    const resolved = await wordPressService.resolvePostIdFromUrl(this.connection, pageUrl);
    if (!resolved) {
      throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'Could not resolve this URL to a WordPress post or page.', 422);
    }
    const { status } = await wordPressService.wpRequest(this.connection, {
      method: 'PUT',
      path: `/wp-json/wp/v2/${resolved.postType}/${resolved.postId}`,
      data: { title: newTitle },
    });
    return { httpStatus: status, wordpressPostId: resolved.postId };
  }

  async writeSlug(pageUrl, newSlug) {
    const resolved = await wordPressService.resolvePostIdFromUrl(this.connection, pageUrl);
    if (!resolved) {
      throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'Could not resolve this URL to a WordPress post or page.', 422);
    }
    const { status } = await wordPressService.wpRequest(this.connection, {
      method: 'PUT',
      path: `/wp-json/wp/v2/${resolved.postType}/${resolved.postId}`,
      data: { slug: newSlug },
    });
    return { httpStatus: status, wordpressPostId: resolved.postId };
  }

  /**
   * Alt text is attached to a media attachment, not the page/post itself —
   * `imageSrc` (the exact `src` seo_page_data recorded for this image, per
   * TaskHistoryService's image_alt snapshot shape) is resolved to a media
   * ID by filename search, then confirmed by exact `source_url` match, the
   * same "search then confirm the exact match" shape resolvePostIdFromUrl
   * uses for posts/pages.
   */
  async writeAltText(imageSrc, newAlt) {
    let filename;
    try {
      filename = new URL(imageSrc).pathname.split('/').filter(Boolean).pop();
    } catch {
      throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'This image URL could not be resolved to a WordPress media item.', 422);
    }
    if (!filename) {
      throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'This image URL could not be resolved to a WordPress media item.', 422);
    }

    const { data } = await wordPressService.wpRequest(this.connection, {
      method: 'GET',
      path: `/wp-json/wp/v2/media?search=${encodeURIComponent(filename)}&_fields=id,source_url`,
    });
    const match = Array.isArray(data) ? data.find((item) => item.source_url === imageSrc) : null;
    if (!match) {
      throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'This image could not be found in the WordPress media library.', 422);
    }

    const { status } = await wordPressService.wpRequest(this.connection, {
      method: 'PUT',
      path: `/wp-json/wp/v2/media/${match.id}`,
      data: { alt_text: newAlt },
    });
    return { httpStatus: status, wordpressPostId: match.id };
  }
}

export default WordPressCoreAdapter;

/*
 * Runtime configuration for the chatbot web UI.
 *
 * This file is served as a plain static asset and is NOT bundled, so it can be
 * edited after the build without rebuilding anything: change the value below,
 * save, reload the page (a hard refresh may be needed if the service worker or
 * the browser cached the old file).
 *
 * DSH_API_ORIGIN — where the OpenAI-compatible API lives.
 *   • '' (empty)            → same-origin: the web server also proxies /v1,
 *                              /props, /models, ... to the backend.
 *   • 'http://host:port'    → all API calls go to that origin.
 *   • 'http://host:port/v1' → full OpenAI-style base URL; the /v1 suffix is
 *                              accepted and stripped internally.
 *
 * The value may also be baked into the bundle at build time with the
 * VITE_PUBLIC_API_ORIGIN environment variable; this runtime file wins.
 */
window.DSH_API_ORIGIN = window.DSH_API_ORIGIN || '';

// The only route handler here, and it exists so the sitemap condition can be wrong in a way a test
// notices: it serves a URL, and a sitemap does not list it. Without it every URL this project
// answers on is a page, and a reading that counted endpoints would report the same figure as one
// that did not.
export function GET() {
  return Response.json({ ok: true });
}

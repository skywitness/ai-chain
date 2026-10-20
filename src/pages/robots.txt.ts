// /robots.txt, generated so the Sitemap line follows SITE_URL (Astro.site) and BASE_PATH.
// Replaces the former static public/robots.txt. Owner: pages-reference agent.
import type { APIRoute } from 'astro';
import { absoluteUrl, withBase } from '../lib/paths';

export const prerender = true;

export const GET: APIRoute = ({ site }) => {
  const lines = [
    '# AI 產業鏈全景',
    'User-agent: *',
    `Allow: ${withBase('/')}`,
    `Disallow: ${withBase('/dev/')}`,
    '',
    `Sitemap: ${absoluteUrl('/sitemap-index.xml', site)}`,
    '',
  ];
  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};

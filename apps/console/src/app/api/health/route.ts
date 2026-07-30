export function GET() {
  return Response.json({ service: 'torqclaw-console', status: 'ready' });
}

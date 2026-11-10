import { index, route, type RouteConfig } from '@react-router/dev/routes';

export default [
  index('routes/index.tsx'),
  // Your home inside the admin, and every page under it.
  route('app/*', 'routes/app.tsx'),
  route('webhooks', 'routes/webhooks.ts'),
  route('privacy', 'routes/privacy.ts'),
] satisfies RouteConfig;

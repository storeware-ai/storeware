import type { Config } from '@react-router/dev/config';

// Rendered on the server, so the session the admin opens your home with is
// proved before any of the shop's data is read.
export default { ssr: true } satisfies Config;

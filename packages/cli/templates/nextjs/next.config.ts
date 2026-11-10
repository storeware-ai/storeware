import type { NextConfig } from 'next';

const config: NextConfig = {
  // `storeware app dev` serves this through a tunnel whose address changes
  // every run, and Next refuses its own development files to another origin.
  allowedDevOrigins: ['*.trycloudflare.com'],
};

export default config;

/** @type {import('next').NextConfig} */
const config = {
  poweredByHeader: false,
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};
export default config;
